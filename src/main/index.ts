import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  WebContentsView,
  type Input,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setAdblock } from './adblock'
import {
  backendName,
  listChatModels,
  runChat,
  setChatUserAgent,
  ToolsUnsupportedError,
  verifyChatConfig,
  type ChatMessage
} from './chat'
import {
  addSearch,
  addVisit,
  clearHistory,
  flushHistory,
  getHistory,
  removeSearch,
  removeVisit,
  suggestFromHistory,
  updateVisitTitle
} from './history'
import { getNotices, openChromiumNotices } from './licenses'
import { initLogging, logRendererError, logsDir } from './log'
import { getProvider, verticalSearch, type ProviderId, type Vertical } from './providers'
import { buildMessages, sourcesFor, startResearch, type ChatSource } from './research'
import {
  checkRendererCsp,
  hardenApp,
  hardenSessions,
  isWebUrl,
  openExternal,
  secureWebPreferences,
  setAppMenu
} from './security'
import {
  clearChatConfig,
  clearCredentials,
  clearSuggestKey,
  getActiveProvider,
  getAdblock,
  getAutoUpdate,
  getChatConfig,
  getCredentials,
  getStatus,
  getSuggestKey,
  resolveChatConfig,
  resolveChatListConfig,
  saveChatConfig,
  saveCredentials,
  saveSuggestKey,
  setActiveChat,
  setActiveProvider,
  setAdblock as saveAdblockSetting,
  setAutoUpdate,
  setChatGrounded,
  setSidebarOpen,
  type ChatForm
} from './settings'
import { braveSuggest } from './suggest'
import {
  cleanContext,
  deleteThread,
  flushThreads,
  getThread,
  listThreads,
  renameThread,
  saveThread,
  type ChatBackend
} from './threads'
import {
  cancelDownload,
  checkForUpdates,
  downloadUpdate,
  getUpdateStatus,
  installUpdate,
  rescheduleUpdates,
  startUpdater
} from './updater'

initLogging()
hardenApp()

// One Zook at a time: a second launch focuses the running window instead, and the stores
// (which assume a single writer) are never written by two processes at once.
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()

// Chromium only picks a keyring on desktops it recognizes (GNOME, KDE, ...). On others,
// such as Hyprland, it falls back to plain text even when a Secret Service like
// gnome-keyring is running, so ask for libsecret explicitly.
if (
  process.platform === 'linux' &&
  !app.commandLine.hasSwitch('password-store') &&
  !/gnome|kde|unity|cinnamon|xfce|deepin|ukui/i.test(process.env.XDG_CURRENT_DESKTOP ?? '')
) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
}

try {
  process.loadEnvFile(join(app.getAppPath(), '.env'))
} catch {
  // no .env file; rely on the real environment
}

export type PageState = {
  // Which popup this is, as the renderer numbered it.
  id: number
  url: string
  title: string
  loading: boolean
  blocked: number
  favicon?: string
}

export type Shortcut = 'focus-address' | 'history'

type Bounds = { x: number; y: number; width: number; height: number }
type Page = { view: WebContentsView; blocked: number; favicon?: string }

// Web pages get their own session so ad blocking and site data stay apart from the app UI.
const WEB_PARTITION = 'persist:web'

let win: BrowserWindow | null = null
// The web pages in the stack of popups, by the id the renderer gave each. Only the top one is shown;
// the renderer draws the ones beneath from screenshots.
const pages = new Map<number, Page>()
let shownPage: number | null = null
let viewBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 }

// Throws before any request is made when no search provider is set up.
function activeSearch(vertical: Vertical) {
  const id = getActiveProvider()
  const provider = getProvider(id)
  const creds = getCredentials(id)
  if (!creds) throw new Error(`No API key set for ${provider.name}. Add one in Settings.`)
  const fn = verticalSearch(provider, vertical)
  return (query: string, page: number) => fn(creds, query, page)
}

async function search(vertical: Vertical, query: string, page: number) {
  const response = await activeSearch(vertical)(query, page)
  if (page === 0) addSearch(query)
  return response
}

const chats = new Map<string, AbortController>()

export type { ChatSource }

function sanitizeMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return []
  return messages
    .filter(
      (m): m is ChatMessage =>
        (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim() !== ''
    )
    .map((m) => ({ role: m.role, content: m.content }))
}

function pageIdOf(wc: WebContents): number | undefined {
  for (const [id, page] of pages) if (page.view.webContents === wc) return id
}

function sendPageState(id: number) {
  const page = pages.get(id)
  if (!win || !page) return
  const wc = page.view.webContents
  const state: PageState = {
    id,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    blocked: page.blocked,
    favicon: page.favicon
  }
  win.webContents.send('page:state', state)
}

// Blocked-request counts change fast, so their updates are batched.
const pendingBlockedUpdates = new Set<number>()
function onRequestBlocked(webContentsId: number) {
  for (const [id, page] of pages) {
    if (page.view.webContents.id !== webContentsId) continue
    page.blocked++
    if (pendingBlockedUpdates.size === 0) {
      setTimeout(() => {
        for (const pending of pendingBlockedUpdates) sendPageState(pending)
        pendingBlockedUpdates.clear()
      }, 250)
    }
    pendingBlockedUpdates.add(id)
  }
}

// A link followed in a popup (from the page preload, or a page opening a new window) becomes
// another popup on top, which the renderer decides on.
function openLink(from: number, url: string) {
  if (/^https?:/i.test(url)) win?.webContents.send('page:link', { from, url })
}

function shortcutFor(input: Input): Shortcut | null {
  if (input.type !== 'keyDown') return null
  const ctrl = input.control || input.meta
  const key = input.key.toLowerCase()
  if (ctrl && key === 'l') return 'focus-address'
  if (ctrl && key === 'h') return 'history'
  return null
}

// Shortcuts are caught in the main process so they work whether the app UI or a page has focus.
function forwardShortcuts(wc: WebContents) {
  wc.on('before-input-event', (event, input) => {
    // Ctrl+W and Ctrl+R are browser shortcuts (close, reload) that must never reach the app UI or a page.
    if ((input.control || input.meta) && /^[wr]$/i.test(input.key) && input.type === 'keyDown') {
      event.preventDefault()
      return
    }
    const shortcut = shortcutFor(input)
    if (!shortcut || !win) return
    event.preventDefault()
    win.webContents.send('shortcut', shortcut)
  })
}

// Only editing actions, plus (in web pages) what to do with a link or selected text. No browser
// items such as Back, Reload or Inspect.
function editingItems(params: Electron.ContextMenuParams): MenuItemConstructorOptions[] {
  const flags = params.editFlags
  if (params.isEditable) {
    return [
      { role: 'undo', enabled: flags.canUndo },
      { role: 'redo', enabled: flags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: flags.canCut },
      { role: 'copy', enabled: flags.canCopy },
      { role: 'paste', enabled: flags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: flags.canSelectAll }
    ]
  }
  return params.selectionText.trim() ? [{ role: 'copy' }] : []
}

function popupMenu(items: MenuItemConstructorOptions[]) {
  while (items.at(-1)?.type === 'separator') items.pop()
  if (items.length) Menu.buildFromTemplate(items).popup()
}

function showPageContextMenu(params: Electron.ContextMenuParams) {
  const items: MenuItemConstructorOptions[] = []
  if (params.linkURL) {
    items.push(
      { label: 'Open link in system browser', click: () => openExternal(params.linkURL) },
      { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' }
    )
  }
  items.push(...editingItems(params))
  const selection = params.selectionText.trim()
  if (selection) {
    const short = selection.length > 30 ? `${selection.slice(0, 30)}…` : selection
    items.push({ label: `Search for “${short}”`, click: () => win?.webContents.send('page:search', selection) })
  }
  popupMenu(items)
}

function createPage(id: number): Page {
  const view = new WebContentsView({
    webPreferences: secureWebPreferences({
      partition: WEB_PARTITION,
      // Catches plain link clicks so they open as a new popup; see src/preload/web.ts.
      preload: join(__dirname, '../preload/web.js')
    })
  })
  const created: Page = { view, blocked: 0 }
  const wc = view.webContents
  // A closed page can still fire events while it shuts down; only open ones report.
  const update = () => pages.get(id) === created && sendPageState(id)

  for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate-in-page'] as const) {
    wc.on(event as any, update)
  }
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      created.blocked = 0
      created.favicon = undefined
    }
  })
  wc.on('page-favicon-updated', (_e, favicons) => {
    created.favicon = favicons.find((f) => /^(https?|data):/.test(f))
    update()
  })
  wc.on('did-navigate', (_e, url) => {
    addVisit(url, wc.getTitle())
    update()
  })
  wc.on('page-title-updated', (_e, title) => {
    updateVisitTitle(wc.getURL(), title)
    update()
  })
  wc.setWindowOpenHandler(({ url }) => {
    openLink(id, url)
    return { action: 'deny' }
  })
  wc.on('context-menu', (_e, params) => showPageContextMenu(params))
  forwardShortcuts(wc)

  // It sits at the bottom of a popup with rounded corners.
  view.setBorderRadius(11)
  view.setVisible(id === shownPage)
  view.setBounds(viewBounds)
  win!.contentView.addChildView(view)
  pages.set(id, created)
  return created
}

function closePage(id: number) {
  const page = pages.get(id)
  if (!page) return
  pages.delete(id)
  if (shownPage === id) shownPage = null
  win?.contentView.removeChildView(page.view)
  page.view.webContents.close()
}

// Shows one popup's page (the top one), or none.
function showPage(id: number | null) {
  shownPage = id
  for (const [pageId, page] of pages) {
    page.view.setVisible(pageId === id)
    if (pageId === id) page.view.setBounds(viewBounds)
  }
}

// The UI is reloaded after a crash, but not endlessly if it keeps crashing.
const MAX_UI_RELOADS = 3
const UI_RELOAD_WINDOW = 5 * 60 * 1000
let uiReloads: number[] = []

function createWindow() {
  // The built UI must still carry its strict Content-Security-Policy; a build without one isn't run.
  const rendererHtml = join(__dirname, '../renderer/index.html')
  if (!process.env.ELECTRON_RENDERER_URL) {
    const problems = checkRendererCsp(rendererHtml)
    if (problems.length) {
      console.error(`Refusing to start: the UI's Content-Security-Policy is unsafe (${problems.join('; ')}).`)
      dialog.showErrorBox('Zook can’t start', 'This build of Zook is damaged. Please reinstall it.')
      app.quit()
      return
    }
  }

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 600,
    minHeight: 400,
    title: 'Zook',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences({
      preload: join(__dirname, '../preload/index.js')
    })
  })

  // The app UI itself never navigates away; external links go to the system browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  forwardShortcuts(win.webContents)
  win.webContents.on('context-menu', (_e, params) => popupMenu(editingItems(params)))
  // The crash itself is logged app-wide (see log.ts).
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || !win) return
    const now = Date.now()
    uiReloads = uiReloads.filter((t) => now - t < UI_RELOAD_WINDOW)
    if (uiReloads.length >= MAX_UI_RELOADS) {
      console.error('The UI keeps crashing; not reloading it again.')
      return
    }
    uiReloads.push(now)
    win.webContents.reload()
  })
  win.on('unresponsive', () => console.warn('The UI stopped responding.'))
  win.on('responsive', () => console.warn('The UI is responding again.'))
  win.on('closed', () => {
    for (const controller of chats.values()) controller.abort()
    chats.clear()
    win = null
    pages.clear()
    shownPage = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(rendererHtml)
  }
}

function applyAdblock(enabled: boolean) {
  return setAdblock(session.fromPartition(WEB_PARTITION), enabled, onRequestBlocked)
}

const isPageId = (id: unknown): id is number => Number.isSafeInteger(id)

ipcMain.handle('search', (_e, vertical: Vertical, query: string, page = 0) => search(vertical, query, page))

ipcMain.handle('settings:get', () => getStatus())
ipcMain.handle('settings:save', async (_e, id: ProviderId, creds: Record<string, string>) => {
  const provider = getProvider(id)
  const clean = Object.fromEntries(provider.fields.map((f) => [f.id, (creds[f.id] ?? '').trim()]))
  const missing = provider.fields.find((f) => !clean[f.id])
  if (missing) throw new Error(`Enter the ${missing.label}.`)
  // Check the credentials with a real query before saving them.
  await provider.search(clean, 'test', 0)
  saveCredentials(id, clean)
  return getStatus()
})
ipcMain.handle('settings:clear', (_e, id: ProviderId) => {
  clearCredentials(id)
  return getStatus()
})
ipcMain.handle('settings:setActive', (_e, id: ProviderId) => {
  setActiveProvider(id)
  return getStatus()
})
ipcMain.handle('settings:setAdblock', async (_e, enabled: boolean) => {
  await applyAdblock(enabled)
  saveAdblockSetting(enabled)
  return getStatus()
})
ipcMain.handle('settings:saveSuggestKey', async (_e, key: string) => {
  key = key.trim()
  if (!key) throw new Error('Enter an API key.')
  await braveSuggest(key, 'test')
  saveSuggestKey(key)
  return getStatus()
})
ipcMain.handle('settings:clearSuggestKey', () => {
  clearSuggestKey()
  return getStatus()
})
ipcMain.on('settings:setSidebar', (_e, open: boolean) => setSidebarOpen(open === true))

// A null id adds a new custom backend.
ipcMain.handle('settings:saveChat', async (_e, id: string | null, form: ChatForm) => {
  const config = resolveChatConfig(id, form)
  await verifyChatConfig(config)
  saveChatConfig(id, config)
  return getStatus()
})
ipcMain.handle('settings:listChatModels', (_e, id: string | null, form: ChatForm) =>
  listChatModels(resolveChatListConfig(id, form))
)
ipcMain.handle('settings:setActiveChat', (_e, id: string) => {
  setActiveChat(id)
  return getStatus()
})
ipcMain.handle('settings:setChatGrounded', (_e, grounded: boolean) => {
  setChatGrounded(grounded === true)
  return getStatus()
})
ipcMain.handle('settings:clearChat', (_e, id: string) => {
  clearChatConfig(String(id))
  return getStatus()
})

ipcMain.handle('chat:start', (e, messages: ChatMessage[], grounded: boolean, sessionId: unknown, context: unknown) => {
  const config = getChatConfig()
  // An opaque per-conversation id from the renderer; anything else is dropped.
  const session = typeof sessionId === 'string' && /^[\w-]{1,100}$/.test(sessionId) ? sessionId : undefined
  if (!config) throw new Error('No AI model set up. Add one in Settings.')
  const history = sanitizeMessages(messages)
  const question = history.at(-1)
  if (question?.role !== 'user') throw new Error('Nothing to send.')
  const searchWeb = grounded ? activeSearch('web') : null
  // Reported back so the reply can be saved with the model that actually wrote it.
  const backend: ChatBackend = { preset: config.preset, name: backendName(config), model: config.model }

  const requestId = randomUUID()
  const controller = new AbortController()
  chats.set(requestId, controller)
  const wc = e.sender
  const send = (channel: string, payload: object) => {
    if (!wc.isDestroyed()) wc.send(channel, { requestId, ...payload })
  }

  const research = startResearch(
    cleanContext(context),
    searchWeb && ((query) => searchWeb(query, 0)),
    `Mozilla/5.0 (compatible; Zook/${app.getVersion()})`,
    controller.signal,
    (activity) => send('chat:activity', { activity }),
    (pool) => send('chat:context', { context: pool })
  )

  ;(async () => {
    let reply = ''
    const onDelta = (text: string) => {
      reply += text
      send('chat:delta', { text })
    }
    try {
      let finishReason: string
      try {
        finishReason = await runChat(
          config,
          buildMessages(history, research.context, { tools: true }),
          research.tools,
          controller.signal,
          { onDelta, runTools: (calls) => research.runTools(calls) },
          session
        )
      } catch (err) {
        // Backends without tool support answer as before: one search up front, then the reply.
        if (!(err instanceof ToolsUnsupportedError) || reply) throw err
        const searched = searchWeb ? await research.searchFirst(question.content.slice(0, 400)) : undefined
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        finishReason = await runChat(
          config,
          buildMessages(history, research.context, { tools: false, searched }),
          [],
          controller.signal,
          { onDelta, runTools: async () => [] },
          session
        )
      }
      send('chat:sources', { sources: sourcesFor(reply, research.context, research.added) })
      send('chat:done', { finishReason })
    } catch (err) {
      if (controller.signal.aborted) send('chat:done', { finishReason: 'aborted' })
      else send('chat:error', { message: err instanceof Error ? err.message : String(err) })
    } finally {
      chats.delete(requestId)
    }
  })()

  return { requestId, backend }
})
ipcMain.handle('chat:abort', (_e, requestId: string) => {
  chats.get(requestId)?.abort()
})

ipcMain.handle('suggest:local', (_e, input: string) => suggestFromHistory(input))
ipcMain.handle('suggest:remote', async (_e, input: string) => {
  const key = getSuggestKey()
  if (!key || !input.trim()) return []
  try {
    return await braveSuggest(key, input)
  } catch {
    return []
  }
})

ipcMain.handle('history:get', () => getHistory())
ipcMain.handle('history:removeSearch', (_e, query: string) => removeSearch(query))
ipcMain.handle('history:removeVisit', (_e, url: string) => removeVisit(url))
ipcMain.handle('history:clear', () => clearHistory())

// The renderer holds the live conversation; main only stores it.
ipcMain.handle('threads:list', () => listThreads())
ipcMain.handle('threads:get', (_e, id: string) => getThread(id))
ipcMain.handle('threads:save', (_e, thread: unknown) => saveThread(thread))
ipcMain.handle('threads:rename', (_e, id: string, title: string) => renameThread(id, title))
ipcMain.handle('threads:delete', (_e, id: string) => deleteThread(id))

// Opens a URL in a popup's page, creating the page for a new popup.
ipcMain.handle('licenses:get', () => getNotices())
ipcMain.handle('licenses:openChromium', () => openChromiumNotices())

ipcMain.handle('updates:get', () => getUpdateStatus())
ipcMain.handle('updates:check', () => checkForUpdates())
ipcMain.handle('updates:download', () => downloadUpdate())
ipcMain.on('updates:cancel', () => cancelDownload())
ipcMain.handle('updates:install', () => installUpdate())
ipcMain.handle('updates:setAuto', (_e, enabled: unknown) => {
  setAutoUpdate(enabled === true)
  rescheduleUpdates()
  return getUpdateStatus()
})

ipcMain.on('page:open', (_e, id: unknown, url: unknown) => {
  if (!win || !isPageId(id) || typeof url !== 'string' || !isWebUrl(url)) return
  const page = pages.get(id) ?? createPage(id)
  page.view.webContents.loadURL(url)
})
ipcMain.handle('page:capture', async (_e, id: unknown) => {
  const page = isPageId(id) ? pages.get(id) : undefined
  return page ? (await page.view.webContents.capturePage()).toDataURL() : null
})
ipcMain.on('page:show', (_e, id: unknown) => showPage(isPageId(id) ? id : null))
ipcMain.on('page:close', (_e, id: unknown) => isPageId(id) && closePage(id))
ipcMain.on('page:external', (_e, id: unknown) => {
  const page = isPageId(id) ? pages.get(id) : undefined
  if (page) openExternal(page.view.webContents.getURL())
})
// From the page preload: only pages Zook opened can ask, and only for web links.
ipcMain.on('page:link', (e, url: unknown) => {
  const from = pageIdOf(e.sender)
  if (from !== undefined && typeof url === 'string') openLink(from, url)
})
ipcMain.on('page:bounds', (_e, b: Bounds) => {
  viewBounds = {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height)
  }
  if (shownPage !== null) pages.get(shownPage)?.view.setBounds(viewBounds)
})

// Only from the app's own UI, which reports its uncaught errors here.
ipcMain.on('log:error', (e, message: unknown) => {
  if (e.sender === win?.webContents) logRendererError(message)
})
ipcMain.handle('logs:open', async () => {
  const error = await shell.openPath(logsDir())
  if (error) throw new Error(error)
})

app.on('second-instance', () => {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

app.whenReady().then(() => {
  if (!isPrimaryInstance) return
  hardenSessions(WEB_PARTITION)
  setAppMenu()
  setChatUserAgent(`Zook/${app.getVersion()}`)
  createWindow()
  startUpdater({ getAuto: getAutoUpdate, onChange: (status) => win?.webContents.send('updates:state', status) })
  if (getAdblock()) {
    applyAdblock(true).catch((err) => console.error('Ad blocker failed to load:', err))
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  flushHistory()
  flushThreads()
})
// Quit cleanly on SIGTERM too (e.g. logout or `kill`), so pending history and chats are saved.
process.on('SIGTERM', () => app.quit())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

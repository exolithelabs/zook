import {
  app,
  BrowserWindow,
  clipboard,
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
  setChatUserAgent,
  streamChat,
  verifyChatConfig,
  type ChatMessage,
  type ChatPresetId
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
import { getProvider, verticalSearch, type ProviderId, type SearchResult, type Vertical } from './providers'
import {
  clearChatConfig,
  clearCredentials,
  clearSuggestKey,
  getActiveProvider,
  getAdblock,
  getChatConfig,
  getCredentials,
  getStatus,
  getSuggestKey,
  resolveChatConfig,
  resolveChatListConfig,
  saveChatConfig,
  saveCredentials,
  saveSuggestKey,
  setActiveProvider,
  setAdblock as saveAdblockSetting,
  setChatGrounded,
  setSidebarOpen
} from './settings'
import { braveSuggest } from './suggest'
import { deleteThread, flushThreads, getThread, listThreads, renameThread, saveThread, type ChatBackend } from './threads'

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

const GROUNDING_RESULTS = 6
// Keeps requests to a sensible size; older turns matter least.
const MAX_HISTORY = 20

const SYSTEM_PROMPT =
  'You are Zook, a helpful assistant inside a web search app. Answer clearly and concisely. Use Markdown for lists, bold text and code blocks.'

export type ChatSource = { n: number; title: string; url: string; displayUrl: string; favicon?: string }

function toSource(r: SearchResult, i: number): ChatSource {
  return { n: i + 1, title: r.title, url: r.url, displayUrl: r.displayUrl, favicon: r.favicon }
}

// Snippets are display HTML; the model gets plain text.
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function groundingPrompt(sources: ChatSource[], results: SearchResult[]): string {
  if (sources.length === 0) {
    return 'A web search for this question returned no results. Say so, then answer from your own knowledge if you can.'
  }
  const list = sources
    .map((s, i) => `[${s.n}] ${s.title}\nURL: ${s.url}\n${plainText(results[i].snippet)}`)
    .join('\n\n')
  return (
    'Answer the latest question using these web search results. Cite them inline by number, like [1] or [2][3], ' +
    'right after the statement they support. Only cite numbers from this list. If the results do not answer the ' +
    `question, say so.\n\n${list}`
  )
}

function sanitizeMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return []
  return messages
    .filter(
      (m): m is ChatMessage =>
        (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim() !== ''
    )
    .map((m) => ({ role: m.role, content: m.content }))
    .slice(-MAX_HISTORY)
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
    // Without these, the default menu's Ctrl+W would close the window and Ctrl+R would reload the app UI.
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

function showContextMenu(wc: WebContents, params: Electron.ContextMenuParams) {
  const items: MenuItemConstructorOptions[] = []
  if (params.linkURL) {
    items.push(
      { label: 'Open link in system browser', click: () => shell.openExternal(params.linkURL) },
      { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' }
    )
  }
  const selection = params.selectionText.trim()
  if (selection) {
    const short = selection.length > 30 ? `${selection.slice(0, 30)}…` : selection
    items.push(
      { role: 'copy' },
      { label: `Search for “${short}”`, click: () => win?.webContents.send('page:search', selection) },
      { type: 'separator' }
    )
  }
  if (params.isEditable) {
    items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' })
  }
  items.push(
    { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: 'Reload', click: () => wc.reload() }
  )
  Menu.buildFromTemplate(items).popup()
}

function createPage(id: number): Page {
  const view = new WebContentsView({
    webPreferences: {
      partition: WEB_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Catches plain link clicks so they open as a new popup; see src/preload/web.ts.
      preload: join(__dirname, '../preload/web.js')
    }
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
  wc.on('context-menu', (_e, params) => showContextMenu(wc, params))
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

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 600,
    minHeight: 400,
    title: 'Zook',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })

  // The app UI itself never navigates away; external links go to the system browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  forwardShortcuts(win.webContents)
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
    win.loadFile(join(__dirname, '../renderer/index.html'))
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

ipcMain.handle(
  'settings:saveChat',
  async (_e, preset: ChatPresetId, baseUrl: string, model: string, apiKey: string) => {
    const config = resolveChatConfig(preset, baseUrl, model, apiKey)
    await verifyChatConfig(config)
    saveChatConfig(config)
    return getStatus()
  }
)
ipcMain.handle('settings:listChatModels', (_e, preset: ChatPresetId, baseUrl: string, apiKey: string) =>
  listChatModels(resolveChatListConfig(preset, baseUrl, apiKey))
)
ipcMain.handle('settings:setChatGrounded', (_e, grounded: boolean) => {
  setChatGrounded(grounded === true)
  return getStatus()
})
ipcMain.handle('settings:clearChat', () => {
  clearChatConfig()
  return getStatus()
})

ipcMain.handle('chat:start', (e, messages: ChatMessage[], grounded: boolean, sessionId: unknown) => {
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

  ;(async () => {
    try {
      const system: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }]
      if (searchWeb) {
        const { results } = await searchWeb(question.content.slice(0, 400), 0)
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        const sources = results.slice(0, GROUNDING_RESULTS).map(toSource)
        send('chat:sources', { sources })
        system.push({ role: 'system', content: groundingPrompt(sources, results) })
      }
      const finishReason = await streamChat(
        config,
        [...system, ...history],
        controller.signal,
        (text) => send('chat:delta', { text }),
        session
      )
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
ipcMain.on('page:open', (_e, id: unknown, url: string) => {
  if (!win || !isPageId(id)) return
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
  if (page) shell.openExternal(page.view.webContents.getURL())
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

app.whenReady().then(() => {
  setChatUserAgent(`Zook/${app.getVersion()}`)
  createWindow()
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

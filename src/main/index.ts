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
import { join } from 'node:path'
import { setAdblock } from './adblock'
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
import { getProvider, type ProviderId } from './providers'
import {
  clearCredentials,
  clearSuggestKey,
  getActiveProvider,
  getAdblock,
  getCredentials,
  getStatus,
  getSuggestKey,
  saveCredentials,
  saveSuggestKey,
  setActiveProvider,
  setAdblock as saveAdblockSetting
} from './settings'
import { braveSuggest } from './suggest'

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

export type TabState = {
  tabId: number
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  blocked: number
  favicon?: string
}

export type Shortcut =
  | 'new-tab'
  | 'close-tab'
  | 'reopen-tab'
  | 'next-tab'
  | 'prev-tab'
  | `tab-${number}`
  | 'focus-address'
  | 'back'
  | 'forward'
  | 'reload'
  | 'history'

type Bounds = { x: number; y: number; width: number; height: number }
type Tab = { view: WebContentsView; blocked: number; favicon?: string }

// Web pages get their own session so ad blocking and site data stay apart from the app UI.
const WEB_PARTITION = 'persist:web'

let win: BrowserWindow | null = null
const tabs = new Map<number, Tab>()
let visibleTab: number | null = null
let viewBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 }

async function search(query: string, page: number) {
  const id = getActiveProvider()
  const provider = getProvider(id)
  const creds = getCredentials(id)
  if (!creds) throw new Error(`No API key set for ${provider.name}. Add one in Settings.`)
  const response = await provider.search(creds, query, page)
  if (page === 0) addSearch(query)
  return response
}

function sendTabState(tabId: number) {
  const tab = tabs.get(tabId)
  if (!win || !tab) return
  const wc = tab.view.webContents
  const state: TabState = {
    tabId,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    blocked: tab.blocked,
    favicon: tab.favicon
  }
  win.webContents.send('tab:state', state)
}

// Blocked-request counts change fast, so their updates are batched.
const pendingBlockedUpdates = new Set<number>()
function onRequestBlocked(webContentsId: number) {
  for (const [tabId, tab] of tabs) {
    if (tab.view.webContents.id !== webContentsId) continue
    tab.blocked++
    if (pendingBlockedUpdates.size === 0) {
      setTimeout(() => {
        for (const id of pendingBlockedUpdates) sendTabState(id)
        pendingBlockedUpdates.clear()
      }, 250)
    }
    pendingBlockedUpdates.add(tabId)
  }
}

function shortcutFor(input: Input): Shortcut | null {
  if (input.type !== 'keyDown') return null
  const ctrl = input.control || input.meta
  const key = input.key.toLowerCase()
  if (ctrl && input.shift && key === 't') return 'reopen-tab'
  if (ctrl && key === 't') return 'new-tab'
  if (ctrl && key === 'w') return 'close-tab'
  if (ctrl && key === 'tab') return input.shift ? 'prev-tab' : 'next-tab'
  if (ctrl && /^[1-9]$/.test(key)) return `tab-${Number(key)}`
  if (ctrl && key === 'l') return 'focus-address'
  if (ctrl && key === 'h') return 'history'
  if ((ctrl && key === 'r') || key === 'f5') return 'reload'
  if (input.alt && key === 'arrowleft') return 'back'
  if (input.alt && key === 'arrowright') return 'forward'
  return null
}

// Shortcuts are caught in the main process so they work whether the app UI or a page has focus.
function forwardShortcuts(wc: WebContents) {
  wc.on('before-input-event', (event, input) => {
    const shortcut = shortcutFor(input)
    if (!shortcut || !win) return
    event.preventDefault()
    win.webContents.send('shortcut', shortcut)
  })
}

function openInNewTab(url: string, background = false) {
  win?.webContents.send('tab:new', { url, background })
}

function showContextMenu(wc: WebContents, params: Electron.ContextMenuParams) {
  const items: MenuItemConstructorOptions[] = []
  if (params.linkURL) {
    items.push(
      { label: 'Open link in new tab', click: () => openInNewTab(params.linkURL, true) },
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
      { label: `Search for “${short}”`, click: () => win?.webContents.send('search:new-tab', selection) },
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

function createTab(tabId: number): Tab {
  const view = new WebContentsView({
    webPreferences: { partition: WEB_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  const tab: Tab = { view, blocked: 0 }
  const wc = view.webContents
  const update = () => sendTabState(tabId)

  for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate-in-page'] as const) {
    wc.on(event as any, update)
  }
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      tab.blocked = 0
      tab.favicon = undefined
    }
  })
  wc.on('page-favicon-updated', (_e, favicons) => {
    tab.favicon = favicons.find((f) => /^(https?|data):/.test(f))
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
  wc.setWindowOpenHandler(({ url, disposition }) => {
    openInNewTab(url, disposition === 'background-tab')
    return { action: 'deny' }
  })
  wc.on('context-menu', (_e, params) => showContextMenu(wc, params))
  forwardShortcuts(wc)

  view.setVisible(tabId === visibleTab)
  view.setBounds(viewBounds)
  win!.contentView.addChildView(view)
  tabs.set(tabId, tab)
  return tab
}

function destroyTab(tabId: number) {
  const tab = tabs.get(tabId)
  if (!tab) return
  win?.contentView.removeChildView(tab.view)
  tab.view.webContents.close()
  tabs.delete(tabId)
}

function showTab(tabId: number | null) {
  visibleTab = tabId
  for (const [id, tab] of tabs) {
    tab.view.setVisible(id === tabId)
    if (id === tabId) tab.view.setBounds(viewBounds)
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
    win = null
    tabs.clear()
    visibleTab = null
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

const withTab = (fn: (wc: WebContents) => void) => (_e: unknown, tabId: number) => {
  const tab = tabs.get(tabId)
  if (tab) fn(tab.view.webContents)
}

ipcMain.handle('search', (_e, query: string, page = 0) => search(query, page))

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

// `fresh` starts the tab's page history over, e.g. when opening a new search result.
ipcMain.on('tab:open', (_e, tabId: number, url: string, fresh = false) => {
  if (!win) return
  if (fresh) destroyTab(tabId)
  const tab = tabs.get(tabId) ?? createTab(tabId)
  tab.view.webContents.loadURL(url)
})
ipcMain.handle('tab:capture', async (_e, tabId: number) => {
  const tab = tabs.get(tabId)
  return tab ? (await tab.view.webContents.capturePage()).toDataURL() : null
})
ipcMain.on('tab:show', (_e, tabId: number | null) => showTab(tabId))
ipcMain.on('tab:close', (_e, tabId: number) => destroyTab(tabId))
ipcMain.on('tab:back', withTab((wc) => wc.navigationHistory.goBack()))
ipcMain.on('tab:forward', withTab((wc) => wc.navigationHistory.goForward()))
ipcMain.on('tab:reload', withTab((wc) => wc.reload()))
ipcMain.on('tab:stop', withTab((wc) => wc.stop()))
ipcMain.on('tab:external', withTab((wc) => shell.openExternal(wc.getURL())))
ipcMain.on('tab:bounds', (_e, b: Bounds) => {
  viewBounds = {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height)
  }
  if (visibleTab !== null) tabs.get(visibleTab)?.view.setBounds(viewBounds)
})

app.whenReady().then(() => {
  createWindow()
  if (getAdblock()) {
    applyAdblock(true).catch((err) => console.error('Ad blocker failed to load:', err))
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', flushHistory)
// Quit cleanly on SIGTERM too (e.g. logout or `kill`), so pending history is saved.
process.on('SIGTERM', () => app.quit())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

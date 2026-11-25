import { app, Menu, session, shell, type Session, type WebPreferences } from 'electron'
import { readFileSync } from 'node:fs'

// Defences that apply to every window and web page, following Electron's security checklist.

// Only these leave the app for the system's handler: no file:, smb:, custom app schemes or the like,
// which a web page could otherwise use to launch local programs.
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function openExternal(url: string) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    console.warn('Refused to open an invalid URL externally:', url.slice(0, 200))
    return
  }
  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    console.warn(`Refused to open a ${parsed.protocol} link externally.`)
    return
  }
  shell.openExternal(parsed.href).catch((err) => console.error('Could not open link externally:', err))
}

// Settings no window or view may weaken. Asking for the opposite is a bug, so it throws rather
// than quietly winning or losing.
const REQUIRED: WebPreferences = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  experimentalFeatures: false,
  navigateOnDragDrop: false,
  // No Inspect or DevTools outside development.
  devTools: !app.isPackaged
}

export function secureWebPreferences(prefs: WebPreferences): WebPreferences {
  for (const [key, value] of Object.entries(REQUIRED) as [keyof WebPreferences, unknown][]) {
    if (prefs[key] !== undefined && prefs[key] !== value) {
      throw new Error(`Insecure webPreferences: ${key} must be ${value}.`)
    }
  }
  if (prefs.enableBlinkFeatures) throw new Error('Insecure webPreferences: enableBlinkFeatures is not allowed.')
  return { ...prefs, ...REQUIRED }
}

// What the app's own UI may use: copying text (the chat's copy buttons) and nothing else.
const APP_PERMISSIONS = new Set(['clipboard-sanitized-write'])
// What web pages may use without asking. Everything else (camera, microphone, location,
// notifications, MIDI, USB, ...) is denied, since Zook has no UI to ask the user.
const WEB_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock'])

function restrictPermissions(target: Session, allowed: Set<string>) {
  target.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))
  target.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
}

// Before the app is ready: sandbox every renderer, whatever its webPreferences say, and lock down
// every web contents as it is created. Specific handlers set later (such as each window's
// window-open handler) replace these defaults.
export function hardenApp() {
  app.enableSandbox()
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => {
      e.preventDefault()
      console.warn('Blocked a <webview> from attaching.')
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Pages stay on the web: no navigating or redirecting a view to file:, chrome: or other local schemes.
    // Email links go to the mail app instead.
    const guard = (e: Electron.Event<{ url: string }>) => {
      if (isWebUrl(e.url) || e.url === 'about:blank') return
      e.preventDefault()
      if (e.url.startsWith('mailto:')) openExternal(e.url)
      else console.warn(`Blocked navigation to a ${e.url.split(':')[0]}: URL.`)
    }
    contents.on('will-navigate', guard)
    contents.on('will-redirect', guard)
  })
}

// Replaces Electron's default menu, whose View menu and accelerators offer Reload, zoom and
// DevTools. Editing shortcuts (copy, paste, undo, ...) keep working: on Linux and Windows Chromium
// handles them itself, while macOS needs them in an Edit menu.
export function setAppMenu() {
  Menu.setApplicationMenu(
    process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null
  )
}

// Once the app is ready, since sessions can't be touched before.
export function hardenSessions(webPartition: string) {
  restrictPermissions(session.defaultSession, APP_PERMISSIONS)
  restrictPermissions(session.fromPartition(webPartition), WEB_PERMISSIONS)
}

// The app UI's Content-Security-Policy is a <meta> tag in its HTML (pages loaded from file: have no
// headers to carry one). This checks that the built page still has a strict one, returning what is wrong.
export function checkRendererCsp(htmlPath: string): string[] {
  let html: string
  try {
    html = readFileSync(htmlPath, 'utf8')
  } catch {
    return [`couldn't read ${htmlPath}`]
  }
  // The policy itself is full of single quotes ('self'), so the attribute ends at its own quote.
  const meta = html.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*http-equiv=["']Content-Security-Policy["'](?:[^>"']|"[^"]*"|'[^']*')*>/i)?.[0]
  const content = meta?.match(/\bcontent=(["'])(.*?)\1/is)?.[2]
  if (!content) return ['no Content-Security-Policy meta tag']
  const directives = new Map(
    content
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...values]) => [name.toLowerCase(), values])
  )
  const problems: string[] = []
  const scripts = directives.get('script-src') ?? directives.get('default-src')
  if (!directives.get('default-src')?.includes("'self'")) problems.push("default-src isn't limited to 'self'")
  if (!scripts) problems.push('no script-src')
  else if (scripts.some((v) => v === '*' || /^'unsafe-(inline|eval)'$|^https?:$|^data:$/.test(v))) {
    problems.push(`script-src allows ${scripts.join(' ')}`)
  }
  if (directives.get('object-src')?.join(' ') !== "'none'") problems.push("object-src isn't 'none'")
  if (directives.get('base-uri')?.join(' ') !== "'none'") problems.push("base-uri isn't 'none'")
  return problems
}

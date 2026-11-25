import { app, crashReporter } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'

// Errors, warnings and crashes go to main.log in the app's logs folder (as well as the console), so a
// problem a user hits can be found afterwards. The file rolls over to main.old.log at MAX_LOG bytes.
// Native crashes are kept as minidumps in the crashDumps folder; nothing is ever uploaded.
const MAX_LOG = 1024 * 1024

export const logsDir = () => app.getPath('logs')
const logFile = () => join(logsDir(), 'main.log')

// Keys can turn up in error messages (e.g. a request URL), so the obvious shapes are masked.
function redact(text: string): string {
  return text
    .replace(/(Bearer\s+)[\w.~+/=-]+/gi, '$1[redacted]')
    .replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/((?:x-api-key|x-subscription-token|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]')
}

function write(level: 'info' | 'warn' | 'error', args: unknown[]) {
  const line = `${new Date().toISOString()} [${level}] ${redact(format(...args))}\n`
  try {
    mkdirSync(logsDir(), { recursive: true })
    try {
      if (statSync(logFile()).size > MAX_LOG) renameSync(logFile(), join(logsDir(), 'main.old.log'))
    } catch {
      // No log yet.
    }
    appendFileSync(logFile(), line, { mode: 0o600 })
  } catch {
    // Logging must never be what breaks the app.
  }
}

export const logInfo = (...args: unknown[]) => write('info', args)

// Before anything else runs, so that every console.error and console.warn (including the stores'
// recovery messages) and every crash from here on is recorded.
export function initLogging() {
  app.setAppLogsPath()
  crashReporter.start({ uploadToServer: false })

  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      write(level, args)
    }
  }

  // Recorded rather than left to take down the app; main-process state is all in memory and stores.
  process.on('uncaughtException', (err) => console.error('Uncaught exception:', err))
  process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason))

  app.on('render-process-gone', (_e, contents, details) => {
    console.error(`Renderer gone (${details.reason}, exit code ${details.exitCode}) at ${contents.getURL() || 'about:blank'}`)
  })
  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    console.error(`${details.type} process gone (${details.reason}, exit code ${details.exitCode})${details.name ? `: ${details.name}` : ''}`)
  })

  logInfo(
    `Zook ${app.getVersion()} starting: Electron ${process.versions.electron}, ${process.platform} ${process.arch}` +
      (app.isPackaged ? '' : ' (development)')
  )
}

// Errors from the app's own UI, which arrive over IPC. Capped so a renderer stuck in a loop
// can't fill the disk.
const RENDERER_LIMIT = 30
const RENDERER_WINDOW = 60_000
let rendererCount = 0
let rendererWindowStart = 0

export function logRendererError(message: unknown) {
  if (typeof message !== 'string') return
  const now = Date.now()
  if (now - rendererWindowStart > RENDERER_WINDOW) {
    rendererWindowStart = now
    rendererCount = 0
  }
  if (++rendererCount > RENDERER_LIMIT) return
  if (rendererCount === RENDERER_LIMIT) message += ' (further renderer errors this minute are dropped)'
  console.error(`Renderer: ${message.slice(0, 4000)}`)
}

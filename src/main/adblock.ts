import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { app, type Session } from 'electron'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

let blocker: Promise<ElectronBlocker> | null = null

// Loads the prebuilt ads + tracking filter lists, cached on disk and refreshed weekly.
function loadBlocker(): Promise<ElectronBlocker> {
  if (!blocker) {
    const path = join(app.getPath('userData'), 'adblock-engine.bin')
    blocker = (async () => {
      try {
        if (Date.now() - (await stat(path)).mtimeMs > CACHE_MAX_AGE_MS) await rm(path)
      } catch {
        // no cache yet
      }
      return ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
        path,
        read: readFile,
        write: writeFile
      })
    })()
    blocker.catch(() => (blocker = null))
  }
  return blocker
}

// The engine's emitter can only unsubscribe a listener by reference.
let blockedListener: ((request: { tabId: number }) => void) | null = null

export async function setAdblock(session: Session, enabled: boolean, onBlocked: (webContentsId: number) => void) {
  const engine = await loadBlocker()
  if (enabled && !engine.isBlockingEnabled(session)) {
    engine.enableBlockingInSession(session)
    blockedListener = (request) => onBlocked(request.tabId)
    engine.on('request-blocked', blockedListener)
  } else if (!enabled && engine.isBlockingEnabled(session)) {
    engine.disableBlockingInSession(session)
    if (blockedListener) engine.unsubscribe('request-blocked', blockedListener)
    blockedListener = null
  }
}

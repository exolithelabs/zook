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

export async function setAdblock(session: Session, enabled: boolean, onBlocked: (webContentsId: number) => void) {
  const engine = await loadBlocker()
  if (enabled && !engine.isBlockingEnabled(session)) {
    engine.enableBlockingInSession(session)
    engine.on('request-blocked', (request) => onBlocked(request.tabId))
  } else if (!enabled && engine.isBlockingEnabled(session)) {
    engine.disableBlockingInSession(session)
    engine.removeAllListeners('request-blocked')
  }
}

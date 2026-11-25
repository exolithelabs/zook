import { shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Written by scripts/licenses.mjs as part of `npm run build`.
export type PackageNotice = { name: string; version: string; license: string; url?: string; text: string }

export type Notices = {
  app: { name: string; version: string; license: string; text: string }
  electron: { version: string; license: string; text: string }
  // What this copy is actually running, which the build-time notices can't know.
  runtime: { chromium: string; node: string }
  packages: PackageNotice[]
}

// Next to out/main/ in development, and inside app.asar once packaged.
const dir = () => join(__dirname, '../licenses')

let cached: Notices | null = null

export function getNotices(): Notices {
  if (!cached) {
    let stored: Omit<Notices, 'runtime'>
    try {
      stored = JSON.parse(readFileSync(join(dir(), 'notices.json'), 'utf8'))
    } catch {
      throw new Error('License notices haven’t been collected for this build. Run npm run build.')
    }
    cached = { ...stored, runtime: { chromium: process.versions.chrome, node: process.versions.node } }
  }
  return cached
}

// The full Chromium notices are several megabytes of HTML, so they open in the system browser. That can't
// read inside app.asar, which is why electron-builder unpacks this one file next to it.
export async function openChromiumNotices() {
  const path = join(dir(), 'LICENSES.chromium.html').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  if (!existsSync(path)) throw new Error('The Chromium notices weren’t included in this build.')
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
}

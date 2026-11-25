import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

// A migration takes the data as stored at version i and returns it in the shape of version i + 1.
// Files written before versioning count as version 0.
export type Migration = (data: any) => any

export type StoreOptions = {
  path: string
  // migrations[i] upgrades version i to i + 1, so the current version is migrations.length.
  migrations: Migration[]
}

// How many backups of unreadable files to keep per store.
const MAX_CORRUPT_BACKUPS = 3

let tmpCounter = 0

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// `settings.json` → `settings.<tag>.json`, next to the original.
function siblingPath(path: string, tag: string): string {
  const name = basename(path).replace(/\.json$/, '')
  return join(dirname(path), `${name}.${tag}.json`)
}

// Moves an unreadable file aside so it isn't overwritten by the next save, keeping the newest few.
function quarantine(path: string, reason: string) {
  const backup = siblingPath(path, `corrupt-${Date.now()}`)
  try {
    renameSync(path, backup)
    console.error(`${basename(path)} could not be read (${reason}); moved it to ${basename(backup)}.`)
  } catch (err) {
    console.error(`${basename(path)} could not be read (${reason}) or moved aside:`, err)
    return
  }
  const prefix = `${basename(path).replace(/\.json$/, '')}.corrupt-`
  try {
    readdirSync(dirname(path))
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .sort()
      .slice(0, -MAX_CORRUPT_BACKUPS)
      .forEach((f) => unlinkSync(join(dirname(path), f)))
  } catch {
    // Pruning old backups is best effort.
  }
}

// Copies the file before it is migrated or overwritten by an older version of the app.
// An existing backup for that version is kept, since it is the closer to the original.
function backup(path: string, version: number) {
  try {
    copyFileSync(path, siblingPath(path, `v${version}.bak`), 1 /* COPYFILE_EXCL */)
  } catch (err: any) {
    if (err?.code !== 'EEXIST') console.error(`Could not back up ${basename(path)}:`, err)
  }
}

// Reads a store, upgrading it to the current version. A missing file reads as undefined, and so
// does an unreadable one, after it has been moved aside.
export function readStore<T extends object>({ path, migrations }: StoreOptions): T | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err: any) {
    if (err?.code !== 'ENOENT') console.error(`Could not read ${basename(path)}:`, err)
    return undefined
  }

  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch (err) {
    quarantine(path, (err as Error).message)
    return undefined
  }
  if (!isObject(stored)) {
    quarantine(path, 'not a JSON object')
    return undefined
  }

  const current = migrations.length
  const { version: storedVersion, ...data } = stored
  const version = storedVersion === undefined ? 0 : storedVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    quarantine(path, `bad version ${JSON.stringify(storedVersion)}`)
    return undefined
  }

  // Written by a newer version of the app: use what can be read, but keep the original,
  // since the next save drops whatever this version doesn't know about.
  if (version > current) {
    backup(path, version)
    return data as T
  }
  if (version === current) return data as T

  backup(path, version)
  let migrated: unknown = data
  try {
    for (let v = version; v < current; v++) {
      migrated = migrations[v](migrated)
      if (!isObject(migrated)) throw new Error(`migration to v${v + 1} returned ${typeof migrated}`)
    }
  } catch (err) {
    // The original is still in the backup.
    console.error(`Could not migrate ${basename(path)} from v${version}:`, err)
    quarantine(path, 'migration failed')
    return undefined
  }
  writeStore(path, current, migrated as object)
  return migrated as T
}

// Writes to a temporary file and renames it over the original, so a crash mid-write
// leaves either the old file or the new one, never a partial one.
export function writeStore(path: string, version: number, data: object) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify({ version, ...data }))
    fsyncSync(fd)
  } catch (err) {
    closeSync(fd)
    try {
      unlinkSync(tmp)
    } catch {}
    throw err
  }
  closeSync(fd)
  try {
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {}
    throw err
  }
  // Make the rename itself durable. Directories can't be opened this way on Windows.
  if (process.platform !== 'win32') {
    try {
      const dirFd = openSync(dir, 'r')
      try {
        fsyncSync(dirFd)
      } finally {
        closeSync(dirFd)
      }
    } catch {}
  }
}

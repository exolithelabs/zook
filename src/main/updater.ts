import { app, net, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { accessSync, constants, createReadStream } from 'node:fs'
import { chmod, mkdir, open, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { UPDATE_PUBLIC_KEY } from './update-key'

// Releases are published on GitHub with the builds for each platform and architecture, release.json
// describing them, and release.json.sig, a detached Ed25519 signature of release.json's exact bytes.
// Nothing in release.json is trusted until that signature checks out, and nothing downloaded is
// installed or opened unless its size and SHA-512 match the signed manifest.
//
// On Linux the AppImage replaces itself in place. On macOS and Windows the verified installer (the .dmg,
// or the NSIS setup .exe) is downloaded and opened. Copies that can do neither just link to the release.
const REPO = 'exolithelabs/zook'
const RELEASES_URL = `https://github.com/${REPO}/releases`
const LATEST_URL = `${RELEASES_URL}/latest/download`

const MAX_MANIFEST = 64 * 1024
const MAX_SIGNATURE = 1024
const MAX_ARTIFACT = 1024 * 1024 * 1024
const MAX_NOTES = 20_000
const FETCH_TIMEOUT = 30_000
// A download that receives nothing for this long is given up on.
const STALL_TIMEOUT = 60_000

const FIRST_CHECK_DELAY = 10_000
const CHECK_INTERVAL = 6 * 60 * 60 * 1000

export type ReleaseInfo = {
  version: string
  date: string
  notes: string
  // The release's page on GitHub.
  url: string
  // Of this platform's download; null when there is none for it.
  size: number | null
}

export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current' }
  | { phase: 'available'; release: ReleaseInfo }
  | { phase: 'downloading'; release: ReleaseInfo; received: number }
  // Downloaded and verified. An AppImage is already in place and starts on the next launch;
  // an installer still has to be opened.
  | { phase: 'ready'; release: ReleaseInfo }
  | { phase: 'error'; message: string; release?: ReleaseInfo }

export type UpdateStatus = {
  current: string
  // Whether this copy can check for updates at all: it needs the signing key to trust anything.
  canCheck: boolean
  platform: Platform | null
  install: InstallMode
  // Why checking or installing isn't possible, when it isn't.
  reason: string
  auto: boolean
  checkedAt: number | null
  releasesUrl: string
  state: UpdateState
}

// release.json's keys for each platform.
export type Platform = 'linux' | 'mac' | 'win'
// How this copy installs an update: replacing the running AppImage, opening a downloaded installer,
// or not at all, in which case it links to the release.
export type InstallMode = 'appimage' | 'installer' | 'link'

type Artifact = { file: string; size: number; sha512: string }
type Manifest = {
  version: string
  date: string
  notes: string
  // By platform, then by Node's name for the architecture (x64, arm64, or universal on macOS).
  artifacts: Record<Platform, Partial<Record<string, Artifact>>>
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SHA512 = /^[A-Za-z0-9+/]{86}==$/
// The file the updater uses on each platform. Other assets (such as the macOS .zip) are listed in
// release.json for completeness, but not downloaded.
const FILES: Record<Platform, RegExp> = {
  linux: /^[\w.-]+\.AppImage$/,
  mac: /^[\w.-]+\.dmg$/,
  win: /^[\w.-]+\.exe$/
}

let state: UpdateState = { phase: 'idle' }
let checkedAt: number | null = null
// When the last check started, successful or not, so a failing one isn't retried straight away.
let attemptedAt = 0
let download: AbortController | null = null
let timer: NodeJS.Timeout | null = null
let options: { getAuto: () => boolean; onChange: (status: UpdateStatus) => void } | null = null
// The verified installer, once downloaded (macOS and Windows).
let installer: { path: string; artifact: Artifact } | null = null

function publicKey(): KeyObject | null {
  const raw = Buffer.from(UPDATE_PUBLIC_KEY, 'base64')
  if (raw.length !== 32) return null
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
}

function currentPlatform(): Platform | null {
  if (process.platform === 'linux') return 'linux'
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'win32') return 'win'
  return null
}

// The AppImage runtime says where the running image lives.
function appImagePath(): string | null {
  const path = process.env.APPIMAGE
  return app.isPackaged && process.platform === 'linux' && path ? path : null
}

function installMode(): { mode: InstallMode; reason: string } {
  if (!publicKey()) return { mode: 'link', reason: 'This build has no update signing key.' }
  const platform = currentPlatform()
  if (!platform) return { mode: 'link', reason: 'There are no builds of Zook for this system.' }
  if (!app.isPackaged) return { mode: 'link', reason: 'Development builds don’t install updates.' }
  if (platform !== 'linux') return { mode: 'installer', reason: '' }
  const path = appImagePath()
  if (!path) return { mode: 'link', reason: 'Only the AppImage can update itself. Download new versions from GitHub.' }
  try {
    accessSync(dirname(path), constants.W_OK)
    accessSync(path, constants.W_OK)
  } catch {
    return {
      mode: 'link',
      reason: `Zook can't write to ${dirname(path)}, so it can't update itself there. Download new versions from GitHub.`
    }
  }
  return { mode: 'appimage', reason: '' }
}

export function getUpdateStatus(): UpdateStatus {
  const { mode, reason } = installMode()
  return {
    current: app.getVersion(),
    canCheck: publicKey() !== null,
    platform: currentPlatform(),
    install: mode,
    reason,
    auto: options?.getAuto() ?? true,
    checkedAt,
    releasesUrl: RELEASES_URL,
    state
  }
}

function setState(next: UpdateState) {
  state = next
  options?.onChange(getUpdateStatus())
}

// Prereleases sort before their release; anything else is compared part by part.
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = a.split(/-(.*)/s)
  const [coreB, preB] = b.split(/-(.*)/s)
  const partsA = coreA.split('.').map(Number)
  const partsB = coreB.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (partsA[i] !== partsB[i]) return partsA[i] - partsB[i]
  }
  if (!preA || !preB) return preA ? -1 : preB ? 1 : 0
  const idsA = preA.split('.')
  const idsB = preB.split('.')
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
    const x = idsA[i]
    const y = idsB[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y)
    return numeric ? Number(x) - Number(y) : x < y ? -1 : 1
  }
  return 0
}

async function fetchLimited(url: string, max: number): Promise<Buffer> {
  const res = await net.fetch(url, {
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT)
  })
  if (res.status === 404) throw new Error('No release has been published yet.')
  if (!res.ok || !res.body) throw new Error(`GitHub responded with ${res.status}.`)
  const chunks: Buffer[] = []
  let size = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      reader.cancel().catch(() => {})
      throw new Error(`${basename(new URL(url).pathname)} is larger than expected.`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

function parseArtifacts(platform: Platform, section: unknown): Partial<Record<string, Artifact>> {
  const artifacts: Partial<Record<string, Artifact>> = {}
  if (typeof section !== 'object' || section === null) return artifacts
  for (const [arch, a] of Object.entries<any>(section)) {
    if (
      typeof a?.file === 'string' &&
      FILES[platform].test(a.file) &&
      Number.isSafeInteger(a.size) &&
      a.size > 0 &&
      a.size <= MAX_ARTIFACT &&
      typeof a.sha512 === 'string' &&
      SHA512.test(a.sha512)
    ) {
      artifacts[arch] = { file: a.file, size: a.size, sha512: a.sha512 }
    }
  }
  return artifacts
}

function parseManifest(bytes: Buffer): Manifest {
  const data = JSON.parse(bytes.toString('utf8'))
  if (data?.schema !== 1) throw new Error('The release uses a format this version doesn’t understand.')
  if (typeof data.version !== 'string' || !VERSION.test(data.version)) throw new Error('The release has a bad version.')
  return {
    version: data.version,
    date: typeof data.date === 'string' ? data.date.slice(0, 40) : '',
    notes: typeof data.notes === 'string' ? data.notes.slice(0, MAX_NOTES) : '',
    artifacts: {
      linux: parseArtifacts('linux', data.linux),
      mac: parseArtifacts('mac', data.mac),
      win: parseArtifacts('win', data.win)
    }
  }
}

// A universal macOS build runs on either architecture.
function artifactFor(manifest: Manifest): Artifact | null {
  const platform = currentPlatform()
  if (!platform) return null
  const artifacts = manifest.artifacts[platform]
  return artifacts[process.arch] ?? (platform === 'mac' ? artifacts.universal : undefined) ?? null
}

// The artifact and its release info, once the manifest is verified. Held for the download.
let latest: { release: ReleaseInfo; artifact: Artifact | null } | null = null

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'ready') return getUpdateStatus()
  const key = publicKey()
  if (!key) return getUpdateStatus()
  attemptedAt = Date.now()
  setState({ phase: 'checking' })
  try {
    const [manifestBytes, signatureBytes] = await Promise.all([
      fetchLimited(`${LATEST_URL}/release.json`, MAX_MANIFEST),
      fetchLimited(`${LATEST_URL}/release.json.sig`, MAX_SIGNATURE)
    ])
    const signature = Buffer.from(signatureBytes.toString('utf8').trim(), 'base64')
    if (signature.length !== 64 || !verify(null, manifestBytes, key, signature)) {
      throw new Error('The release’s signature doesn’t match. It was not installed.')
    }
    const manifest = parseManifest(manifestBytes)
    checkedAt = Date.now()
    // Never offer the same version or an older one, even when it is signed.
    if (compareVersions(manifest.version, app.getVersion()) <= 0) {
      latest = null
      setState({ phase: 'current' })
      return getUpdateStatus()
    }
    // A copy that only links to the release can still say it exists, build or no build.
    const artifact = artifactFor(manifest)
    if (!artifact && installMode().mode !== 'link') {
      throw new Error(`Zook ${manifest.version} has no build for this system (${process.platform} ${process.arch}).`)
    }
    const release: ReleaseInfo = {
      version: manifest.version,
      date: manifest.date,
      notes: manifest.notes,
      url: `${RELEASES_URL}/tag/v${manifest.version}`,
      size: artifact?.size ?? null
    }
    latest = { release, artifact }
    setState({ phase: 'available', release })
  } catch (err) {
    setState({ phase: 'error', message: `Couldn't check for updates: ${messageOf(err)}` })
  }
  return getUpdateStatus()
}

function messageOf(err: unknown): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'the request timed out.'
  return err instanceof Error ? err.message : String(err)
}

// The AppImage downloads next to the running one, so the final rename stays on one filesystem and is
// atomic; the running copy keeps working, since its mount holds the old file open. Installers download
// to their own folder, which is cleared first so old ones don't pile up.
export async function downloadUpdate(): Promise<UpdateStatus> {
  if (!latest || state.phase === 'downloading' || state.phase === 'ready') return getUpdateStatus()
  const { release, artifact } = latest
  const { mode, reason } = installMode()
  const appImage = appImagePath()
  if (mode === 'link' || !artifact || (mode === 'appimage' && !appImage)) {
    setState({ phase: 'error', message: reason || 'This system can’t install the update itself.', release })
    return getUpdateStatus()
  }
  const controller = new AbortController()
  download = controller
  installer = null
  setState({ phase: 'downloading', release, received: 0 })

  let target: string
  let tmp: string
  if (mode === 'appimage') {
    target = appImage!
    tmp = join(dirname(target), `.${basename(target)}.update-${process.pid}`)
  } else {
    const dir = join(app.getPath('userData'), 'updates')
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    await mkdir(dir, { recursive: true })
    target = join(dir, artifact.file)
    tmp = `${target}.part`
  }

  let stall: NodeJS.Timeout | null = null
  const resetStall = () => {
    if (stall) clearTimeout(stall)
    stall = setTimeout(() => controller.abort(new Error('the download stalled.')), STALL_TIMEOUT)
  }
  const file = await open(tmp, 'w', 0o600)
  try {
    resetStall()
    const url = `${RELEASES_URL}/download/v${release.version}/${encodeURIComponent(artifact.file)}`
    const res = await net.fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`GitHub responded with ${res.status}.`)
    const hash = createHash('sha512')
    const reader = res.body.getReader()
    let received = 0
    let reported = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      resetStall()
      received += value.byteLength
      if (received > artifact.size) throw new Error('The download is larger than the release says.')
      hash.update(value)
      await file.write(value)
      if (Date.now() - reported > 250) {
        reported = Date.now()
        setState({ phase: 'downloading', release, received })
      }
    }
    if (received !== artifact.size) throw new Error('The download was cut short.')
    if (hash.digest('base64') !== artifact.sha512) throw new Error('The download doesn’t match the signed release.')
    await file.sync()
    await file.close()
    await chmod(tmp, mode === 'appimage' ? 0o755 : 0o700)
    await rename(tmp, target)
    if (mode === 'installer') installer = { path: target, artifact }
    setState({ phase: 'ready', release })
  } catch (err) {
    await file.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    const reason = controller.signal.aborted ? controller.signal.reason : err
    setState(
      reason === 'cancelled'
        ? { phase: 'available', release }
        : { phase: 'error', message: `Couldn't download the update: ${messageOf(reason)}`, release }
    )
  } finally {
    if (stall) clearTimeout(stall)
    download = null
  }
  return getUpdateStatus()
}

function sha512Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')))
      .on('error', reject)
  })
}

export function cancelDownload() {
  download?.abort('cancelled')
}

// Finishes the update, quitting so pending history and chats are saved first. The AppImage is already
// in place and is started again. An installer is checked once more, since it sat on disk since the
// download, then opened: the .dmg in Finder to drag into Applications, the setup .exe to run.
export async function installUpdate(): Promise<UpdateStatus> {
  if (state.phase !== 'ready') return getUpdateStatus()
  const release = state.release
  const appImage = appImagePath()
  if (!installer) {
    if (!appImage) return getUpdateStatus()
    app.relaunch({ execPath: appImage, args: process.argv.slice(1) })
    app.quit()
    return getUpdateStatus()
  }
  const { path, artifact } = installer
  try {
    if ((await sha512Of(path)) !== artifact.sha512) {
      installer = null
      throw new Error('the downloaded installer has changed since it was checked. Download it again.')
    }
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(path, [], { detached: true, stdio: 'ignore' })
        child.once('error', reject)
        child.once('spawn', () => {
          child.unref()
          resolve()
        })
      })
    } else {
      const error = await shell.openPath(path)
      if (error) throw new Error(error)
    }
  } catch (err) {
    setState({ phase: 'error', message: `Couldn't open the installer: ${messageOf(err)}`, release })
    return getUpdateStatus()
  }
  app.quit()
  return getUpdateStatus()
}

function schedule() {
  if (timer) clearTimeout(timer)
  timer = null
  if (!options?.getAuto() || !app.isPackaged || !publicKey()) return
  const since = attemptedAt ? Date.now() - attemptedAt : Infinity
  timer = setTimeout(
    () => {
      timer = null
      checkForUpdates().finally(schedule)
    },
    since >= CHECK_INTERVAL ? FIRST_CHECK_DELAY : CHECK_INTERVAL - since
  )
}

export function startUpdater(opts: { getAuto: () => boolean; onChange: (status: UpdateStatus) => void }) {
  options = opts
  schedule()
}

// Call after the automatic-check setting changes.
export function rescheduleUpdates() {
  schedule()
  options?.onChange(getUpdateStatus())
}

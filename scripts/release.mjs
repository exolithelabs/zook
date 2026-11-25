#!/usr/bin/env node
// Signs Zook releases for the in-app updater.
//
//   npm run release:keygen                      Make the signing key pair (once).
//   npm run release:sign -- [--notes "text" | --notes-file path] [--dir path]
//                                               Write release.json and its signature for the builds in dist/.
//
// Each platform is built on its own OS (`npm run dist` on Linux, macOS and Windows). Gather the
// AppImages, the macOS .dmg and .zip files and the Windows setup .exe files in one folder (dist/
// by default) before signing, since release.json describes them all and is signed once.
//
// The private key lives outside the repo, at $ZOOK_RELEASE_KEY or ~/.config/zook-release/ed25519.pem.
// Keep a backup of it: losing it means installed copies can no longer update themselves.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const keyFile = 'src/main/update-key.ts'
const keyPath = process.env.ZOOK_RELEASE_KEY || join(homedir(), '.config', 'zook-release', 'ed25519.pem')

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

function rawPublicKey(key) {
  return Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64')
}

function embeddedPublicKey() {
  const match = readFileSync(join(root, keyFile), 'utf8').match(/UPDATE_PUBLIC_KEY = '([^']*)'/)
  if (!match) fail(`couldn't find UPDATE_PUBLIC_KEY in ${keyFile}`)
  return match[1]
}

function writeEmbeddedPublicKey(value) {
  const path = join(root, keyFile)
  const source = readFileSync(path, 'utf8').replace(/UPDATE_PUBLIC_KEY = '[^']*'/, `UPDATE_PUBLIC_KEY = '${value}'`)
  writeFileSync(path, source)
}

function keygen() {
  if (existsSync(keyPath)) fail(`${keyPath} already exists; refusing to replace it`)
  if (embeddedPublicKey() && !process.argv.includes('--force')) {
    fail(
      `${keyFile} already has a public key. A new one stops installed copies from trusting new releases;` +
        ' pass --force if that is really what you want.'
    )
  }
  const { privateKey } = generateKeyPairSync('ed25519')
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
  writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' })
  writeEmbeddedPublicKey(rawPublicKey(privateKey))
  console.log(`Private key: ${keyPath} (back it up somewhere safe, and never commit it)`)
  console.log(`Public key written to ${keyFile}. Commit it, then build and sign releases with it.`)
}

function option(name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return undefined
  const value = process.argv[i + 1]
  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value`)
  return value
}

// electron-builder names files after the architecture, Node's way (x64, arm64) or Linux's (x86_64, aarch64);
// the app asks by Node's. Null when the name has none.
function archOf(file) {
  const name = file.replace(/\.(AppImage|dmg|zip|exe)$/i, '')
  if (/[-_.](?:x86_64|x64|amd64)$/i.test(name)) return 'x64'
  if (/[-_.](?:aarch64|arm64)$/i.test(name)) return 'arm64'
  if (/[-_.]armv7l$/i.test(name)) return 'armv7l'
  if (/[-_.]universal$/i.test(name)) return 'universal'
  return null
}

// What each platform's updater downloads, and the archs a file without one in its name is for:
// electron-builder leaves x64 out of default names, and a multi-arch NSIS installer covers both.
const platforms = {
  linux: { ext: '.AppImage', label: 'Linux AppImage', unnamed: ['x64'] },
  mac: { ext: '.dmg', label: 'macOS dmg', unnamed: ['x64'] },
  win: { ext: '.exe', label: 'Windows installer', unnamed: ['x64', 'arm64'] }
}
// The app only accepts plain file names, which also keeps the download URLs simple.
const SAFE_NAME = /^[\w.-]+$/

function sha512(path) {
  return new Promise((done, reject) => {
    const hash = createHash('sha512')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => done(hash.digest('base64')))
      .on('error', reject)
  })
}

async function signRelease() {
  if (!existsSync(keyPath)) fail(`no private key at ${keyPath}; run npm run release:keygen first`)
  const privateKey = createPrivateKey(readFileSync(keyPath))
  const publicKey = rawPublicKey(privateKey)
  if (publicKey !== embeddedPublicKey()) {
    fail(`${keyPath} doesn't match the public key in ${keyFile}, so the app would reject this release`)
  }

  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const distDir = resolve(root, option('--dir') ?? 'dist')
  const files = existsSync(distDir)
    ? readdirSync(distDir).filter((f) => f.includes(`-${version}`) && statSync(join(distDir, f)).isFile())
    : []

  async function describe(file) {
    if (!SAFE_NAME.test(file)) fail(`${file} has characters the app won't accept in a file name; rename it`)
    const path = join(distDir, file)
    return { file, size: statSync(path).size, sha512: await sha512(path) }
  }

  const platformEntries = {}
  const assets = []
  for (const [platform, { ext, unnamed }] of Object.entries(platforms)) {
    const entries = {}
    const builds = files.filter((f) => f.endsWith(ext))
    for (const file of builds.filter(archOf)) {
      const arch = archOf(file)
      if (entries[arch]) fail(`both ${entries[arch].file} and ${file} look like ${platform} ${arch} builds`)
      entries[arch] = await describe(file)
    }
    // A build without an arch in its name covers the rest.
    const unnamedBuilds = builds.filter((f) => !archOf(f))
    if (unnamedBuilds.length > 1) fail(`can't tell ${unnamedBuilds.join(' and ')} apart; put the arch in their names`)
    for (const file of unnamedBuilds) {
      for (const arch of unnamed) entries[arch] ??= await describe(file)
    }
    assets.push(...builds)
    // macOS also ships a .zip of the app beside each .dmg. It is listed (and checksummed) with it.
    if (platform === 'mac') {
      for (const file of files.filter((f) => f.endsWith('.zip'))) {
        const arch = archOf(file) ?? 'x64'
        if (!entries[arch]) fail(`${file} has no matching .dmg`)
        entries[arch].zip = await describe(file)
        assets.push(file)
      }
    }
    if (Object.keys(entries).length) platformEntries[platform] = entries
  }
  if (assets.length === 0) fail(`no builds for ${version} in ${distDir}; run npm run dist first`)

  const notesFile = option('--notes-file')
  const notes = notesFile ? readFileSync(notesFile, 'utf8').trim() : (option('--notes') ?? '')
  const manifest = Buffer.from(
    JSON.stringify({ schema: 1, version, date: new Date().toISOString(), notes, ...platformEntries }, null, 2) + '\n'
  )
  const signature = sign(null, manifest, privateKey)
  // Check it the way the app will, against the key it ships with.
  const embedded = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey, 'base64').toString('base64url') },
    format: 'jwk'
  })
  if (!verify(null, manifest, embedded, signature)) fail('the signature failed to verify')

  writeFileSync(join(distDir, 'release.json'), manifest)
  writeFileSync(join(distDir, 'release.json.sig'), signature.toString('base64') + '\n')

  for (const [platform, { label }] of Object.entries(platforms)) {
    const entries = Object.entries(platformEntries[platform] ?? {})
    if (entries.length === 0) console.warn(`warning: no ${label}; that platform won't be offered this update`)
    for (const [arch, a] of entries) {
      console.log(`${platform} ${arch}: ${a.file} (${a.size} bytes)${a.zip ? ` + ${a.zip.file}` : ''}`)
    }
  }
  const dir = relative(root, distDir) || '.'
  console.log(`Wrote ${dir}/release.json and ${dir}/release.json.sig. Publish them with the builds, e.g.:`)
  const uploads = [...assets, 'release.json', 'release.json.sig'].map((f) => `${dir}/${f}`).join(' ')
  console.log(`  gh release create v${version} --repo exolithelabs/zook --title "Zook ${version}" ${uploads}`)
}

const command = process.argv[2]
if (command === 'keygen') keygen()
else if (command === 'sign') await signRelease()
else fail('usage: release.mjs keygen [--force] | sign [--notes "text" | --notes-file path] [--dir path]')

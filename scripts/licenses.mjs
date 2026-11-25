// Collects the license notices of everything Zook ships into out/licenses/, after `electron-vite build`:
//
//   notices.json              Zook's own license and every third-party package's, for Settings → Licenses.
//   THIRD_PARTY_NOTICES.txt   The same, as plain text.
//   LICENSE                   Zook's license.
//   LICENSE.electron.txt      Electron's license.
//   LICENSES.chromium.html    Chromium's, Node.js's and the rest of Electron's bundled code's, from Electron.
//
// What ships is the production dependencies, which electron-builder copies in from node_modules, plus
// any package whose code Vite bundled into out/ (such as the Svelte runtime). The `bundledPackages`
// plugin below records the latter while building.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out', 'licenses')
// Where the plugin leaves its lists of bundled package folders, one per build target.
const bundledDir = join(root, 'out', '.bundled-packages')

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-_.].*)?$/i
const NOTICE_FILE = /^notice/i
// Vite's module ids use forward slashes on every OS.
const IN_NODE_MODULES = /[\\/]node_modules[\\/]/

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// The folder of the package a file belongs to: the nearest package.json with a name and version.
// Some packages have nested package.json files that only set "type", which this skips.
function packageDirOf(file) {
  for (let dir = dirname(file); IN_NODE_MODULES.test(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = readJson(manifest)
    if (pkg.name && pkg.version) return dir
  }
  return null
}

// A Vite plugin recording which packages' code made it into the bundle (after tree shaking).
export function bundledPackages() {
  let name = 'bundle'
  const dirs = new Set()
  return {
    name: 'zook-bundled-packages',
    apply: 'build',
    generateBundle(options, bundle) {
      name = basename(options.dir ?? name)
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        for (const [id, info] of Object.entries(chunk.modules)) {
          if (id.startsWith('\0') || info.renderedLength === 0) continue
          const file = id.split('?')[0]
          if (!IN_NODE_MODULES.test(file)) continue
          const dir = packageDirOf(file)
          if (dir) dirs.add(dir)
        }
      }
    },
    writeBundle() {
      mkdirSync(bundledDir, { recursive: true })
      writeFileSync(join(bundledDir, `${name}.json`), JSON.stringify([...dirs].sort(), null, 2))
    }
  }
}

// Node's own lookup: the nearest node_modules folder, from `from` up to the project root, that has it.
function resolvePackage(name, from) {
  for (let dir = from; dir.startsWith(root); dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === root) break
  }
  return null
}

// Every package `dependencies` pulls in, transitively, the way electron-builder will copy them.
function productionPackages() {
  const found = new Set()
  const visit = (dir) => {
    const pkg = readJson(join(dir, 'package.json'))
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies }
    for (const name of Object.keys(deps)) {
      const dep = resolvePackage(name, dir)
      if (!dep) {
        if (!pkg.optionalDependencies?.[name]) throw new Error(`${pkg.name} depends on ${name}, which isn't installed`)
        continue
      }
      if (found.has(dep)) continue
      found.add(dep)
      visit(dep)
    }
  }
  visit(root)
  return found
}

function bundledPackageDirs() {
  if (!existsSync(bundledDir)) throw new Error('No bundle info found; run `electron-vite build` first.')
  const dirs = new Set()
  for (const file of readdirSync(bundledDir)) {
    for (const dir of readJson(join(bundledDir, file))) dirs.add(dir)
  }
  return dirs
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license?.type) return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ')
  return 'UNKNOWN'
}

function urlOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const url = pkg.homepage || repo
  if (!url) return undefined
  const https = url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git(#.*)?$/, '')
  if (/^https?:\/\//.test(https)) return https
  // "owner/repo" shorthand means GitHub.
  return /^[\w.-]+\/[\w.-]+$/.test(https) ? `https://github.com/${https}` : undefined
}

// License files first, then NOTICE files, which Apache-2.0 asks to be passed on too.
function licenseText(dir) {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((f) => f.isFile() && LICENSE_FILE.test(f.name))
    .map((f) => f.name)
    .sort((a, b) => Number(NOTICE_FILE.test(a)) - Number(NOTICE_FILE.test(b)) || a.localeCompare(b))
  return files.map((f) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim()).join('\n\n')
}

function main() {
  const app = readJson(join(root, 'package.json'))
  const electronDir = resolvePackage('electron', root)
  if (!electronDir) throw new Error('electron is not installed')
  const electron = readJson(join(electronDir, 'package.json'))

  const dirs = new Set([...productionPackages(), ...bundledPackageDirs()])
  const byId = new Map()
  for (const dir of dirs) {
    const pkg = readJson(join(dir, 'package.json'))
    const id = `${pkg.name}@${pkg.version}`
    if (pkg.name === app.name || byId.has(id)) continue
    const text = licenseText(dir)
    byId.set(id, {
      name: pkg.name,
      version: pkg.version,
      license: licenseOf(pkg),
      url: urlOf(pkg),
      // A few packages ship no license file; their declared license is all there is to show.
      text: text || `${pkg.name} declares the ${licenseOf(pkg)} license but includes no license file.`
    })
  }
  const packages = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const appLicense = readFileSync(join(root, 'LICENSE'), 'utf8')
  const electronLicense = readFileSync(join(electronDir, 'dist', 'LICENSE'), 'utf8')
  writeFileSync(join(outDir, 'LICENSE'), appLicense)
  writeFileSync(join(outDir, 'LICENSE.electron.txt'), electronLicense)
  cpSync(join(electronDir, 'dist', 'LICENSES.chromium.html'), join(outDir, 'LICENSES.chromium.html'))

  writeFileSync(
    join(outDir, 'notices.json'),
    JSON.stringify({
      app: { name: app.build?.productName ?? app.name, version: app.version, license: app.license, text: appLicense },
      electron: { version: electron.version, license: electron.license, text: electronLicense },
      packages
    })
  )

  const rule = '-'.repeat(78)
  const sections = packages.map(
    (p) => `${rule}\n${p.name} ${p.version} (${p.license})${p.url ? `\n${p.url}` : ''}\n${rule}\n\n${p.text}\n`
  )
  writeFileSync(
    join(outDir, 'THIRD_PARTY_NOTICES.txt'),
    `${app.build?.productName ?? app.name} ${app.version} includes the following third-party software.\n` +
      `Electron ${electron.version}, Chromium and Node.js are covered by LICENSE.electron.txt and LICENSES.chromium.html.\n\n` +
      sections.join('\n')
  )

  rmSync(bundledDir, { recursive: true, force: true })
  console.log(`licenses: ${packages.length} packages, plus Electron ${electron.version}, written to out/licenses/`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.error(`licenses: ${err.message}`)
    process.exit(1)
  }
}

import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getProvider, providerIds, providerInfo, type ProviderId, type ProviderInfo } from './providers'

type StoredSecret = { data: string; encrypted: boolean }
type StoredSettings = {
  activeProvider?: ProviderId
  // Each provider's fields, stored as one JSON string (encrypted when possible).
  credentials?: Partial<Record<ProviderId, StoredSecret>>
  adblock?: boolean
  // Optional Brave Autosuggest key for online search suggestions.
  suggestKey?: StoredSecret
  // Written by the first version, which only supported Brave.
  braveApiKey?: StoredSecret
}

type Credentials = Record<string, string>

export type ProviderStatus = ProviderInfo & {
  // Where this provider's credentials come from: saved in settings, the .env fallback, or nowhere.
  source: 'settings' | 'env' | 'none'
  hint: string
}

export type SettingsStatus = {
  active: ProviderId
  canEncrypt: boolean
  providers: ProviderStatus[]
  adblock: boolean
  suggest: { source: 'settings' | 'env' | 'none'; hint: string }
}

const settingsPath = () => join(app.getPath('userData'), 'settings.json')

function readSettings(): StoredSettings {
  let settings: StoredSettings
  try {
    settings = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  } catch {
    return {}
  }
  if (settings.braveApiKey) {
    const key = decrypt(settings.braveApiKey)
    delete settings.braveApiKey
    if (key && !settings.credentials?.brave) {
      settings.credentials = { ...settings.credentials, brave: encrypt(JSON.stringify({ apiKey: key })) }
    }
    writeSettings(settings)
  }
  return settings
}

function writeSettings(settings: StoredSettings) {
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2), { mode: 0o600 })
}

// On Linux without a keyring, safeStorage falls back to a hardcoded password,
// which is no better than plain text, so only treat it as encryption when it really is.
function canEncrypt(): boolean {
  return (
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  )
}

function encrypt(value: string): StoredSecret {
  return canEncrypt()
    ? { data: safeStorage.encryptString(value).toString('base64'), encrypted: true }
    : { data: value, encrypted: false }
}

function decrypt(secret: StoredSecret): string | undefined {
  try {
    return secret.encrypted ? safeStorage.decryptString(Buffer.from(secret.data, 'base64')) : secret.data
  } catch {
    return undefined
  }
}

function isComplete(id: ProviderId, creds: Credentials | undefined): creds is Credentials {
  return Boolean(creds) && getProvider(id).fields.every((f) => creds![f.id]?.trim())
}

function savedCredentials(id: ProviderId, settings = readSettings()): Credentials | undefined {
  const secret = settings.credentials?.[id]
  if (!secret) return undefined
  try {
    const creds = JSON.parse(decrypt(secret) ?? '')
    return isComplete(id, creds) ? creds : undefined
  } catch {
    return undefined
  }
}

function envCredentials(id: ProviderId): Credentials | undefined {
  const creds = Object.fromEntries(getProvider(id).fields.map((f) => [f.id, process.env[f.env] ?? '']))
  return isComplete(id, creds) ? creds : undefined
}

export function getCredentials(id: ProviderId): Credentials | undefined {
  return savedCredentials(id) ?? envCredentials(id)
}

export function getActiveProvider(): ProviderId {
  const active = readSettings().activeProvider
  if (active && providerIds.includes(active)) return active
  return providerIds.find((id) => getCredentials(id)) ?? 'brave'
}

export function setActiveProvider(id: ProviderId) {
  getProvider(id)
  const settings = readSettings()
  settings.activeProvider = id
  writeSettings(settings)
}

export function saveCredentials(id: ProviderId, creds: Credentials) {
  const settings = readSettings()
  settings.credentials = { ...settings.credentials, [id]: encrypt(JSON.stringify(creds)) }
  // Switch to the new provider if the current one can't be used.
  const active = settings.activeProvider
  if (!active || !(savedCredentials(active, settings) ?? envCredentials(active))) {
    settings.activeProvider = id
  }
  writeSettings(settings)
}

export function clearCredentials(id: ProviderId) {
  const settings = readSettings()
  if (settings.credentials) delete settings.credentials[id]
  writeSettings(settings)
}

export function getAdblock(): boolean {
  return readSettings().adblock ?? true
}

export function setAdblock(enabled: boolean) {
  const settings = readSettings()
  settings.adblock = enabled
  writeSettings(settings)
}

function savedSuggestKey(settings = readSettings()): string | undefined {
  return settings.suggestKey ? decrypt(settings.suggestKey) : undefined
}

export function getSuggestKey(): string | undefined {
  return savedSuggestKey() || process.env.BRAVE_SUGGEST_API_KEY || undefined
}

export function saveSuggestKey(key: string) {
  const settings = readSettings()
  settings.suggestKey = encrypt(key)
  writeSettings(settings)
}

export function clearSuggestKey() {
  const settings = readSettings()
  delete settings.suggestKey
  writeSettings(settings)
}

export function getStatus(): SettingsStatus {
  const settings = readSettings()
  const suggestSaved = savedSuggestKey(settings)
  const suggestKey = suggestSaved || process.env.BRAVE_SUGGEST_API_KEY
  return {
    adblock: settings.adblock ?? true,
    suggest: {
      source: suggestSaved ? 'settings' : suggestKey ? 'env' : 'none',
      hint: suggestKey ? `••••${suggestKey.slice(-4)}` : ''
    },
    active: getActiveProvider(),
    canEncrypt: canEncrypt(),
    providers: providerInfo().map((info) => {
      const saved = savedCredentials(info.id, settings)
      const creds = saved ?? envCredentials(info.id)
      const secretField = info.fields.find((f) => f.secret)
      const secret = secretField && creds?.[secretField.id]
      return {
        ...info,
        source: saved ? 'settings' : creds ? 'env' : 'none',
        hint: secret ? `••••${secret.slice(-4)}` : ''
      }
    })
  }
}

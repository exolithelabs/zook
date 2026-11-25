import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  chatPresets,
  chatProtocols,
  getChatPreset,
  isChatProtocol,
  normalizeBaseUrl,
  presetForUrl,
  type ChatConfig,
  type ChatPreset,
  type ChatProtocol
} from './chat'
import { getProvider, providerIds, providerInfo, type ProviderId, type ProviderInfo } from './providers'
import { readStore, writeStore, type Migration } from './store'

type StoredSecret = { data: string; encrypted: boolean }
type StoredSettings = {
  activeProvider?: ProviderId
  // Each provider's fields, stored as one JSON string (encrypted when possible).
  credentials?: Partial<Record<ProviderId, StoredSecret>>
  adblock?: boolean
  // Whether the chat sidebar was last left open.
  sidebarOpen?: boolean
  // Whether AI chats may search the web. Kept apart from `chat`, which is cleared with the backend.
  chatGrounded?: boolean
  // Optional Brave Autosuggest key for online search suggestions.
  suggestKey?: StoredSecret
  // AI chat backends by id (see chatEntries). Only API keys are secret.
  chatBackends?: Record<string, StoredChatBackend>
  // The backend chats use. Falls back to the first one set up.
  activeChat?: string
  // Whether to check GitHub for new releases in the background.
  autoUpdate?: boolean
}

// `preset` may name one that no longer exists. `name` and `protocol` are for custom backends.
type StoredChatBackend = {
  preset: string
  name?: string
  protocol?: string
  baseUrl: string
  model: string
  apiKey?: StoredSecret
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
  sidebarOpen: boolean
  suggest: { source: 'settings' | 'env' | 'none'; hint: string }
  chat: {
    // The backend chats use, or null when none is set up.
    active: string | null
    // Built-in backends, set up or not, then custom ones.
    backends: ChatBackendStatus[]
    protocols: { id: ChatProtocol; name: string }[]
    // Search the web first and cite the results, when a search provider is set up.
    grounded: boolean
  }
}

export type ChatBackendStatus = {
  id: string
  name: string
  custom: boolean
  protocol: ChatProtocol
  // The saved endpoint and model, or the preset's defaults when not set up.
  baseUrl: string
  defaultBaseUrl: string
  model: string
  needsKey: boolean
  note?: string
  signupUrl?: string
  source: 'settings' | 'env' | 'none'
  hint: string
}

const settingsPath = () => join(app.getPath('userData'), 'settings.json')

const migrations: Migration[] = [
  // v1: the first version only supported Brave, with its key stored on its own.
  ({ braveApiKey, ...settings }) => {
    const key = braveApiKey ? decrypt(braveApiKey) : undefined
    if (key && !settings.credentials?.brave) {
      settings.credentials = { ...settings.credentials, brave: encrypt(JSON.stringify({ apiKey: key })) }
    }
    return settings
  },
  // v2: one AI chat backend became a list of them, keyed by id.
  ({ chat, ...settings }) => {
    if (chat?.baseUrl && chat.model) {
      const preset = getChatPreset(chat.preset)
      const custom = preset.id === 'custom'
      const id = custom ? newCustomId() : preset.id
      settings.chatBackends = {
        [id]: { ...chat, preset: preset.id, ...(custom && { name: hostOf(chat.baseUrl), protocol: 'openai' }) }
      }
      settings.activeChat = id
    }
    return settings
  }
]

function readSettings(): StoredSettings {
  return readStore<StoredSettings>({ path: settingsPath(), migrations }) ?? {}
}

function writeSettings(settings: StoredSettings) {
  writeStore(settingsPath(), migrations.length, settings)
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

export function setChatGrounded(grounded: boolean) {
  const settings = readSettings()
  settings.chatGrounded = grounded
  writeSettings(settings)
}

export function setSidebarOpen(open: boolean) {
  const settings = readSettings()
  settings.sidebarOpen = open
  writeSettings(settings)
}

export function getAutoUpdate(): boolean {
  return readSettings().autoUpdate ?? true
}

export function setAutoUpdate(enabled: boolean) {
  const settings = readSettings()
  settings.autoUpdate = enabled
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

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// Built-in backends are keyed by their preset id, custom ones by `custom-` and a random suffix.
const builtinPresets = chatPresets.filter((p) => p.id !== 'custom')
const CUSTOM_ID = /^custom-[\w-]{1,40}$/
// A custom endpoint set in .env shows as a custom backend of its own.
const ENV_CUSTOM_ID = 'custom-env'

function isChatBackendId(id: unknown): id is string {
  return typeof id === 'string' && (builtinPresets.some((p) => p.id === id) || CUSTOM_ID.test(id))
}

function newCustomId(): string {
  return `custom-${randomUUID().slice(0, 8)}`
}

function presetFor(id: string): ChatPreset {
  return CUSTOM_ID.test(id) ? getChatPreset('custom') : getChatPreset(id)
}

function storedChatConfig(id: string, stored: StoredChatBackend | undefined): ChatConfig | undefined {
  if (!stored?.baseUrl || !stored.model) return undefined
  const preset = presetFor(id)
  const custom = preset.id === 'custom'
  return {
    preset: preset.id,
    protocol: custom && isChatProtocol(stored.protocol) ? stored.protocol : preset.protocol,
    baseUrl: stored.baseUrl,
    model: stored.model,
    apiKey: stored.apiKey ? decrypt(stored.apiKey) : undefined,
    name: custom ? stored.name || hostOf(stored.baseUrl) : undefined
  }
}

function envChatBackend(): { id: string; config: ChatConfig } | undefined {
  const baseUrl = normalizeBaseUrl(process.env.ZOOK_CHAT_BASE_URL ?? '')
  if (!baseUrl) return undefined
  const preset = getChatPreset(presetForUrl(baseUrl))
  const model = process.env.ZOOK_CHAT_MODEL?.trim() || preset.model
  if (!model) return undefined
  const apiKey = process.env.ZOOK_CHAT_API_KEY?.trim() || undefined
  const custom = preset.id === 'custom'
  return {
    id: custom ? ENV_CUSTOM_ID : preset.id,
    config: { preset: preset.id, protocol: preset.protocol, baseUrl, model, apiKey, name: custom ? hostOf(baseUrl) : undefined }
  }
}

type ChatEntry = { config: ChatConfig; source: 'settings' | 'env' }

// Every backend that's set up, by id: built-ins in preset order, then custom ones in the order
// they were added. Saved settings win over .env.
function chatEntries(settings = readSettings()): Map<string, ChatEntry> {
  const entries = new Map<string, ChatEntry>()
  const env = envChatBackend()
  const ids = [
    ...builtinPresets.map((p) => p.id as string),
    ...Object.keys(settings.chatBackends ?? {}).filter((id) => CUSTOM_ID.test(id)),
    ENV_CUSTOM_ID
  ]
  for (const id of ids) {
    if (entries.has(id)) continue
    const saved = storedChatConfig(id, settings.chatBackends?.[id])
    if (saved) entries.set(id, { config: saved, source: 'settings' })
    else if (env?.id === id) entries.set(id, { config: env.config, source: 'env' })
  }
  return entries
}

function activeChatId(settings = readSettings(), entries = chatEntries(settings)): string | null {
  const active = settings.activeChat
  if (active && entries.has(active)) return active
  return entries.keys().next().value ?? null
}

export function getChatConfig(): ChatConfig | undefined {
  const settings = readSettings()
  const entries = chatEntries(settings)
  const id = activeChatId(settings, entries)
  return id ? entries.get(id)?.config : undefined
}

export function setActiveChat(id: string) {
  const settings = readSettings()
  if (!isChatBackendId(id) || !chatEntries(settings).has(id)) throw new Error('Set up this backend first.')
  settings.activeChat = id
  writeSettings(settings)
}

// What the settings form sends. `name` and `protocol` only count for custom backends.
export type ChatForm = { name?: string; protocol?: string; baseUrl: string; model?: string; apiKey: string }

function checkBaseUrl(baseUrl: string): string {
  baseUrl = normalizeBaseUrl(baseUrl)
  if (!/^https?:\/\/[^/]/i.test(baseUrl)) throw new Error('Enter a base URL starting with http:// or https://.')
  return baseUrl
}

// A blank key keeps the backend's saved one, but only for the same base URL, so a key is never
// sent to a server it wasn't entered for. A null id is a new custom backend.
function formConfig(id: string | null, form: ChatForm): ChatConfig {
  if (id !== null && !isChatBackendId(id)) throw new Error('Unknown backend.')
  const preset = id === null ? getChatPreset('custom') : presetFor(id)
  const custom = preset.id === 'custom'
  const baseUrl = checkBaseUrl(String(form.baseUrl ?? ''))
  const protocol = custom ? form.protocol : preset.protocol
  if (!isChatProtocol(protocol)) throw new Error('Pick an API format.')
  const existing = id === null ? undefined : chatEntries().get(id)?.config
  const apiKey = String(form.apiKey ?? '').trim() || (existing?.baseUrl === baseUrl ? existing.apiKey : undefined)
  const name = custom ? String(form.name ?? '').trim().slice(0, 60) || hostOf(baseUrl) : undefined
  return { preset: preset.id, protocol, baseUrl, model: String(form.model ?? '').trim(), apiKey, name }
}

export function resolveChatConfig(id: string | null, form: ChatForm): ChatConfig {
  const config = formConfig(id, form)
  if (!config.model) throw new Error('Enter a model.')
  if (!config.apiKey && getChatPreset(config.preset).needsKey) throw new Error('Enter the API key.')
  return config
}

// Enough of a config to list models with: no model is needed.
export function resolveChatListConfig(id: string | null, form: ChatForm): ChatConfig {
  return formConfig(id, { ...form, model: '' })
}

// Saves under `id`, or as a new custom backend, and returns the id used. Like search providers,
// the backend is switched to when the current one can't be used.
export function saveChatConfig(id: string | null, config: ChatConfig): string {
  const settings = readSettings()
  const key = id ?? newCustomId()
  settings.chatBackends = {
    ...settings.chatBackends,
    [key]: {
      preset: config.preset,
      name: config.name,
      protocol: config.preset === 'custom' ? config.protocol : undefined,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey ? encrypt(config.apiKey) : undefined
    }
  }
  const active = settings.activeChat
  if (!active || !chatEntries(settings).has(active)) settings.activeChat = key
  writeSettings(settings)
  return key
}

export function clearChatConfig(id: string) {
  const settings = readSettings()
  if (settings.chatBackends) delete settings.chatBackends[id]
  if (settings.activeChat === id) delete settings.activeChat
  writeSettings(settings)
}

function chatStatus(settings: StoredSettings): SettingsStatus['chat'] {
  const entries = chatEntries(settings)
  const status = (id: string, preset: ChatPreset, entry: ChatEntry | undefined): ChatBackendStatus => ({
    id,
    name: entry?.config.name ?? preset.name,
    custom: preset.id === 'custom',
    protocol: entry?.config.protocol ?? preset.protocol,
    baseUrl: entry?.config.baseUrl ?? preset.baseUrl,
    defaultBaseUrl: preset.baseUrl,
    model: entry?.config.model ?? preset.model,
    needsKey: preset.needsKey,
    note: preset.note,
    signupUrl: preset.signupUrl,
    source: entry?.source ?? 'none',
    hint: entry?.config.apiKey ? `••••${entry.config.apiKey.slice(-4)}` : ''
  })
  const customs = [...entries].filter(([id]) => CUSTOM_ID.test(id))
  return {
    active: activeChatId(settings, entries),
    backends: [
      ...builtinPresets.map((p) => status(p.id, p, entries.get(p.id))),
      ...customs.map(([id, entry]) => status(id, getChatPreset('custom'), entry))
    ],
    protocols: chatProtocols,
    grounded: settings.chatGrounded ?? true
  }
}

export function getStatus(): SettingsStatus {
  const settings = readSettings()
  const suggestSaved = savedSuggestKey(settings)
  const suggestKey = suggestSaved || process.env.BRAVE_SUGGEST_API_KEY
  return {
    adblock: settings.adblock ?? true,
    sidebarOpen: settings.sidebarOpen ?? true,
    suggest: {
      source: suggestSaved ? 'settings' : suggestKey ? 'env' : 'none',
      hint: suggestKey ? `••••${suggestKey.slice(-4)}` : ''
    },
    chat: chatStatus(settings),
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

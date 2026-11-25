export type ChatPresetId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'xai'
  | 'deepseek'
  | 'openrouter'
  | 'opencode-go'
  | 'ollama'
  | 'custom'

// The wire format a backend speaks. Most speak OpenAI's chat completions; Anthropic and
// Gemini are used through their own native APIs.
export type ChatProtocol = 'openai' | 'anthropic' | 'gemini'

export type ChatPreset = {
  id: ChatPresetId
  name: string
  protocol: ChatProtocol
  baseUrl: string
  model: string
  needsKey: boolean
  signupUrl?: string
  note?: string
  // Header that carries a stable per-conversation id, for backends that ask for one.
  sessionHeader?: string
  // A cheap authenticated endpoint to check the key, when the protocol's default isn't.
  verifyUrl?: string
}

export const chatPresets: ChatPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    signupUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-5-5',
    needsKey: true,
    signupUrl: 'https://platform.claude.com/settings/keys',
    note: 'Use a key scoped to a workspace.'
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.8-flash',
    needsKey: true,
    signupUrl: 'https://aistudio.google.com/apikey'
  },
  {
    id: 'xai',
    name: 'xAI',
    protocol: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4.7',
    needsKey: true,
    signupUrl: 'https://console.x.ai/',
    note: 'Grok reasons before answering, so replies can take a moment to start.'
  },
  {
    // DeepSeek documents its OpenAI-compatible base URL without /v1.
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    needsKey: true,
    signupUrl: 'https://platform.deepseek.com/api_keys',
    note: 'Thinking mode is on by default, so replies can take a moment to start.'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    needsKey: true,
    signupUrl: 'https://openrouter.ai/keys',
    note: 'openrouter/auto picks a model per request; any model slug works.'
  },
  {
    // Go's Chat Completions path. OpenCode translates for models whose native API is
    // Messages or Responses, so every Go text model works here. Go rejects requests that
    // lack a per-conversation session header, and its model list is public, so the key is
    // checked against the usage endpoint instead.
    id: 'opencode-go',
    name: 'OpenCode Go',
    protocol: 'openai',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    model: 'glm-5.3',
    needsKey: true,
    signupUrl: 'https://opencode.ai/console/go',
    note: 'Needs a Console API key from a workspace subscribed to Go. Any Go model id works.',
    sessionHeader: 'x-opencode-session',
    verifyUrl: 'https://opencode.ai/inference/go/v1/usage'
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    needsKey: false,
    note: 'Runs on this computer. Pull the model first, e.g. `ollama pull llama3.2`.'
  },
  {
    id: 'custom',
    name: 'Custom',
    protocol: 'openai',
    baseUrl: '',
    model: '',
    needsKey: false,
    note: 'Any OpenAI-compatible endpoint.'
  }
]

const customPreset = chatPresets[chatPresets.length - 1]

// Ids no longer offered, such as the removed "groq" and "parallel", resolve to Custom,
// so a saved setup keeps working with its URL, model and key unchanged.
export function getChatPreset(id: string): ChatPreset {
  return chatPresets.find((p) => p.id === id) ?? customPreset
}

export function presetForUrl(baseUrl: string): ChatPresetId {
  const url = normalizeBaseUrl(baseUrl)
  // DeepSeek also accepts its base URL with /v1 appended.
  return chatPresets.find((p) => p.baseUrl && (url === p.baseUrl || url === `${p.baseUrl}/v1`))?.id ?? 'custom'
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
}

export type ChatConfig = { preset: ChatPresetId; baseUrl: string; model: string; apiKey?: string }

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

// Finish reasons use OpenAI's names whatever the protocol: stop, length, content_filter, ...
type StreamEvent = { text: string; finish?: string }

type Protocol = {
  request(config: ChatConfig, messages: ChatMessage[]): { url: string; headers: Record<string, string>; body: unknown }
  // A cheap authenticated GET that checks the key without spending tokens.
  verify(config: ChatConfig): { url: string; headers: Record<string, string> }
  // The model list, and how to read chat model ids out of its response.
  models(config: ChatConfig): { url: string; headers: Record<string, string>; ids(body: any): string[] }
  // Whether a failed verify response means the setup is wrong (vs. an endpoint that doesn't exist).
  verifyFails(status: number): boolean
  // Reads one SSE data payload; throws for error events.
  parse(event: any): StreamEvent
}

// Some backends (OpenCode Go) ask clients to name themselves rather than send a generic
// HTTP-library user agent.
let userAgent = 'Zook'
export function setChatUserAgent(value: string) {
  userAgent = value
}

const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_MAX_TOKENS = 8192

export function backendName(config: ChatConfig): string {
  if (config.preset !== 'custom') return getChatPreset(config.preset).name
  try {
    return new URL(config.baseUrl).host
  } catch {
    return config.baseUrl
  }
}

// Native APIs take the system prompt separately and want turns that alternate, starting
// with the user. Consecutive turns from one side (e.g. around a failed reply) are merged.
function splitSystem(messages: ChatMessage[]): { system: string; turns: { role: 'user' | 'assistant'; content: string }[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const turns: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of messages) {
    if (m.role === 'system' || (turns.length === 0 && m.role === 'assistant')) continue
    const last = turns.at(-1)
    if (last?.role === m.role) last.content += `\n\n${m.content}`
    else turns.push({ role: m.role, content: m.content })
  }
  return { system, turns }
}

function geminiModelPath(config: ChatConfig): string {
  return `${config.baseUrl}/models/${encodeURIComponent(config.model.replace(/^models\//, ''))}`
}

const protocols: Record<ChatProtocol, Protocol> = {
  openai: {
    request(config, messages) {
      return {
        url: `${config.baseUrl}/chat/completions`,
        headers: openaiHeaders(config),
        body: { model: config.model, messages, stream: true }
      }
    },
    verify(config) {
      return { url: `${config.baseUrl}/models`, headers: openaiHeaders(config) }
    },
    models(config) {
      return {
        url: `${config.baseUrl}/models`,
        headers: openaiHeaders(config),
        ids: (body) => (body?.data ?? []).map((m: any) => m?.id)
      }
    },
    // Some compatible servers don't implement /models, so only auth failures count.
    verifyFails: () => false,
    parse(event) {
      if (event.error) throw new Error(errorText(event.error))
      const choice = event.choices?.[0]
      if (choice) return { text: choice.delta?.content ?? '', finish: choice.finish_reason ?? undefined }
      return { text: '' }
    }
  },

  anthropic: {
    request(config, messages) {
      const { system, turns } = splitSystem(messages)
      return {
        url: `${config.baseUrl}/messages`,
        headers: anthropicHeaders(config),
        body: { model: config.model, max_tokens: ANTHROPIC_MAX_TOKENS, system, messages: turns, stream: true }
      }
    },
    verify(config) {
      return { url: `${config.baseUrl}/models/${encodeURIComponent(config.model)}`, headers: anthropicHeaders(config) }
    },
    models(config) {
      return {
        url: `${config.baseUrl}/models?limit=1000`,
        headers: anthropicHeaders(config),
        ids: (body) => (body?.data ?? []).map((m: any) => m?.id)
      }
    },
    // A 404 here means the model id is wrong.
    verifyFails: (status) => status === 404,
    parse(event) {
      switch (event.type) {
        case 'content_block_delta':
          // Thinking and tool-input deltas aren't part of the visible reply.
          return { text: event.delta?.type === 'text_delta' ? (event.delta.text ?? '') : '' }
        case 'message_delta': {
          const reason = event.delta?.stop_reason
          if (!reason) return { text: '' }
          const finish: Record<string, string> = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', refusal: 'content_filter' }
          return { text: '', finish: finish[reason] ?? reason }
        }
        case 'error':
          if (event.error?.type === 'overloaded_error') throw new Error('Anthropic is overloaded right now. Try again shortly.')
          throw new Error(errorText(event.error))
        default:
          // message_start, content_block_start/stop, message_stop, ping
          return { text: '' }
      }
    }
  },

  gemini: {
    request(config, messages) {
      const { system, turns } = splitSystem(messages)
      return {
        url: `${geminiModelPath(config)}:streamGenerateContent?alt=sse`,
        headers: geminiHeaders(config),
        body: {
          ...(system && { systemInstruction: { parts: [{ text: system }] } }),
          contents: turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] }))
        }
      }
    },
    verify(config) {
      return { url: geminiModelPath(config), headers: geminiHeaders(config) }
    },
    verifyFails: (status) => status === 404,
    models(config) {
      return {
        url: `${config.baseUrl}/models?pageSize=1000`,
        headers: geminiHeaders(config),
        ids: (body) =>
          (body?.models ?? [])
            .filter((m: any) => m?.supportedGenerationMethods?.includes('generateContent'))
            .map((m: any) => String(m?.name ?? '').replace(/^models\//, ''))
      }
    },
    parse(event) {
      if (event.error) throw new Error(errorText(event.error))
      if (event.promptFeedback?.blockReason) {
        throw new Error(`Gemini blocked this prompt (${event.promptFeedback.blockReason}).`)
      }
      const candidate = event.candidates?.[0]
      const text = (candidate?.content?.parts ?? [])
        .filter((p: any) => !p.thought && typeof p.text === 'string')
        .map((p: any) => p.text)
        .join('')
      const reason: string | undefined = candidate?.finishReason
      let finish: string | undefined
      if (reason === 'STOP') finish = 'stop'
      else if (reason === 'MAX_TOKENS') finish = 'length'
      else if (reason && reason !== 'FINISH_REASON_UNSPECIFIED') finish = 'content_filter'
      return { text, finish }
    }
  }
}

function openaiHeaders(config: ChatConfig): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
}

function anthropicHeaders(config: ChatConfig): Record<string, string> {
  return { 'x-api-key': config.apiKey ?? '', 'anthropic-version': ANTHROPIC_VERSION }
}

// The key goes in a header rather than the ?key= query parameter, so it stays out of URLs.
function geminiHeaders(config: ChatConfig): Record<string, string> {
  return { 'x-goog-api-key': config.apiKey ?? '' }
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : 'The model returned an error.'
}

async function errorDetail(res: Response): Promise<string> {
  try {
    let body = await res.json()
    // Gemini's OpenAI-compatible endpoint wraps its error object in an array.
    if (Array.isArray(body)) body = body[0]
    const candidate = body?.error?.message ?? body?.error ?? body?.message ?? body?.detail
    return typeof candidate === 'string' ? candidate : ''
  } catch {
    return ''
  }
}

// Gemini reports a bad key as 400 "API key not valid" rather than 401.
function isAuthFailure(status: number, detail: string): boolean {
  return status === 401 || status === 403 || (status === 400 && /api[ _-]?key|unauthori[sz]ed|authenticat/i.test(detail))
}

function statusError(name: string, status: number, detail: string): Error {
  // A 403 can explain itself, e.g. OpenCode Go's "no active Go subscription".
  if (status === 403 && detail) return new Error(`${name} refused this key: ${detail}`)
  if (isAuthFailure(status, detail)) return new Error(`${name} rejected your API key. Check it in Settings.`)
  if (status === 402) return new Error(`Your ${name} account is out of credits.`)
  if (status === 404) {
    return new Error(`${name} doesn't recognize that model or URL. Check it in Settings.${detail ? ` (${detail})` : ''}`)
  }
  if (status === 429) return new Error(`${name} rate limit reached. Try again shortly.`)
  return new Error(`${name} request failed (${status})${detail ? `: ${detail}` : ''}`)
}

function connectError(name: string, config: ChatConfig, err: unknown): Error {
  if (err instanceof Error && err.name === 'AbortError') return err
  const hint = config.preset === 'ollama' ? ' Is Ollama running?' : ''
  return new Error(`Couldn't reach ${name}.${hint}`)
}

export async function verifyChatConfig(config: ChatConfig): Promise<void> {
  const name = backendName(config)
  const preset = getChatPreset(config.preset)
  const protocol = protocols[preset.protocol]
  const check = protocol.verify(config)
  // The preset's own check URL is only used with its own base URL, so a key is never sent
  // to a host other than the one configured.
  const url = preset.verifyUrl && config.baseUrl === preset.baseUrl ? preset.verifyUrl : check.url
  let res: Response
  try {
    res = await fetch(url, { headers: { ...check.headers, 'User-Agent': userAgent }, signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    throw connectError(name, config, err)
  }
  if (res.ok) return
  const detail = await errorDetail(res)
  if (isAuthFailure(res.status, detail) || protocol.verifyFails(res.status)) throw statusError(name, res.status, detail)
}

// OpenAI-style lists mix in models that can't chat.
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|transcri|realtime|audio|image|rerank/i

// The backend's chat models, sorted by id.
export async function listChatModels(config: ChatConfig): Promise<string[]> {
  const name = backendName(config)
  const list = protocols[getChatPreset(config.preset).protocol].models(config)
  let res: Response
  try {
    res = await fetch(list.url, { headers: { ...list.headers, 'User-Agent': userAgent }, signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    throw connectError(name, config, err)
  }
  if (!res.ok) throw statusError(name, res.status, await errorDetail(res))
  const ids: unknown[] = list.ids(await res.json().catch(() => null))
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== '' && !NOT_CHAT.test(id)))].sort()
}

// Reads a server-sent event stream, calling onData with each event's data. Stops early when
// onData returns true. Events may be split across reads at any byte.
async function readSse(body: ReadableStream<Uint8Array>, onData: (data: string) => boolean | void): Promise<void> {
  let buffer = ''
  let data: string[] = []
  // An event is one or more `data:` lines ended by a blank line.
  const dispatch = (): boolean => {
    const payload = data.join('\n')
    data = []
    return payload ? onData(payload) === true : false
  }
  const handleLine = (line: string): boolean => {
    if (line === '') return dispatch()
    if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5))
    // Comments (`: keep-alive`) and other fields such as `event:` carry nothing we need;
    // Anthropic repeats the event name as `type` in the data.
    return false
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      // A trailing \r may be the first half of a \r\n split across reads.
      const held = !done && buffer.endsWith('\r') ? '\r' : ''
      const lines = buffer.slice(0, buffer.length - held.length).split(/\r\n|\r|\n/)
      // The last piece may be a partial line; keep it for the next read.
      buffer = done ? '' : lines.pop()! + held
      for (const line of lines) {
        if (handleLine(line)) return
      }
      if (done) {
        dispatch()
        return
      }
    }
  } finally {
    // Frees the connection when the stream ends early, e.g. at [DONE] or on an error.
    reader.cancel().catch(() => {})
  }
}

// Streams one reply, calling onDelta for each piece of text. Resolves with the finish reason.
export async function streamChat(
  config: ChatConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (text: string) => void,
  // Stable for one conversation; sent only to presets that ask for it.
  sessionId?: string
): Promise<string> {
  const name = backendName(config)
  const preset = getChatPreset(config.preset)
  const protocol = protocols[preset.protocol]
  const { url, headers, body } = protocol.request(config, messages)
  if (preset.sessionHeader && sessionId) headers[preset.sessionHeader] = sessionId
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'text/event-stream', 'User-Agent': userAgent },
      body: JSON.stringify(body),
      signal
    })
  } catch (err) {
    throw connectError(name, config, err)
  }
  if (!res.ok) throw statusError(name, res.status, await errorDetail(res))
  if (!res.body) throw new Error(`${name} sent an empty response.`)

  // An OpenAI-compatible server that ignores `stream: true` answers with one JSON body.
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = await res.json()
    if (data.error) throw new Error(errorText(data.error))
    const choice = data.choices?.[0]
    onDelta(choice?.message?.content ?? '')
    return choice?.finish_reason ?? 'stop'
  }

  let finishReason = 'stop'
  await readSse(res.body, (payload) => {
    if (payload === '[DONE]') return true
    let event: unknown
    try {
      event = JSON.parse(payload)
    } catch {
      return false
    }
    const { text, finish } = protocol.parse(event)
    if (text) onDelta(text)
    if (finish) finishReason = finish
    return false
  })
  return finishReason
}

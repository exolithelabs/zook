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
    note: 'Any endpoint that speaks one of the APIs below.'
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

export const chatProtocols: { id: ChatProtocol; name: string }[] = [
  { id: 'openai', name: 'OpenAI-compatible' },
  { id: 'anthropic', name: 'Anthropic Messages' },
  { id: 'gemini', name: 'Google Gemini' }
]

export function isChatProtocol(value: unknown): value is ChatProtocol {
  return chatProtocols.some((p) => p.id === value)
}

// `protocol` follows the preset for built-in backends; a custom one picks its own. `name` is
// what a custom backend was called.
export type ChatConfig = {
  preset: ChatPresetId
  protocol: ChatProtocol
  baseUrl: string
  model: string
  apiKey?: string
  name?: string
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

// A tool the model may call, described with a JSON schema for its arguments.
export type ChatTool = { name: string; description: string; parameters: Record<string, unknown> }

export type ToolCall = { id: string; name: string; args: Record<string, unknown> }
export type ToolResult = { id: string; name: string; content: string }

// One step of a conversation with tools, in no particular protocol's shape. An assistant turn
// that called tools keeps what the protocol needs echoed back: DeepSeek's reasoning and
// Gemini's raw parts, which carry thought signatures.
type AgentItem =
  | ChatMessage
  | { role: 'assistant'; content: string; calls: ToolCall[]; reasoning?: string; parts?: unknown[] }
  | { role: 'tool'; results: ToolResult[] }

// Finish reasons use OpenAI's names whatever the protocol: stop, length, content_filter, tool_calls, ...
type StreamEvent = { text: string; finish?: string }

// Collects the parts of one streamed turn that aren't visible text.
type TurnState = {
  // Tool calls by stream index, with their arguments still as JSON text.
  calls: Map<number, { id: string; name: string; json: string }>
  reasoning: string
  parts: unknown[]
}

type Protocol = {
  // `final` asks for an answer without further tool calls, while still describing the tools
  // the history refers to.
  request(
    config: ChatConfig,
    items: AgentItem[],
    tools: ChatTool[],
    final: boolean
  ): { url: string; headers: Record<string, string>; body: unknown }
  // A cheap authenticated GET that checks the key without spending tokens.
  verify(config: ChatConfig): { url: string; headers: Record<string, string> }
  // The model list, and how to read chat model ids out of its response.
  models(config: ChatConfig): { url: string; headers: Record<string, string>; ids(body: any): string[] }
  // Whether a failed verify response means the setup is wrong (vs. an endpoint that doesn't exist).
  verifyFails(status: number): boolean
  // Reads one SSE data payload into the turn; throws for error events.
  parse(event: any, turn: TurnState): StreamEvent
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
  if (config.name) return config.name
  try {
    return new URL(config.baseUrl).host
  } catch {
    return config.baseUrl
  }
}

type NativeTurn<Part> = { role: 'user' | 'assistant'; parts: Part[] }

// Native APIs take the system prompt separately and want turns that alternate, starting
// with the user. Consecutive turns from one side (e.g. around a failed reply, or tool results
// before a question) are merged.
function splitSystem<Part>(
  items: AgentItem[],
  toParts: (item: Exclude<AgentItem, { role: 'system' }>) => Part[]
): { system: string; turns: NativeTurn<Part>[] } {
  const system = items
    .filter((m): m is ChatMessage => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const turns: NativeTurn<Part>[] = []
  for (const item of items) {
    if (item.role === 'system' || (turns.length === 0 && item.role === 'assistant')) continue
    const role = item.role === 'tool' ? 'user' : item.role
    const parts = toParts(item)
    if (parts.length === 0) continue
    const last = turns.at(-1)
    if (last?.role === role) last.parts.push(...parts)
    else turns.push({ role, parts })
  }
  return { system, turns }
}

function geminiModelPath(config: ChatConfig): string {
  return `${config.baseUrl}/models/${encodeURIComponent(config.model.replace(/^models\//, ''))}`
}

function openaiMessages(items: AgentItem[]): unknown[] {
  return items.flatMap((item): unknown[] => {
    if (item.role === 'tool') {
      return item.results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.content }))
    }
    if (!('calls' in item)) return [item]
    return [
      {
        role: 'assistant',
        content: item.content || null,
        tool_calls: item.calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) }
        })),
        // DeepSeek's thinking mode wants its reasoning back while it's still using tools.
        ...(item.reasoning && { reasoning_content: item.reasoning })
      }
    ]
  })
}

function anthropicParts(item: Exclude<AgentItem, { role: 'system' }>): unknown[] {
  if (item.role === 'tool') {
    return item.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content }))
  }
  // Empty text blocks are rejected.
  const text = item.content.trim() ? [{ type: 'text', text: item.content }] : []
  if (!('calls' in item)) return text
  return [...text, ...item.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))]
}

function geminiParts(item: Exclude<AgentItem, { role: 'system' }>): unknown[] {
  if (item.role === 'tool') {
    return item.results.map((r) => ({
      functionResponse: { ...(!r.id.startsWith('zook_') && { id: r.id }), name: r.name, response: { content: r.content } }
    }))
  }
  const text = item.content.trim() ? [{ text: item.content }] : []
  if (!('calls' in item)) return text
  // The model's own parts go back as they came, thought signatures and all.
  return [...text, ...(item.parts ?? item.calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })))]
}

const protocols: Record<ChatProtocol, Protocol> = {
  openai: {
    request(config, items, tools, final) {
      return {
        url: `${config.baseUrl}/chat/completions`,
        headers: openaiHeaders(config),
        body: {
          model: config.model,
          messages: openaiMessages(items),
          stream: true,
          ...(tools.length && {
            tools: tools.map((t) => ({ type: 'function', function: t })),
            tool_choice: final ? 'none' : 'auto'
          })
        }
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
    parse(event, turn) {
      if (event.error) throw new Error(errorText(event.error))
      const choice = event.choices?.[0]
      if (!choice) return { text: '' }
      const delta = choice.delta ?? {}
      if (typeof delta.reasoning_content === 'string') turn.reasoning += delta.reasoning_content
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const key = typeof tc.index === 'number' ? tc.index : turn.calls.size
        let call = turn.calls.get(key)
        if (!call) turn.calls.set(key, (call = { id: '', name: '', json: '' }))
        if (tc.id) call.id = tc.id
        if (tc.function?.name) call.name ||= tc.function.name
        const args = tc.function?.arguments
        // Ollama sends arguments whole, as an object.
        if (typeof args === 'string') call.json += args
        else if (args && typeof args === 'object') call.json = JSON.stringify(args)
      }
      return { text: delta.content ?? '', finish: choice.finish_reason ?? undefined }
    }
  },

  anthropic: {
    request(config, items, tools, final) {
      const { system, turns } = splitSystem(items, anthropicParts)
      return {
        url: `${config.baseUrl}/messages`,
        headers: anthropicHeaders(config),
        body: {
          model: config.model,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          system,
          messages: turns.map((t) => ({ role: t.role, content: t.parts })),
          stream: true,
          ...(tools.length && {
            tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
            tool_choice: { type: final ? 'none' : 'auto' }
          })
        }
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
    parse(event, turn) {
      switch (event.type) {
        case 'content_block_start':
          if (event.content_block?.type === 'tool_use') {
            turn.calls.set(event.index, { id: event.content_block.id ?? '', name: event.content_block.name ?? '', json: '' })
          }
          return { text: '' }
        case 'content_block_delta': {
          if (event.delta?.type === 'input_json_delta') {
            const call = turn.calls.get(event.index)
            if (call) call.json += event.delta.partial_json ?? ''
          }
          // Thinking deltas aren't part of the visible reply.
          return { text: event.delta?.type === 'text_delta' ? (event.delta.text ?? '') : '' }
        }
        case 'message_delta': {
          const reason = event.delta?.stop_reason
          if (!reason) return { text: '' }
          const finish: Record<string, string> = {
            end_turn: 'stop',
            stop_sequence: 'stop',
            max_tokens: 'length',
            refusal: 'content_filter',
            tool_use: 'tool_calls'
          }
          return { text: '', finish: finish[reason] ?? reason }
        }
        case 'error':
          if (event.error?.type === 'overloaded_error') throw new Error('Anthropic is overloaded right now. Try again shortly.')
          throw new Error(errorText(event.error))
        default:
          // message_start, content_block_stop, message_stop, ping
          return { text: '' }
      }
    }
  },

  gemini: {
    request(config, items, tools, final) {
      const { system, turns } = splitSystem(items, geminiParts)
      return {
        url: `${geminiModelPath(config)}:streamGenerateContent?alt=sse`,
        headers: geminiHeaders(config),
        body: {
          ...(system && { systemInstruction: { parts: [{ text: system }] } }),
          contents: turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: t.parts })),
          ...(tools.length && {
            tools: [{ functionDeclarations: tools }],
            toolConfig: { functionCallingConfig: { mode: final ? 'NONE' : 'AUTO' } }
          })
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
    parse(event, turn) {
      if (event.error) throw new Error(errorText(event.error))
      if (event.promptFeedback?.blockReason) {
        throw new Error(`Gemini blocked this prompt (${event.promptFeedback.blockReason}).`)
      }
      const candidate = event.candidates?.[0]
      const parts: any[] = candidate?.content?.parts ?? []
      for (const part of parts) {
        if (!part.functionCall) continue
        // Calls arrive whole, one part each.
        turn.calls.set(turn.calls.size, {
          id: typeof part.functionCall.id === 'string' ? part.functionCall.id : '',
          name: part.functionCall.name ?? '',
          json: JSON.stringify(part.functionCall.args ?? {})
        })
        turn.parts.push(part)
      }
      const text = parts
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
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
  const protocol = protocols[config.protocol]
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
  const list = protocols[config.protocol].models(config)
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

// A backend that turned down the tools themselves, as some local and compatible servers do.
export class ToolsUnsupportedError extends Error {}

type Turn = { text: string; finish: string; calls: ToolCall[]; reasoning: string; parts: unknown[] }

function toolCalls(turn: TurnState): ToolCall[] {
  return [...turn.calls.values()]
    .filter((c) => c.name)
    .map((c, i) => {
      let args: unknown
      try {
        args = c.json.trim() ? JSON.parse(c.json) : {}
      } catch {
        args = {}
      }
      return {
        // Gemini and some compatible servers leave ids out; ours are never sent back as theirs.
        id: c.id || `zook_${i}`,
        name: c.name,
        args: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
      }
    })
}

// Streams one model turn, calling onDelta for each piece of visible text.
async function streamTurn(
  config: ChatConfig,
  items: AgentItem[],
  tools: ChatTool[],
  final: boolean,
  signal: AbortSignal,
  onDelta: (text: string) => void,
  sessionId?: string
): Promise<Turn> {
  const name = backendName(config)
  const preset = getChatPreset(config.preset)
  const protocol = protocols[config.protocol]
  const { url, headers, body } = protocol.request(config, items, tools, final)
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
  if (!res.ok) {
    const detail = await errorDetail(res)
    if (tools.length && (res.status === 400 || res.status === 422) && /tool|function/i.test(detail)) {
      throw new ToolsUnsupportedError(detail)
    }
    throw statusError(name, res.status, detail)
  }
  if (!res.body) throw new Error(`${name} sent an empty response.`)

  const state: TurnState = { calls: new Map(), reasoning: '', parts: [] }

  // An OpenAI-compatible server that ignores `stream: true` answers with one JSON body.
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = await res.json()
    if (data.error) throw new Error(errorText(data.error))
    const choice = data.choices?.[0]
    const message = choice?.message ?? {}
    protocol.parse({ choices: [{ delta: { ...message, content: '' } }] }, state)
    const text = message.content ?? ''
    if (text) onDelta(text)
    return { text, finish: choice?.finish_reason ?? 'stop', calls: toolCalls(state), reasoning: state.reasoning, parts: [] }
  }

  let finish = 'stop'
  let text = ''
  // Some OpenAI-compatible servers (seen on NVIDIA's API) start every piece with the previous
  // piece again. That's decided from the first two pieces, then the repeat is cut from each one.
  let echoes: boolean | undefined
  let last = ''
  await readSse(res.body, (payload) => {
    if (payload === '[DONE]') return true
    let event: unknown
    try {
      event = JSON.parse(payload)
    } catch {
      return false
    }
    const parsed = protocol.parse(event, state)
    let piece = parsed.text
    if (piece && config.protocol === 'openai') {
      if (echoes === undefined && last) echoes = piece.length > last.length && piece.startsWith(last)
      if (echoes && piece.startsWith(last)) piece = piece.slice(last.length)
      last = piece
    }
    if (piece) {
      text += piece
      onDelta(piece)
    }
    if (parsed.finish) finish = parsed.finish
    return false
  })
  return { text, finish, calls: toolCalls(state), reasoning: state.reasoning, parts: state.parts }
}

// Enough rounds to search, read a page or two and search again, without running away.
const MAX_TOOL_ROUNDS = 6

export type ChatHandlers = {
  onDelta(text: string): void
  // Runs the calls the model made in one round. Results come back in the same order.
  runTools(calls: ToolCall[]): Promise<ToolResult[]>
}

// Streams a reply, letting the model call tools between rounds of text. Resolves with the
// finish reason of the last round. With no tools this is a single streamed reply.
export async function runChat(
  config: ChatConfig,
  messages: ChatMessage[],
  tools: ChatTool[],
  signal: AbortSignal,
  handlers: ChatHandlers,
  // Stable for one conversation; sent only to presets that ask for it.
  sessionId?: string
): Promise<string> {
  const items: AgentItem[] = [...messages]
  let wrote = false
  for (let round = 0; ; round++) {
    const final = round >= MAX_TOOL_ROUNDS
    // Text from a later round starts its own paragraph.
    let gap = wrote
    const turn = await streamTurn(
      config,
      items,
      tools,
      final,
      signal,
      (text) => {
        if (gap) {
          gap = false
          if (!/^\s/.test(text)) text = `\n\n${text}`
        }
        wrote = true
        handlers.onDelta(text)
      },
      sessionId
    )
    // Some servers ignore a request for no more tool calls; whatever text there is stands.
    if (turn.calls.length === 0 || final) return turn.calls.length ? 'stop' : turn.finish
    items.push({ role: 'assistant', content: turn.text, calls: turn.calls, reasoning: turn.reasoning, parts: turn.parts })
    const results = await handlers.runTools(turn.calls)
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    items.push({ role: 'tool', results })
  }
}

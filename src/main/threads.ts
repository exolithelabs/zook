import { app } from 'electron'
import { join } from 'node:path'
import { getChatPreset, type ChatPresetId } from './chat'
import {
  MAX_PAGE_EXCERPT,
  MAX_POOL_PAGES,
  MAX_POOL_SOURCES,
  MAX_SNIPPET,
  type ChatContext,
  type ChatPage,
  type ChatSource
} from './research'
import { readStore, writeStore, type Migration } from './store'

// The model that wrote a reply, as it was configured at the time.
export type ChatBackend = { preset: ChatPresetId; name: string; model: string }

export type ThreadTurn = {
  role: 'user' | 'assistant'
  content: string
  at: number
  sources?: ChatSource[]
  // What the reply searched the web for.
  queries?: string[]
  error?: string
  backend?: ChatBackend
}

export type Thread = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  grounded: boolean
  // Sent to backends that ask for a stable per-conversation id.
  sessionId: string
  turns: ThreadTurn[]
  // What the chat has found so far, so follow-up questions can build on it.
  sources?: ChatSource[]
  pages?: ChatPage[]
}

export type ThreadSummary = { id: string; title: string; updatedAt: number; backend?: ChatBackend }

const MAX_THREADS = 200
const MAX_TURNS = 400
const MAX_CONTENT = 200_000
const MAX_TITLE = 120

const threadsPath = () => join(app.getPath('userData'), 'threads.json')

// Threads are cleaned on every load, so migrations only need to handle changes of shape.
const migrations: Migration[] = [
  // v1: the first versioned format, unchanged from the unversioned one.
  (data) => ({ threads: Array.isArray(data.threads) ? data.threads : [] })
]

// Newest first.
let threads: Thread[] | null = null
let saveTimer: NodeJS.Timeout | null = null

const ID = /^[\w-]{1,100}$/

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function time(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
}

export function titleFrom(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 80)
}

function cleanBackend(value: any): ChatBackend | undefined {
  if (typeof value?.model !== 'string' || typeof value.name !== 'string') return undefined
  return { preset: getChatPreset(value.preset).id, name: text(value.name, 200), model: text(value.model, 200) }
}

// Keeps the last `max` sources, with snippets only where `snippets` asks for them.
function cleanSources(value: unknown, max: number, snippets: boolean): ChatSource[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<number>()
  const sources = value
    .filter(
      (s) =>
        typeof s?.url === 'string' &&
        /^https?:/i.test(s.url) &&
        Number.isSafeInteger(s.n) &&
        s.n > 0 &&
        !seen.has(s.n) &&
        seen.add(s.n)
    )
    .slice(-max)
    .map((s) => {
      const source: ChatSource = {
        n: s.n,
        title: text(s.title, 500),
        url: text(s.url, 2000),
        displayUrl: text(s.displayUrl, 500),
        favicon: typeof s.favicon === 'string' ? s.favicon.slice(0, 2000) : undefined
      }
      if (snippets && typeof s.snippet === 'string' && s.snippet) source.snippet = s.snippet.slice(0, MAX_SNIPPET)
      return source
    })
  return sources.length ? sources : undefined
}

function cleanPages(value: unknown): ChatPage[] | undefined {
  if (!Array.isArray(value)) return undefined
  const pages = value
    .filter((p) => typeof p?.url === 'string' && /^https?:/i.test(p.url) && typeof p.text === 'string')
    .slice(-MAX_POOL_PAGES)
    .map((p) => ({ url: text(p.url, 2000), title: text(p.title, 500), text: text(p.text, MAX_PAGE_EXCERPT), at: time(p.at) }))
  return pages.length ? pages : undefined
}

// A chat's gathered context as the renderer sends it with a question.
export function cleanContext(value: any): ChatContext {
  return {
    sources: cleanSources(value?.sources, MAX_POOL_SOURCES, true) ?? [],
    pages: cleanPages(value?.pages) ?? []
  }
}

function cleanTurn(value: any): ThreadTurn | null {
  if (value?.role !== 'user' && value?.role !== 'assistant') return null
  const content = text(value.content, MAX_CONTENT)
  const error = text(value.error, 1000) || undefined
  // Replies that never got any text and didn't fail (e.g. cut off by a quit) aren't kept.
  if (!content.trim() && !error) return null
  const turn: ThreadTurn = { role: value.role, content, at: time(value.at) }
  if (error) turn.error = error
  if (value.role === 'assistant') {
    const sources = cleanSources(value.sources, 40, false)
    const backend = cleanBackend(value.backend)
    const queries = Array.isArray(value.queries)
      ? value.queries.filter((q: unknown) => typeof q === 'string' && q.trim()).slice(0, 12).map((q: string) => q.slice(0, 400))
      : []
    if (sources) turn.sources = sources
    if (queries.length) turn.queries = queries
    if (backend) turn.backend = backend
  }
  return turn
}

// Threads come from the renderer and from disk, so neither is trusted to be well-formed.
function cleanThread(value: any): Thread | null {
  if (typeof value?.id !== 'string' || !ID.test(value.id) || !Array.isArray(value.turns)) return null
  const turns = value.turns
    .map(cleanTurn)
    .filter((t: ThreadTurn | null): t is ThreadTurn => t !== null)
    .slice(-MAX_TURNS)
  if (turns.length === 0) return null
  const firstQuestion = turns.find((t: ThreadTurn) => t.role === 'user')?.content ?? ''
  const { sources, pages } = cleanContext(value)
  return {
    id: value.id,
    title: titleFrom(text(value.title, MAX_TITLE)) || titleFrom(firstQuestion) || 'New chat',
    createdAt: time(value.createdAt),
    updatedAt: time(value.updatedAt),
    grounded: value.grounded === true,
    sessionId: typeof value.sessionId === 'string' && ID.test(value.sessionId) ? value.sessionId : value.id,
    turns,
    ...(sources.length && { sources }),
    ...(pages.length && { pages })
  }
}

function load(): Thread[] {
  if (!threads) {
    const stored = readStore<{ threads?: unknown }>({ path: threadsPath(), migrations })
    threads = Array.isArray(stored?.threads)
      ? stored.threads.map(cleanThread).filter((t: Thread | null): t is Thread => t !== null)
      : []
  }
  return threads!
}

// Writes are batched so a busy conversation doesn't rewrite the file on every turn.
function save() {
  if (saveTimer) return
  saveTimer = setTimeout(flushThreads, 1000)
}

export function flushThreads() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (!threads) return
  writeStore(threadsPath(), migrations.length, { threads })
}

export function listThreads(): ThreadSummary[] {
  return load().map((t) => ({
    id: t.id,
    title: t.title,
    updatedAt: t.updatedAt,
    backend: t.turns.findLast((turn) => turn.backend)?.backend
  }))
}

export function getThread(id: string): Thread | null {
  return load().find((t) => t.id === id) ?? null
}

export function saveThread(value: unknown): ThreadSummary[] {
  const thread = cleanThread(value)
  if (thread) {
    threads = [thread, ...load().filter((t) => t.id !== thread.id)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_THREADS)
    save()
  }
  return listThreads()
}

// A blank title goes back to the one taken from the first question.
export function renameThread(id: string, title: unknown): ThreadSummary[] {
  const thread = getThread(id)
  if (thread) {
    const first = thread.turns.find((t) => t.role === 'user')?.content ?? ''
    thread.title = titleFrom(text(title, MAX_TITLE)) || titleFrom(first) || 'New chat'
    save()
  }
  return listThreads()
}

export function deleteThread(id: string): ThreadSummary[] {
  threads = load().filter((t) => t.id !== id)
  save()
  return listThreads()
}

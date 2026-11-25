import type { SettingsStatus } from '../../main/settings'
import type { Thread, ThreadSummary, ThreadTurn } from '../../main/threads'
import { errorMessage } from './errors'

// Whether a message searches the web first: the user wants it (Settings → AI chat), and there's a
// search provider to do it with. Read at send time, so changing the setting applies to the next message.
export function groundedFor(settings: SettingsStatus | null): boolean {
  return Boolean(settings?.chat.grounded && settings.providers.some((p) => p.id === settings.active && p.source !== 'none'))
}

export type ChatTurn = ThreadTurn & { status?: 'searching' | 'streaming' }

export type ChatThread = Omit<Thread, 'turns'> & {
  turns: ChatTurn[]
  // The reply being streamed, if any.
  requestId: string | null
}

// Which thread each in-flight reply belongs to, by request id.
const pending = new Map<string, string>()

function titleFrom(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80)
}

class Chats {
  // Saved conversations, newest first, as main last reported them.
  list = $state<ThreadSummary[]>([])
  currentId = $state<string | null>(null)
  // Threads held in memory: the one on screen, plus any still streaming a reply.
  private loaded = $state<Record<string, ChatThread>>({})
  private openToken = 0

  get current(): ChatThread | null {
    return this.currentId ? (this.loaded[this.currentId] ?? null) : null
  }

  busy(id: string): boolean {
    return Boolean(this.loaded[id]?.requestId)
  }

  async refresh() {
    this.list = await window.zook.threads.list()
  }

  // A chat only ever starts by asking its first question, so none is empty.
  ask(question: string, grounded: boolean): ChatThread {
    this.openToken++
    const now = Date.now()
    const id = crypto.randomUUID()
    this.loaded[id] = {
      id,
      title: '',
      createdAt: now,
      updatedAt: now,
      grounded,
      sessionId: crypto.randomUUID(),
      turns: [],
      requestId: null
    }
    this.select(id)
    const thread = this.loaded[id]
    this.send(thread, question, grounded)
    return thread
  }

  async open(id: string) {
    const token = ++this.openToken
    if (!this.loaded[id]) {
      const thread = await window.zook.threads.get(id)
      if (token !== this.openToken) return
      if (!thread) {
        this.refresh()
        return
      }
      this.loaded[id] = { ...thread, requestId: null }
    }
    this.select(id)
  }

  // A blank title goes back to the first question. The thread in memory is updated first,
  // so a reply finishing meanwhile saves the new title rather than the old one.
  async rename(id: string, title: string) {
    const thread = this.loaded[id]
    if (thread) thread.title = titleFrom(title) || titleFrom(thread.turns.find((t) => t.role === 'user')?.content ?? '')
    this.list = await window.zook.threads.rename(id, title)
  }

  async remove(id: string) {
    const thread = this.loaded[id]
    if (thread?.requestId) {
      if (thread.requestId !== 'starting') {
        window.zook.chat.abort(thread.requestId)
        pending.delete(thread.requestId)
      }
      // A request still starting sees this and aborts itself.
      thread.requestId = null
    }
    delete this.loaded[id]
    if (this.currentId === id) this.currentId = null
    this.list = await window.zook.threads.delete(id)
  }

  async send(thread: ChatThread, text: string, grounded: boolean) {
    text = text.trim()
    if (!text || thread.requestId) return
    // Failed or empty replies aren't sent back to the model as context.
    const history = thread.turns
      .filter((t) => t.content && !t.error)
      .map((t) => ({ role: t.role, content: t.content }))
    const now = Date.now()
    // Recorded on the thread so the saved copy says how it was last answered.
    thread.grounded = grounded
    thread.title ||= titleFrom(text)
    thread.updatedAt = now
    thread.turns.push({ role: 'user', content: text, at: now })
    thread.turns.push({ role: 'assistant', content: '', at: now, status: thread.grounded ? 'searching' : 'streaming' })
    const reply = thread.turns.at(-1)!
    // Marks the thread busy until main hands back the real id.
    thread.requestId = 'starting'
    // The question is saved straight away, so it survives even if the reply never arrives.
    this.persist(thread)
    try {
      const { requestId, backend } = await window.zook.chat.start(
        [...history, { role: 'user', content: text }],
        thread.grounded,
        thread.sessionId
      )
      if (thread.requestId !== 'starting') {
        // Stopped before the request id arrived.
        window.zook.chat.abort(requestId)
        return
      }
      thread.requestId = requestId
      reply.backend = backend
      pending.set(requestId, thread.id)
    } catch (e) {
      thread.requestId = null
      reply.status = undefined
      reply.error = errorMessage(e)
      this.persist(thread)
    }
  }

  // Asks the last question again in place of a reply that failed or was stopped.
  retry(thread: ChatThread, grounded: boolean) {
    const [question, reply] = thread.turns.slice(-2)
    if (thread.requestId || question?.role !== 'user' || reply?.role !== 'assistant' || !reply.error) return
    thread.turns.splice(-2, 2)
    this.send(thread, question.content, grounded)
  }

  stop(thread: ChatThread) {
    if (!thread.requestId) return
    if (thread.requestId !== 'starting') {
      window.zook.chat.abort(thread.requestId)
      pending.delete(thread.requestId)
    }
    thread.requestId = null
    const turn = thread.turns.at(-1)
    if (turn?.role === 'assistant') {
      turn.status = undefined
      if (!turn.content) turn.error = 'Stopped.'
    }
    this.persist(thread)
  }

  listen(): () => void {
    const offs = [
      window.zook.chat.onSources(({ requestId, sources }) => {
        const reply = this.replyFor(requestId)
        if (!reply) return
        reply.turn.sources = sources
        reply.turn.status = 'streaming'
      }),
      window.zook.chat.onDelta(({ requestId, text }) => {
        const reply = this.replyFor(requestId)
        if (!reply) return
        reply.turn.status = 'streaming'
        reply.turn.content += text
      }),
      window.zook.chat.onDone(({ requestId, finishReason }) => this.finish(requestId, finishNotes[finishReason])),
      window.zook.chat.onError(({ requestId, message }) => this.finish(requestId, message))
    ]
    return () => offs.forEach((off) => off())
  }

  // Makes a thread current and lets go of idle ones that are no longer shown.
  private select(id: string) {
    this.currentId = id
    for (const [other, thread] of Object.entries(this.loaded)) {
      if (other !== id && !thread.requestId) delete this.loaded[other]
    }
  }

  // The reply turn a stream event is for, looked up fresh so deleted threads are ignored.
  private replyFor(requestId: string): { thread: ChatThread; turn: ChatTurn } | null {
    const thread = this.loaded[pending.get(requestId) ?? '']
    const turn = thread?.turns.at(-1)
    if (!thread || thread.requestId !== requestId || turn?.role !== 'assistant') return null
    return { thread, turn }
  }

  private finish(requestId: string, error?: string) {
    const reply = this.replyFor(requestId)
    pending.delete(requestId)
    if (!reply) return
    reply.thread.requestId = null
    reply.turn.status = undefined
    if (error) reply.turn.error = error
    this.persist(reply.thread)
    // A reply that finished after its thread was left no longer needs to stay in memory.
    if (reply.thread.id !== this.currentId) delete this.loaded[reply.thread.id]
  }

  // Main keeps the stored copy; replies still streaming are saved once they finish.
  private persist(thread: ChatThread) {
    // A deleted thread isn't saved back, even if a reply for it was still on its way.
    if (thread.turns.length === 0 || this.loaded[thread.id] !== thread) return
    const { requestId: _, turns, ...rest } = $state.snapshot(thread)
    const saved: Thread = { ...rest, turns: turns.map(({ status: _, ...turn }) => turn) }
    window.zook.threads
      .save(saved)
      .then((list) => (this.list = list))
      .catch((e) => console.error('Could not save chat:', e))
  }
}

// Shown under a reply that ended for a reason other than finishing normally.
const finishNotes: Record<string, string> = {
  length: 'The reply was cut off at the model’s length limit.',
  content_filter: 'The provider’s safety filter stopped this reply.',
  insufficient_system_resource: 'The provider ran out of capacity mid-reply. Try again.'
}

export const chats = new Chats()

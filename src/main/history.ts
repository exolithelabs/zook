import { app } from 'electron'
import { join } from 'node:path'
import { readStore, writeStore, type Migration } from './store'

export type SearchEntry = { query: string; at: number }
export type VisitEntry = { url: string; title: string; at: number }
export type History = { searches: SearchEntry[]; visits: VisitEntry[] }

const MAX_SEARCHES = 500
const MAX_VISITS = 2000

const historyPath = () => join(app.getPath('userData'), 'history.json')

const migrations: Migration[] = [
  // v1: drop malformed entries, which unversioned files weren't checked for.
  (data) => ({
    searches: Array.isArray(data.searches)
      ? data.searches.filter((s: any) => typeof s?.query === 'string' && typeof s.at === 'number')
      : [],
    visits: Array.isArray(data.visits)
      ? data.visits
          .filter((v: any) => typeof v?.url === 'string' && typeof v.at === 'number')
          .map((v: any) => ({ url: v.url, title: typeof v.title === 'string' ? v.title : '', at: v.at }))
      : []
  })
]

let history: History | null = null
let saveTimer: NodeJS.Timeout | null = null

function load(): History {
  if (!history) {
    const stored = readStore<Partial<History>>({ path: historyPath(), migrations })
    // A file from a newer version may be shaped differently.
    history = {
      searches: Array.isArray(stored?.searches) ? stored.searches : [],
      visits: Array.isArray(stored?.visits) ? stored.visits : []
    }
  }
  return history
}

// Writes are batched so page loads don't hit the disk on every navigation.
function save() {
  if (saveTimer) return
  saveTimer = setTimeout(flushHistory, 1000)
}

export function flushHistory() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (!history) return
  writeStore(historyPath(), migrations.length, history)
}

export function addSearch(query: string) {
  const h = load()
  const key = query.trim().toLowerCase()
  h.searches = [
    { query: query.trim(), at: Date.now() },
    ...h.searches.filter((s) => s.query.toLowerCase() !== key)
  ].slice(0, MAX_SEARCHES)
  save()
}

export function addVisit(url: string, title: string) {
  if (!/^https?:/i.test(url)) return
  const h = load()
  const previous = h.visits.find((v) => v.url === url)
  h.visits = [
    { url, title: title || previous?.title || '', at: Date.now() },
    ...h.visits.filter((v) => v.url !== url)
  ].slice(0, MAX_VISITS)
  save()
}

export function updateVisitTitle(url: string, title: string) {
  const visit = load().visits.find((v) => v.url === url)
  if (visit && title && visit.title !== title) {
    visit.title = title
    save()
  }
}

export function getHistory(): History {
  return load()
}

export function removeSearch(query: string) {
  const h = load()
  h.searches = h.searches.filter((s) => s.query !== query)
  save()
}

export function removeVisit(url: string) {
  const h = load()
  h.visits = h.visits.filter((v) => v.url !== url)
  save()
}

export function clearHistory() {
  history = { searches: [], visits: [] }
  save()
}

export function suggestFromHistory(input: string) {
  const q = input.trim().toLowerCase()
  const h = load()
  if (!q) return { searches: h.searches.slice(0, 5).map((s) => s.query), pages: [] }
  const searches = h.searches
    .filter((s) => s.query.toLowerCase().includes(q) && s.query.toLowerCase() !== q)
    // Prefix matches first, then recency.
    .sort((a, b) => Number(b.query.toLowerCase().startsWith(q)) - Number(a.query.toLowerCase().startsWith(q)))
    .slice(0, 4)
    .map((s) => s.query)
  const pages = h.visits
    .filter((v) => v.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').includes(q) || v.title.toLowerCase().includes(q))
    .slice(0, 3)
  return { searches, pages }
}

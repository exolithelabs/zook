import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type SearchEntry = { query: string; at: number }
export type VisitEntry = { url: string; title: string; at: number }
export type History = { searches: SearchEntry[]; visits: VisitEntry[] }

const MAX_SEARCHES = 500
const MAX_VISITS = 2000

const historyPath = () => join(app.getPath('userData'), 'history.json')

let history: History | null = null
let saveTimer: NodeJS.Timeout | null = null

function load(): History {
  if (!history) {
    try {
      history = JSON.parse(readFileSync(historyPath(), 'utf8'))
    } catch {
      history = { searches: [], visits: [] }
    }
  }
  return history!
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
  const path = historyPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(history), { mode: 0o600 })
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

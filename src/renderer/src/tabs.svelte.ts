import type { TabState } from '../../main/index'
import type { SearchResult } from '../../main/providers'

export type SearchState = {
  query: string
  results: SearchResult[]
  page: number
  hasMore: boolean
  loading: boolean
  error: string
  // Ignores responses from searches that were superseded by a newer one.
  token: number
}

export type Tab = {
  id: number
  // A tab shows either its search page (home or results) or its web page.
  showing: 'search' | 'web'
  search: SearchState | null
  hasView: boolean
  web: TabState | null
  // URL being opened, shown until the page reports its own state.
  pendingUrl: string
}

type ClosedTab = { url?: string; query?: string }

let nextId = 1

class Tabs {
  list = $state<Tab[]>([])
  activeId = $state(0)
  private closed: ClosedTab[] = []

  constructor() {
    this.create()
  }

  get active(): Tab {
    return this.list.find((t) => t.id === this.activeId) ?? this.list[0]
  }

  get(id: number): Tab | undefined {
    return this.list.find((t) => t.id === id)
  }

  create(opts: { activate?: boolean; after?: Tab } = {}): Tab {
    const tab: Tab = { id: nextId++, showing: 'search', search: null, hasView: false, web: null, pendingUrl: '' }
    const index = opts.after ? this.list.indexOf(opts.after) + 1 : this.list.length
    this.list.splice(index, 0, tab)
    if (opts.activate ?? true) this.activeId = tab.id
    return this.get(tab.id)!
  }

  activate(id: number) {
    if (this.get(id)) this.activeId = id
  }

  activateIndex(index: number) {
    const tab = this.list.at(index)
    if (tab) this.activeId = tab.id
  }

  cycle(step: number) {
    const i = this.list.findIndex((t) => t.id === this.activeId)
    this.activeId = this.list[(i + step + this.list.length) % this.list.length].id
  }

  close(id: number) {
    const i = this.list.findIndex((t) => t.id === id)
    if (i === -1) return
    const tab = this.list[i]
    if (tab.showing === 'web' && tab.web?.url) this.closed.push({ url: tab.web.url })
    else if (tab.search?.query) this.closed.push({ query: tab.search.query })
    this.closed = this.closed.slice(-20)

    if (tab.hasView) window.zook.tabs.close(id)
    this.list.splice(i, 1)
    if (this.list.length === 0) this.create()
    else if (this.activeId === id) this.activeId = this.list[Math.min(i, this.list.length - 1)].id
  }

  popClosed(): ClosedTab | undefined {
    return this.closed.pop()
  }

  openUrl(tab: Tab, url: string, fresh = false) {
    tab.hasView = true
    tab.showing = 'web'
    tab.pendingUrl = url
    if (fresh) tab.web = null
    window.zook.tabs.open(tab.id, url, fresh)
  }

  canGoBack(tab: Tab): boolean {
    if (tab.showing === 'web') return Boolean(tab.web?.canGoBack || tab.search)
    return false
  }

  canGoForward(tab: Tab): boolean {
    if (tab.showing === 'search') return tab.hasView
    return Boolean(tab.web?.canGoForward)
  }

  // Back from a tab's first page returns to the search results it was opened from.
  back(tab: Tab) {
    if (tab.showing !== 'web') return
    if (tab.web?.canGoBack) window.zook.tabs.back(tab.id)
    else if (tab.search) tab.showing = 'search'
  }

  forward(tab: Tab) {
    if (tab.showing === 'search' && tab.hasView) tab.showing = 'web'
    else if (tab.web?.canGoForward) window.zook.tabs.forward(tab.id)
  }

  updateState(state: TabState) {
    const tab = this.get(state.tabId)
    if (!tab) return
    tab.web = state
    if (state.url) tab.pendingUrl = ''
  }
}

export const tabs = new Tabs()

export function tabTitle(tab: Tab): string {
  if (tab.showing === 'web') return tab.web?.title || tab.web?.url || tab.pendingUrl || 'Loading…'
  return tab.search?.query || 'New tab'
}

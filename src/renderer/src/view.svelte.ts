import type { PageState } from '../../main/index'
import type { SearchResult, Vertical } from '../../main/providers'

// How each result type is named wherever it's shown.
export const verticalLabels: Record<Vertical, string> = { web: 'All', news: 'News', images: 'Images', videos: 'Videos' }

export type SearchState = {
  query: string
  vertical: Vertical
  results: SearchResult[]
  page: number
  hasMore: boolean
  loading: boolean
  error: string
  // Ignores responses from searches that were superseded by a newer one.
  token: number
  // The AI chat asked about this query. It is kept while the query stays the same.
  chatId: string | null
  // AI is the selected result type, so the chat shows in place of the results.
  ai: boolean
}

export type Page = {
  // Numbers the popup for main; a new popup always gets a new one.
  id: number
  state: PageState | null
  // URL being opened, shown until the page reports its own state.
  pendingUrl: string
  // How the page looked when another popup covered it; only the top popup's page is live.
  snapshot: string | null
}

let nextPageId = 1

// Deeper than this, a link navigates the top popup instead, so the stack stays usable.
const MAX_POPUPS = 6

// What the window shows: the search page (home or results) or an AI chat. Web pages open in a stack
// of popups over it; closing them all puts you back exactly where you were.
class View {
  showing = $state<'search' | 'chat'>('search')
  search = $state<SearchState | null>(null)
  // Open popups, bottom first; the last one is on top.
  pages = $state<Page[]>([])

  get page(): Page | null {
    return this.pages.at(-1) ?? null
  }

  // From the app (results, chat, history, address bar): opens a popup, or navigates the top one if open.
  open(url: string): void {
    const top = this.page
    if (!top) {
      this.push(url)
      return
    }
    top.pendingUrl = url
    window.zook.page.open(top.id, url)
  }

  // A link followed inside the top popup stacks another popup on it. The one beneath is captured first,
  // since only the top page can be shown live.
  async push(url: string): Promise<void> {
    const top = this.page
    if (top && this.pages.length >= MAX_POPUPS) return this.open(url)
    if (top) {
      // A capture can fail (e.g. "display surface not available" while the window isn't painting) or be slow;
      // either way the new popup still opens, and the one beneath just has no picture.
      const snapshot = await Promise.race([
        window.zook.page.capture(top.id).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 400))
      ])
      // The stack changed while capturing (e.g. it was closed); drop the link.
      if (this.page !== top) return
      top.snapshot = snapshot
    }
    const page: Page = { id: nextPageId++, state: null, pendingUrl: url, snapshot: null }
    this.pages.push(page)
    window.zook.page.open(page.id, url)
  }

  // ✕ and Esc: closes the top popup, revealing the one beneath.
  closeTop() {
    const top = this.pages.pop()
    if (top) window.zook.page.close(top.id)
  }

  // Clicking outside the stack, or going somewhere new, closes every popup.
  closeAll() {
    for (const page of this.pages) window.zook.page.close(page.id)
    this.pages = []
  }

  go(to: 'search' | 'chat') {
    this.closeAll()
    this.showing = to
  }

  updateState(state: PageState) {
    const page = this.pages.find((p) => p.id === state.id)
    if (!page) return
    page.state = state
    if (state.url) page.pendingUrl = ''
  }
}

export const view = new View()

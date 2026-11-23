export type SearchResult = {
  title: string
  url: string
  displayUrl: string
  // Safe HTML: escaped text, optionally with <strong> highlights.
  snippet: string
  favicon?: string
  age?: string
}

export type SearchResponse = { results: SearchResult[]; hasMore: boolean }

export type ProviderId = 'brave' | 'serpapi' | 'google' | 'exa' | 'tavily' | 'parallel'

export type ProviderField = {
  id: string
  label: string
  secret: boolean
  placeholder?: string
  // Environment variable used as a development fallback.
  env: string
}

export type ProviderInfo = {
  id: ProviderId
  name: string
  description: string
  signupUrl: string
  fields: ProviderField[]
  paginated: boolean
  note?: string
}

type Credentials = Record<string, string>

type Provider = ProviderInfo & {
  search: (creds: Credentials, query: string, page: number) => Promise<SearchResponse>
}

const PAGE_SIZE = 10
const MAX_PAGE = 9

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Keep <strong> highlights from providers that send them; escape everything else.
function sanitizeHighlighted(html: string): string {
  return escapeHtml(html).replace(/&lt;(\/?)strong&gt;/g, '<$1strong>')
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

function truncate(text: string, max = 320): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean
}

function displayUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return url
  }
}

function plainResult(r: { title?: string; url: string; text?: string; favicon?: string; age?: string }): SearchResult {
  return {
    title: r.title || displayUrl(r.url),
    url: r.url,
    displayUrl: displayUrl(r.url),
    snippet: escapeHtml(truncate(r.text ?? '')),
    favicon: r.favicon,
    age: r.age
  }
}

export async function request(name: string, url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init)
  if (res.ok) return res.json()

  let detail = ''
  try {
    const body = await res.json()
    const candidate =
      body.error?.message ?? body.error?.detail ?? body.error?.code ?? body.error ?? body.message ?? body.detail
    if (typeof candidate === 'string') detail = candidate
  } catch {
    // body wasn't JSON
  }
  // Brave (422) and Google (400) report bad keys with non-auth status codes.
  const badKey = /api key|token|subscription/i.test(detail)
  if (res.status === 401 || res.status === 403 || badKey) {
    throw new Error(`${name} rejected your API key. Check it in Settings.`)
  }
  if (res.status === 402) throw new Error(`Your ${name} account is out of credits.`)
  if (res.status === 429) throw new Error(`${name} rate limit reached. Try again shortly.`)
  throw new Error(`${name} search failed (${res.status})${detail ? `: ${detail}` : ''}`)
}

const providers: Provider[] = [
  {
    id: 'brave',
    name: 'Brave Search',
    description: 'Independent web index with classic results. Free tier available.',
    signupUrl: 'https://brave.com/search/api/',
    fields: [{ id: 'apiKey', label: 'API key', secret: true, env: 'BRAVE_API_KEY' }],
    paginated: true,
    async search(creds, query, page) {
      const params = new URLSearchParams({ q: query, count: String(PAGE_SIZE), offset: String(page) })
      const data = await request('Brave Search', `https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': creds.apiKey }
      })
      return {
        results: (data.web?.results ?? []).map((r: any) => ({
          title: stripTags(r.title ?? ''),
          url: r.url,
          displayUrl: r.meta_url?.hostname ? `${r.meta_url.hostname}${r.meta_url.path ?? ''}` : r.url,
          snippet: sanitizeHighlighted(r.description ?? ''),
          favicon: r.meta_url?.favicon,
          age: r.age
        })),
        hasMore: Boolean(data.query?.more_results_available) && page < MAX_PAGE
      }
    }
  },
  {
    id: 'serpapi',
    name: 'SerpAPI',
    description: 'Real Google results, scraped and returned as JSON. Paid, with a small free plan.',
    signupUrl: 'https://serpapi.com/',
    fields: [{ id: 'apiKey', label: 'API key', secret: true, env: 'SERPAPI_API_KEY' }],
    paginated: true,
    async search(creds, query, page) {
      const params = new URLSearchParams({
        engine: 'google',
        q: query,
        api_key: creds.apiKey,
        num: String(PAGE_SIZE),
        start: String(page * PAGE_SIZE)
      })
      const data = await request('SerpAPI', `https://serpapi.com/search.json?${params}`)
      if (data.error && !data.organic_results) {
        // SerpAPI reports "no results" as an error string on a 200 response.
        if (/hasn't returned any results/i.test(data.error)) return { results: [], hasMore: false }
        throw new Error(`SerpAPI: ${data.error}`)
      }
      return {
        results: (data.organic_results ?? []).map((r: any) => ({
          ...plainResult({ title: r.title, url: r.link, text: r.snippet, favicon: r.favicon, age: r.date }),
          displayUrl: r.displayed_link ?? displayUrl(r.link)
        })),
        hasMore: Boolean(data.serpapi_pagination?.next) && page < MAX_PAGE
      }
    }
  },
  {
    id: 'google',
    name: 'Google Programmable Search',
    description: 'Google Custom Search JSON API. Needs an API key and a search engine ID (cx).',
    signupUrl: 'https://developers.google.com/custom-search/v1/overview',
    note: 'Google has closed this API to new customers. Use it only if you already have access.',
    fields: [
      { id: 'apiKey', label: 'API key', secret: true, env: 'GOOGLE_API_KEY' },
      { id: 'cx', label: 'Search engine ID (cx)', secret: false, placeholder: 'e.g. 012345678901234567890:abcdefghijk', env: 'GOOGLE_CX' }
    ],
    paginated: true,
    async search(creds, query, page) {
      const params = new URLSearchParams({
        key: creds.apiKey,
        cx: creds.cx,
        q: query,
        num: String(PAGE_SIZE),
        start: String(page * PAGE_SIZE + 1)
      })
      const data = await request('Google', `https://www.googleapis.com/customsearch/v1?${params}`)
      return {
        results: (data.items ?? []).map((r: any) => ({
          ...plainResult({ title: r.title, url: r.link, text: r.snippet }),
          displayUrl: r.displayLink ? `${r.displayLink}${new URL(r.link).pathname.replace(/\/$/, '')}` : displayUrl(r.link)
        })),
        hasMore: Boolean(data.queries?.nextPage) && page < MAX_PAGE
      }
    }
  },
  {
    id: 'exa',
    name: 'Exa',
    description: 'Neural, meaning-based search. Good for natural-language questions.',
    signupUrl: 'https://dashboard.exa.ai/api-keys',
    fields: [{ id: 'apiKey', label: 'API key', secret: true, env: 'EXA_API_KEY' }],
    paginated: false,
    async search(creds, query) {
      const data = await request('Exa', 'https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': creds.apiKey },
        body: JSON.stringify({
          query,
          type: 'auto',
          numResults: PAGE_SIZE,
          contents: { highlights: { maxCharacters: 400 } }
        })
      })
      return {
        results: (data.results ?? []).map((r: any) =>
          plainResult({
            title: r.title,
            url: r.url,
            text: (r.highlights ?? []).join(' … ') || r.summary || r.text,
            favicon: r.favicon,
            age: r.publishedDate?.slice(0, 10)
          })
        ),
        hasMore: false
      }
    }
  },
  {
    id: 'tavily',
    name: 'Tavily',
    description: 'Search built for AI agents, with summarized content per result. Free monthly credits.',
    signupUrl: 'https://app.tavily.com/',
    fields: [{ id: 'apiKey', label: 'API key', secret: true, placeholder: 'tvly-…', env: 'TAVILY_API_KEY' }],
    paginated: false,
    async search(creds, query) {
      const data = await request('Tavily', 'https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
        body: JSON.stringify({ query, max_results: PAGE_SIZE, search_depth: 'basic', include_favicon: true })
      })
      return {
        results: (data.results ?? []).map((r: any) =>
          plainResult({ title: r.title, url: r.url, text: r.content, favicon: r.favicon })
        ),
        hasMore: false
      }
    }
  },
  {
    id: 'parallel',
    name: 'Parallel',
    description: 'Web search with long, relevant excerpts per result.',
    signupUrl: 'https://platform.parallel.ai/',
    fields: [{ id: 'apiKey', label: 'API key', secret: true, env: 'PARALLEL_API_KEY' }],
    paginated: false,
    async search(creds, query) {
      const data = await request('Parallel', 'https://api.parallel.ai/v1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': creds.apiKey },
        body: JSON.stringify({
          objective: query,
          search_queries: [query.slice(0, 200)],
          mode: 'basic',
          advanced_settings: { max_results: PAGE_SIZE }
        })
      })
      return {
        results: (data.results ?? []).map((r: any) =>
          plainResult({
            title: r.title,
            url: r.url,
            text: (r.excerpts ?? []).join(' … '),
            age: r.publish_date ?? undefined
          })
        ),
        hasMore: false
      }
    }
  }
]

export const providerIds = providers.map((p) => p.id)

export function getProvider(id: ProviderId): Provider {
  const provider = providers.find((p) => p.id === id)
  if (!provider) throw new Error(`Unknown search provider: ${id}`)
  return provider
}

export function providerInfo(): ProviderInfo[] {
  return providers.map(({ search: _search, ...info }) => info)
}

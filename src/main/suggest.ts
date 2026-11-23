import { request } from './providers'

// Online query suggestions from the Brave Autosuggest API (a separate plan from Brave search).
export async function braveSuggest(key: string, query: string): Promise<string[]> {
  const params = new URLSearchParams({ q: query, count: '6' })
  const data = await request('Brave Autosuggest', `https://api.search.brave.com/res/v1/suggest/search?${params}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key }
  })
  return (data.results ?? []).map((r: any) => String(r.query)).filter(Boolean)
}

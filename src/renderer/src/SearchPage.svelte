<script lang="ts">
  import type { ProviderId } from '../../main/providers'
  import type { SettingsStatus } from '../../main/settings'
  import SuggestInput, { type Suggestion } from './SuggestInput.svelte'
  import type { Tab } from './tabs.svelte'

  let {
    tab,
    settings,
    onsearch,
    onnavigate,
    onopen,
    onswitchprovider,
    onopensettings
  }: {
    tab: Tab
    settings: SettingsStatus | null
    onsearch: (query: string, page?: number) => void
    onnavigate: (text: string) => void
    onopen: (url: string, background: boolean) => void
    onswitchprovider: (id: ProviderId) => void
    onopensettings: () => void
  } = $props()

  let homeQuery = $state('')
  let recent = $state<string[]>([])

  const configured = $derived(settings?.providers.filter((p) => p.source !== 'none') ?? [])

  $effect(() => {
    if (!tab.search) loadRecent()
  })

  async function loadRecent() {
    recent = (await window.zook.suggest.local('')).searches.slice(0, 6)
  }

  async function forget(query: string) {
    await window.zook.history.removeSearch(query)
    loadRecent()
  }

  function pick(s: Suggestion) {
    if (s.kind === 'page') onopen(s.url, false)
    else onsearch(s.text)
  }

  // Ctrl/Cmd+click or middle-click opens a result in a background tab.
  function resultClick(e: MouseEvent, url: string) {
    if (e.button === 1 || e.ctrlKey || e.metaKey) {
      e.preventDefault()
      onopen(url, true)
    } else if (e.button === 0) {
      onopen(url, false)
    }
  }
</script>

{#if !tab.search}
  <main class="home">
    <h1 class="logo">Zook</h1>
    <div class="searchbox">
      <SuggestInput
        bind:value={homeQuery}
        placeholder="Search the web or type a URL"
        autofocus
        onsubmit={onnavigate}
        onpick={pick}
      />
      <span class="glyph" aria-hidden="true">⌕</span>
    </div>
    {#if recent.length}
      <ul class="recent">
        {#each recent as q (q)}
          <li>
            <button class="chip" onclick={() => onsearch(q)}>🕘 {q}</button>
            <button class="forget" onclick={() => forget(q)} aria-label={`Remove ${q} from history`} title="Remove">✕</button>
          </li>
        {/each}
      </ul>
    {/if}
  </main>
{:else}
  {@const s = tab.search}
  <main class="results">
    <div class="meta">
      {#if configured.length > 1}
        <select
          class="provider"
          value={settings?.active}
          onchange={(e) => onswitchprovider(e.currentTarget.value as ProviderId)}
          title="Search provider"
        >
          {#each configured as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      {:else if configured.length === 1}
        <span class="muted">Results from {configured[0].name}</span>
      {/if}
    </div>

    {#if s.loading}
      <p class="muted">Searching…</p>
    {:else if s.error}
      <p class="error">{s.error}</p>
      {#if s.error.includes('Settings')}
        <button class="pill" onclick={onopensettings}>Open Settings</button>
      {/if}
    {:else if s.results.length === 0}
      <p class="muted">No results for “{s.query}”.</p>
    {:else}
      {#each s.results as r (r.url)}
        <article class="result">
          <button
            class="result-link"
            title="Ctrl+click or middle-click to open in a new tab"
            onclick={(e) => resultClick(e, r.url)}
            onauxclick={(e) => resultClick(e, r.url)}
          >
            <span class="site">
              {#if r.favicon}<img src={r.favicon} alt="" width="16" height="16" />{/if}
              <span class="url">{r.displayUrl}</span>
            </span>
            <span class="title">{r.title}</span>
          </button>
          <p class="snippet">
            {#if r.age}<span class="muted">{r.age} — </span>{/if}{@html r.snippet}
          </p>
        </article>
      {/each}

      {#if s.page > 0 || s.hasMore}
        <div class="pager">
          <button disabled={s.page === 0} onclick={() => onsearch(s.query, s.page - 1)}>‹ Previous</button>
          <span class="muted">Page {s.page + 1}</span>
          <button disabled={!s.hasMore} onclick={() => onsearch(s.query, s.page + 1)}>Next ›</button>
        </div>
      {/if}
    {/if}
  </main>
{/if}

<style>
  .home {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
    padding: 0 16px 12vh;
  }
  .logo {
    margin: 0;
    font-size: 72px;
    font-weight: 700;
    letter-spacing: -2px;
    color: var(--accent);
  }
  .searchbox {
    display: flex;
    align-items: center;
    width: 100%;
    max-width: 640px;
    height: 50px;
    border: 1px solid var(--border);
    border-radius: 25px;
    background: var(--bg);
    padding: 0 18px 0 22px;
    font-size: 16px;
  }
  .searchbox:focus-within { box-shadow: 0 1px 6px rgb(0 0 0 / 0.2); border-color: transparent; }
  .glyph { font-size: 22px; color: var(--muted); margin-left: 8px; }
  .recent {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    max-width: 640px;
  }
  .recent li { display: flex; align-items: center; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); }
  .chip { border: 0; background: none; padding: 5px 4px 5px 12px; cursor: pointer; font-size: 13px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .forget { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 5px 10px 5px 4px; font-size: 11px; }

  .results { max-width: 700px; padding: 16px 24px 40px 128px; }
  @media (max-width: 800px) { .results { padding-left: 24px; } }
  .meta { display: flex; align-items: center; min-height: 32px; margin-bottom: 12px; font-size: 13px; }
  .provider {
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface);
    color: var(--fg);
    padding: 5px 10px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .result { margin-bottom: 28px; }
  .result-link {
    display: block;
    text-align: left;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    width: 100%;
  }
  .site { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
  .site img { border-radius: 50%; background: var(--surface); }
  .url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title { display: block; margin-top: 4px; font-size: 20px; color: var(--link); line-height: 1.3; }
  .result-link:hover .title { text-decoration: underline; }
  .snippet { margin: 4px 0 0; font-size: 14px; line-height: 1.55; }
  .muted { color: var(--muted); }
  .error { color: var(--error); }
  .pager { display: flex; align-items: center; gap: 20px; margin-top: 12px; }
  .pager button, .pill {
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 18px;
    padding: 6px 14px;
    cursor: pointer;
  }
  .pager button:disabled { opacity: 0.4; cursor: default; }
</style>

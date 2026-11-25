<script lang="ts">
  import Icon from './Icon.svelte'
  import type { Snippet } from 'svelte'
  import type { ProviderId, Vertical } from '../../main/providers'
  import type { SettingsStatus } from '../../main/settings'
  import { verticalLabels, type SearchState } from './view.svelte'

  let {
    search,
    settings,
    onsearch,
    onvertical,
    onopen,
    onswitchprovider,
    onopensettings,
    onaskai,
    ai
  }: {
    // Null before the first search; App shows its home screen then instead.
    search: SearchState | null
    settings: SettingsStatus | null
    onsearch: (query: string, page?: number, vertical?: Vertical) => void
    onvertical: (vertical: Vertical) => void
    onopen: (url: string) => void
    onswitchprovider: (id: ProviderId) => void
    onopensettings: () => void
    // Selects AI as the result type.
    onaskai: () => void
    // The AI chat, shown below the header while AI is selected.
    ai?: Snippet
  } = $props()

  const configured = $derived(settings?.providers.filter((p) => p.source !== 'none') ?? [])
  const supports = $derived(settings?.providers.find((p) => p.id === settings?.active)?.supports ?? (['web'] as Vertical[]))

  let scroller = $state<HTMLDivElement>()

  // Each new search starts at the top; so do results shown again after AI.
  $effect(() => {
    void search?.token
    scroller?.scrollTo(0, 0)
  })
</script>

{#if search}
  {@const s = search}
  {@const grid = s.vertical === 'images' || s.vertical === 'videos'}
  <div class="search-view">
    <!-- Stays put at the top while results scroll under it. -->
    <header class="meta">
      <div class="meta-row">
        <div class="verticals" role="tablist" aria-label="Result type">
          {#each supports as v (v)}
            <button
              role="tab"
              aria-selected={!s.ai && s.vertical === v}
              class:selected={!s.ai && s.vertical === v}
              onclick={() => onvertical(v)}>{verticalLabels[v]}</button
            >
          {/each}
          <!-- Answers the query with an AI chat, shown in place of the results. -->
          <button role="tab" aria-selected={s.ai} class:selected={s.ai} onclick={onaskai} title={`Ask AI: “${s.query}”`}>
            <Icon name="chat" /> AI
          </button>
        </div>
        <div class="source">
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
      </div>
    </header>

    {#if s.ai}
      <!-- The chat scrolls its own transcript, with its composer pinned at the bottom. -->
      <div class="ai-view">{@render ai?.()}</div>
    {:else}
      <div class="scroll" bind:this={scroller}>
        <main class="results" class:grid>
          {#if s.loading}
            <div class="skeleton" role="status" aria-label="Searching">
              {#if grid}
                <div class="tiles" class:videos={s.vertical === 'videos'}>
                  {#each Array(12) as _, i (i)}<span class="sk tile"></span>{/each}
                </div>
              {:else}
                {#each Array(5) as _, i (i)}
                  <div class="sk-result">
                    <span class="sk sk-site"></span>
                    <span class="sk sk-title"></span>
                    <span class="sk sk-line"></span>
                    <span class="sk sk-line short"></span>
                  </div>
                {/each}
              {/if}
            </div>
          {:else if s.error}
            <div class="notice">
              <p class="lead error">{s.error}</p>
              {#if s.error.includes('Settings')}
                <button class="pill" onclick={onopensettings}>Open Settings</button>
              {/if}
            </div>
          {:else if s.results.length === 0}
            <div class="notice">
              <p class="lead">No results for “{s.query}”</p>
              <p class="muted">Try different or fewer words, or ask AI about it.</p>
              <button class="pill" onclick={onaskai}><Icon name="chat" /> Ask AI</button>
            </div>
          {:else if s.vertical === 'images'}
            <div class="tiles">
              {#each s.results as r, i (i)}
                <button class="image" title={r.title} onclick={() => onopen(r.url)}>
                  <img src={r.thumbnailUrl ?? r.imageUrl} alt={r.title} loading="lazy" />
                  <span class="caption">{r.title}</span>
                  <span class="caption muted">{r.source ?? r.displayUrl}</span>
                </button>
              {/each}
            </div>
          {:else if s.vertical === 'videos'}
            <div class="tiles videos">
              {#each s.results as r, i (i)}
                <button class="video" title={r.title} onclick={() => onopen(r.url)}>
                  <span class="thumb">
                    {#if r.thumbnailUrl}<img src={r.thumbnailUrl} alt="" loading="lazy" />{/if}
                    {#if r.duration}<span class="duration">{r.duration}</span>{/if}
                  </span>
                  <span class="video-title">{r.title}</span>
                  <span class="site">
                    {#if r.favicon}<img src={r.favicon} alt="" width="16" height="16" />{/if}
                    <span class="url">{r.source ?? r.displayUrl}{#if r.age} · {r.age}{/if}</span>
                  </span>
                </button>
              {/each}
            </div>
          {:else}
            {#each s.results as r (r.url)}
              <article class="result">
                <button class="result-link" onclick={() => onopen(r.url)}>
                  <span class="site">
                    {#if r.favicon}<img src={r.favicon} alt="" width="16" height="16" />{/if}
                    <span class="url">{s.vertical === 'news' ? (r.source ?? r.displayUrl) : r.displayUrl}</span>
                  </span>
                  <span class="title">{r.title}</span>
                </button>
                <p class="snippet">
                  {#if r.age}<span class="muted">{r.age} — </span>{/if}{@html r.snippet}
                </p>
              </article>
            {/each}

            {#if s.page > 0 || s.hasMore}
              <nav class="pager" aria-label="Pages">
                <button disabled={s.page === 0} onclick={() => onsearch(s.query, s.page - 1, s.vertical)}>‹ Previous</button>
                <span class="muted">Page {s.page + 1}</span>
                <button disabled={!s.hasMore} onclick={() => onsearch(s.query, s.page + 1, s.vertical)}>Next ›</button>
              </nav>
            {/if}
          {/if}
        </main>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* One centred column for the header row, the text results and the inline chat, so they share both edges
     and leftover width is split evenly. The gutter grows with the space the view is given. */
  .search-view {
    height: 100%;
    display: flex;
    flex-direction: column;
    container-type: inline-size;
    --gutter: clamp(16px, 4cqi, 48px);
    --reading: 680px;
  }

  /* The border runs the full width; the row inside it is the centred column. It keeps that width on every
     result type, so the tabs don't jump sideways when switching to Images or Videos. */
  .meta {
    flex-shrink: 0;
    padding: 8px var(--gutter);
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    font-size: 13px;
  }
  .meta-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    max-width: var(--reading);
    margin: 0 auto;
  }
  .verticals { display: flex; flex-wrap: wrap; gap: 4px; }
  .verticals button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    border: 1px solid transparent;
    border-radius: 15px;
    background: none;
    color: var(--muted);
    padding: 0 12px;
    font: inherit;
    cursor: pointer;
    transition: background-color 0.12s, color 0.12s;
  }
  .verticals button:hover { background: var(--surface); color: var(--fg); }
  .verticals button.selected { border-color: var(--box-border); background: var(--surface); color: var(--fg); font-weight: 600; }
  .source { margin-left: auto; display: flex; align-items: center; min-width: 0; }
  .source .muted { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .provider {
    height: 30px;
    border: 1px solid var(--box-border);
    border-radius: 15px;
    background: var(--bg);
    box-shadow: var(--box-shadow);
    color: var(--fg);
    padding: 0 10px;
    font: inherit;
    cursor: pointer;
  }
  .provider:hover { background: var(--surface); }

  .scroll { flex: 1; min-height: 0; overflow-y: auto; }
  .ai-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }

  /* Text results keep a readable line length; image and video grids use all the width there is. */
  .results { max-width: calc(var(--reading) + 2 * var(--gutter)); margin: 0 auto; padding: 20px var(--gutter) 48px; }
  .results.grid { max-width: none; }

  .result { margin-bottom: 26px; }
  .result-link {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    border-radius: 4px;
    padding: 0;
    cursor: pointer;
  }
  .site { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; color: var(--muted); }
  .site img { flex-shrink: 0; border-radius: 50%; background: var(--surface); }
  .url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title { display: block; margin-top: 4px; font-size: 19px; line-height: 1.3; color: var(--link); }
  .result-link:hover .title, .result-link:focus-visible .title { text-decoration: underline; text-underline-offset: 2px; }
  .snippet { margin: 4px 0 0; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 20px 14px; }
  .tiles.videos { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 24px 16px; }
  .image, .video {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    text-align: left;
    background: none;
    border: 0;
    border-radius: 10px;
    padding: 0;
    cursor: pointer;
  }
  .image img, .thumb img { transition: filter 0.15s; }
  .image:hover img, .video:hover .thumb img { filter: brightness(0.88); }
  .image img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 10px; background: var(--surface); }
  .caption { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .image:hover .caption:first-of-type { text-decoration: underline; }
  .thumb { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; background: var(--surface); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .duration {
    position: absolute;
    right: 6px;
    bottom: 6px;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgb(0 0 0 / 0.75);
    color: #fff;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .video-title {
    font-size: 15px;
    font-weight: 500;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .video:hover .video-title { text-decoration: underline; text-underline-offset: 2px; }

  .notice { padding: 24px 0; }
  .notice p { margin: 0 0 6px; }
  .notice .lead { font-size: 16px; }
  .notice .pill { margin-top: 10px; }
  .muted { color: var(--muted); }
  .error { color: var(--error); }

  .pager { display: flex; align-items: center; gap: 16px; margin-top: 8px; }
  .pager button, .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    border: 1px solid var(--box-border);
    background: var(--bg);
    box-shadow: var(--box-shadow);
    border-radius: 17px;
    padding: 0 16px;
    cursor: pointer;
    transition: background-color 0.12s;
  }
  .pager button:hover:not(:disabled), .pill:hover { background: var(--surface); }
  .pager button:disabled { opacity: 0.4; cursor: default; }

  /* Placeholders in the shape of the results, while they load. */
  .sk { display: block; border-radius: 6px; background: var(--surface); animation: shimmer 1.2s ease-in-out infinite; }
  @keyframes shimmer { 50% { opacity: 0.5; } }
  .sk-result { margin-bottom: 30px; }
  .sk-site { width: 160px; height: 12px; }
  .sk-title { width: 55%; height: 20px; margin: 8px 0 10px; }
  .sk-line { height: 12px; margin-bottom: 7px; }
  .sk-line.short { width: 70%; }
  .tile { aspect-ratio: 4 / 3; border-radius: 10px; }
  .videos .tile { aspect-ratio: 16 / 9; }
</style>

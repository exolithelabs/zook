<script lang="ts">
  import type { History } from '../../main/history'

  let {
    onclose,
    onsearch,
    onopen
  }: {
    onclose: () => void
    onsearch: (query: string) => void
    onopen: (url: string, background: boolean) => void
  } = $props()

  let history = $state<History>({ searches: [], visits: [] })
  let view = $state<'visits' | 'searches'>('visits')
  let filter = $state('')
  let confirmClear = $state(false)

  const q = $derived(filter.trim().toLowerCase())
  const visits = $derived(
    history.visits.filter((v) => !q || v.url.toLowerCase().includes(q) || v.title.toLowerCase().includes(q)).slice(0, 300)
  )
  const searches = $derived(history.searches.filter((s) => !q || s.query.toLowerCase().includes(q)).slice(0, 300))

  $effect(() => {
    load()
  })

  async function load() {
    history = await window.zook.history.get()
  }

  async function removeVisit(url: string) {
    await window.zook.history.removeVisit(url)
    load()
  }

  async function removeSearch(query: string) {
    await window.zook.history.removeSearch(query)
    load()
  }

  async function clearAll() {
    await window.zook.history.clear()
    confirmClear = false
    load()
  }

  function when(at: number): string {
    const d = new Date(at)
    const today = new Date()
    if (d.toDateString() === today.toDateString()) {
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  function host(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="history-title">
    <header>
      <h2 id="history-title">History</h2>
      <button class="close" onclick={onclose} aria-label="Close">✕</button>
    </header>

    <div class="controls">
      <div class="segmented" role="tablist">
        <button role="tab" aria-selected={view === 'visits'} class:on={view === 'visits'} onclick={() => (view = 'visits')}>
          Pages <span class="count">{history.visits.length}</span>
        </button>
        <button role="tab" aria-selected={view === 'searches'} class:on={view === 'searches'} onclick={() => (view = 'searches')}>
          Searches <span class="count">{history.searches.length}</span>
        </button>
      </div>
      <!-- svelte-ignore a11y_autofocus -->
      <input class="filter" bind:value={filter} placeholder="Filter history" autofocus spellcheck="false" />
    </div>

    <ul class="list">
      {#if view === 'visits'}
        {#each visits as v (v.url)}
          <li>
            <span class="time">{when(v.at)}</span>
            <button
              class="entry"
              title={v.url}
              onclick={(e) => onopen(v.url, e.ctrlKey || e.metaKey)}
              onauxclick={(e) => e.button === 1 && onopen(v.url, true)}
            >
              <span class="title">{v.title || v.url}</span>
              <span class="host">{host(v.url)}</span>
            </button>
            <button class="remove" onclick={() => removeVisit(v.url)} aria-label="Remove" title="Remove">✕</button>
          </li>
        {:else}
          <li class="empty">{q ? 'No matching pages.' : 'No pages visited yet.'}</li>
        {/each}
      {:else}
        {#each searches as s (s.query)}
          <li>
            <span class="time">{when(s.at)}</span>
            <button class="entry" onclick={() => onsearch(s.query)}>
              <span class="title">⌕ {s.query}</span>
            </button>
            <button class="remove" onclick={() => removeSearch(s.query)} aria-label="Remove" title="Remove">✕</button>
          </li>
        {:else}
          <li class="empty">{q ? 'No matching searches.' : 'No searches yet.'}</li>
        {/each}
      {/if}
    </ul>

    <footer>
      {#if confirmClear}
        <span class="muted">Clear all pages and searches?</span>
        <button class="ghost" onclick={() => (confirmClear = false)}>Cancel</button>
        <button class="ghost danger" onclick={clearAll}>Clear history</button>
      {:else}
        <button
          class="ghost danger"
          disabled={!history.visits.length && !history.searches.length}
          onclick={() => (confirmClear = true)}>Clear all history…</button
        >
      {/if}
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    z-index: 10;
  }
  .panel {
    width: 100%;
    max-width: 680px;
    height: min(720px, calc(100vh - 32px));
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px 24px 16px;
    box-shadow: 0 10px 40px rgb(0 0 0 / 0.3);
  }
  header { display: flex; align-items: center; justify-content: space-between; }
  h2 { margin: 0; font-size: 20px; }
  .close { border: 0; background: none; font-size: 16px; cursor: pointer; color: var(--muted); }
  .controls { display: flex; gap: 12px; margin: 16px 0 8px; flex-wrap: wrap; }
  .segmented { display: flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .segmented button { border: 0; background: none; padding: 6px 14px; cursor: pointer; font-size: 13px; }
  .segmented button.on { background: var(--surface); font-weight: 600; }
  .count { color: var(--muted); font-weight: 400; margin-left: 4px; }
  .filter {
    flex: 1;
    min-width: 160px;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 12px;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
    font-size: 14px;
    outline: 0;
  }
  .filter:focus { border-color: var(--accent); }
  .list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
  .list li { display: flex; align-items: center; gap: 12px; padding: 2px 0; border-radius: 8px; }
  .list li:hover { background: var(--surface); }
  .time { width: 64px; flex-shrink: 0; text-align: right; color: var(--muted); font-size: 12px; }
  .entry {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 10px;
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
    padding: 7px 0;
    font-size: 14px;
  }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .host { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .remove { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 4px 10px; opacity: 0; }
  .list li:hover .remove { opacity: 1; }
  .empty { justify-content: center; color: var(--muted); padding: 32px 0 !important; font-size: 14px; }
  .empty:hover { background: none !important; }
  footer { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 13px; }
  .ghost { border: 1px solid var(--border); background: var(--surface); border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
  .ghost:disabled { opacity: 0.5; cursor: default; }
  .danger { color: var(--error); }
  .muted { color: var(--muted); }
</style>

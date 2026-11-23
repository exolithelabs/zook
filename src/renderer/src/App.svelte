<script lang="ts">
  import type { ProviderId } from '../../main/providers'
  import type { SettingsStatus } from '../../main/settings'
  import History from './History.svelte'
  import SearchPage from './SearchPage.svelte'
  import Settings from './Settings.svelte'
  import SuggestInput, { type Suggestion } from './SuggestInput.svelte'
  import { errorMessage } from './errors'
  import { tabs, tabTitle, type Tab } from './tabs.svelte'

  let settingsStatus = $state<SettingsStatus | null>(null)
  let settingsOpen = $state(false)
  let historyOpen = $state(false)
  let addressOpen = $state(false)
  let addressInput = $state('')
  let addressFocused = $state(false)
  let address = $state<SuggestInput>()
  let viewport = $state<HTMLDivElement>()
  let snapshot = $state<string | null>(null)
  // A page view captured right after being shown again can come back blank or mis-scaled,
  // so a recent snapshot of the same tab is reused instead.
  let lastSnapshot: { tabId: number; img: string } | null = null
  let shownAt = 0
  // A search the user tried before adding an API key; it runs once a key is saved.
  let pendingSearch: { tabId: number; query: string } | null = null

  const active = $derived(tabs.active)
  // Narrow values, so effects below don't re-run on every page state update.
  const activeId = $derived(active.id)
  const showingWeb = $derived(active.showing === 'web')
  const overlayOpen = $derived(settingsOpen || historyOpen || addressOpen)
  const activeReady = $derived(
    settingsStatus?.providers.some((p) => p.id === settingsStatus?.active && p.source !== 'none') ?? false
  )

  $effect(() => {
    window.zook.settings.get().then((s) => (settingsStatus = s))
    const offs = [
      window.zook.tabs.onState((s) => tabs.updateState(s)),
      window.zook.tabs.onNew(({ url, background }) => {
        const tab = tabs.create({ activate: !background, after: tabs.active })
        tabs.openUrl(tab, url)
      }),
      window.zook.tabs.onSearchNew((query) => runSearch(tabs.create({ after: tabs.active }), query)),
      window.zook.onShortcut(onShortcut)
    ]
    return () => offs.forEach((off) => off())
  })

  // Keep the address bar in sync with the active tab, unless the user is typing in it.
  $effect(() => {
    const tab = active
    const value =
      tab.showing === 'web' ? tab.web?.url || tab.pendingUrl : (tab.search?.query ?? '')
    if (!addressFocused) addressInput = value
  })

  // The native page view always draws above the app's HTML, so while a dropdown or dialog
  // is open, hide it behind a screenshot of the page.
  $effect(() => {
    const id = activeId
    if (!showingWeb) {
      window.zook.tabs.show(null)
      snapshot = null
      return
    }
    if (!overlayOpen) {
      window.zook.tabs.show(id)
      snapshot = null
      shownAt = Date.now()
      return
    }
    if (lastSnapshot?.tabId === id && Date.now() - shownAt < 1000) {
      snapshot = lastSnapshot.img
      window.zook.tabs.show(null)
      return
    }
    let cancelled = false
    window.zook.tabs.capture(id).then((img) => {
      if (cancelled) return
      snapshot = img
      if (img) lastSnapshot = { tabId: id, img }
      window.zook.tabs.show(null)
    })
    return () => {
      cancelled = true
    }
  })

  // Keep the native page view aligned with the viewport element.
  $effect(() => {
    if (!viewport) return
    const el = viewport
    const sync = () => {
      const r = el.getBoundingClientRect()
      window.zook.tabs.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    window.addEventListener('resize', sync)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
    }
  })

  async function runSearch(tab: Tab, query: string, page = 0) {
    query = query.trim()
    if (!query) return
    tabs.activate(tab.id)
    if (settingsStatus && !activeReady) {
      pendingSearch = { tabId: tab.id, query }
      settingsOpen = true
      return
    }
    const token = (tab.search?.token ?? 0) + 1
    tab.search = { query, results: [], page, hasMore: false, loading: true, error: '', token }
    tab.showing = 'search'
    try {
      const res = await window.zook.search(query, page)
      if (tab.search?.token !== token) return
      tab.search = { ...tab.search, results: res.results, hasMore: res.hasMore, loading: false }
    } catch (e) {
      if (tab.search?.token !== token) return
      tab.search = { ...tab.search, loading: false, error: errorMessage(e) }
    }
    document.querySelector('.content')?.scrollTo(0, 0)
  }

  function toUrl(text: string): string | null {
    if (/^https?:\/\//i.test(text)) return text
    if (/^localhost(:\d+)?(\/\S*)?$/i.test(text)) return `http://${text}`
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(text) && !/\s/.test(text)) return `https://${text}`
    return null
  }

  // Address bar and home search box: URLs are opened directly, anything else is searched.
  function navigate(tab: Tab, text: string) {
    const url = toUrl(text.trim())
    if (url) tabs.openUrl(tab, url)
    else runSearch(tab, text)
  }

  function pickSuggestion(tab: Tab, s: Suggestion) {
    if (s.kind === 'page') tabs.openUrl(tab, s.url)
    else runSearch(tab, s.text)
  }

  function openResult(tab: Tab, url: string, background: boolean) {
    if (background) {
      // Background tabs keep a copy of the results, so Back returns to them.
      const created = tabs.create({ activate: false, after: tab })
      if (tab.search) created.search = { ...tab.search, results: [...tab.search.results] }
      tabs.openUrl(created, url)
    } else {
      tabs.openUrl(tab, url, true)
    }
  }

  function newTab() {
    tabs.create()
  }

  function reopenTab() {
    const closed = tabs.popClosed()
    if (!closed) return
    const tab = tabs.create()
    if (closed.url) tabs.openUrl(tab, closed.url)
    else if (closed.query) runSearch(tab, closed.query)
  }

  function reload(tab: Tab) {
    if (tab.showing === 'web') window.zook.tabs.reload(tab.id)
    else if (tab.search) runSearch(tab, tab.search.query, tab.search.page)
  }

  async function switchProvider(id: ProviderId) {
    settingsStatus = await window.zook.settings.setActive(id)
    const tab = tabs.active
    if (tab.search) runSearch(tab, tab.search.query)
  }

  function onSettingsChange(s: SettingsStatus) {
    settingsStatus = s
    const ready = s.providers.some((p) => p.id === s.active && p.source !== 'none')
    if (ready && pendingSearch) {
      const { tabId, query } = pendingSearch
      pendingSearch = null
      settingsOpen = false
      const tab = tabs.get(tabId)
      if (tab) runSearch(tab, query)
    }
  }

  function onShortcut(shortcut: string) {
    const tab = tabs.active
    if (shortcut === 'new-tab') newTab()
    else if (shortcut === 'close-tab') tabs.close(tab.id)
    else if (shortcut === 'reopen-tab') reopenTab()
    else if (shortcut === 'next-tab') tabs.cycle(1)
    else if (shortcut === 'prev-tab') tabs.cycle(-1)
    else if (shortcut.startsWith('tab-')) {
      const n = Number(shortcut.slice(4))
      tabs.activateIndex(n === 9 ? -1 : n - 1)
    } else if (shortcut === 'focus-address') address?.focus()
    else if (shortcut === 'back') tabs.back(tab)
    else if (shortcut === 'forward') tabs.forward(tab)
    else if (shortcut === 'reload') reload(tab)
    else if (shortcut === 'history') historyOpen = !historyOpen
  }

  function favicon(tab: Tab): string | undefined {
    return tab.showing === 'web' ? tab.web?.favicon : undefined
  }
</script>

<div class="app">
  <nav class="tabbar" aria-label="Tabs">
    <div class="tabs" role="tablist">
      {#each tabs.list as tab (tab.id)}
        <div
          class="tab"
          class:active={tab.id === active.id}
          role="tab"
          tabindex="0"
          aria-selected={tab.id === active.id}
          title={tabTitle(tab)}
          onclick={() => tabs.activate(tab.id)}
          onkeydown={(e) => e.key === 'Enter' && tabs.activate(tab.id)}
          onauxclick={(e) => e.button === 1 && tabs.close(tab.id)}
        >
          {#if tab.showing === 'web' && tab.web?.loading}
            <span class="spinner" aria-hidden="true"></span>
          {:else if favicon(tab)}
            <img src={favicon(tab)} alt="" width="16" height="16" />
          {:else}
            <span class="tab-icon" aria-hidden="true">{tab.showing === 'web' ? '🌐' : '⌕'}</span>
          {/if}
          <span class="tab-title">{tabTitle(tab)}</span>
          <button
            class="tab-close"
            aria-label="Close tab"
            title="Close tab (Ctrl+W)"
            onclick={(e) => {
              e.stopPropagation()
              tabs.close(tab.id)
            }}>✕</button
          >
        </div>
      {/each}
    </div>
    <button class="new-tab" onclick={newTab} aria-label="New tab" title="New tab (Ctrl+T)">+</button>
  </nav>

  <nav class="toolbar" aria-label="Navigation">
    <button onclick={() => tabs.back(active)} disabled={!tabs.canGoBack(active)} title="Back (Alt+←)" aria-label="Back">‹</button>
    <button onclick={() => tabs.forward(active)} disabled={!tabs.canGoForward(active)} title="Forward (Alt+→)" aria-label="Forward">›</button>
    {#if active.showing === 'web' && active.web?.loading}
      <button onclick={() => window.zook.tabs.stop(active.id)} title="Stop" aria-label="Stop">✕</button>
    {:else}
      <button onclick={() => reload(active)} disabled={active.showing === 'search' && !active.search} title="Reload (Ctrl+R)" aria-label="Reload">↻</button>
    {/if}

    <div class="address" class:focused={addressFocused}>
      <SuggestInput
        bind:this={address}
        bind:value={addressInput}
        id="address"
        placeholder="Search or enter address"
        selectOnFocus
        onsubmit={(text) => navigate(active, text)}
        onpick={(s) => pickSuggestion(active, s)}
        onopenchange={(open) => (addressOpen = open)}
        onfocuschange={(focused) => (addressFocused = focused)}
      />
    </div>

    {#if active.showing === 'web'}
      <button
        class="shield"
        class:off={!settingsStatus?.adblock}
        onclick={() => (settingsOpen = true)}
        title={settingsStatus?.adblock
          ? `${active.web?.blocked ?? 0} ads and trackers blocked on this page`
          : 'Ad blocking is off'}
        aria-label="Ad blocking"
      >
        🛡{#if settingsStatus?.adblock && active.web?.blocked}<span class="badge">{active.web.blocked > 99 ? '99+' : active.web.blocked}</span>{/if}
      </button>
      <button onclick={() => window.zook.tabs.openExternal(active.id)} title="Open in system browser" aria-label="Open in system browser">↗</button>
    {/if}
    <button onclick={() => (historyOpen = true)} title="History (Ctrl+H)" aria-label="History">🕘</button>
    <button onclick={() => (settingsOpen = true)} title="Settings" aria-label="Settings">⚙</button>
  </nav>

  <div class="progress" class:active={active.showing === 'web' && (active.web?.loading ?? true)}></div>

  <div class="content" class:web={active.showing === 'web'}>
    {#if active.showing === 'web'}
      <div class="viewport" bind:this={viewport}>
        {#if snapshot}<img class="snapshot" src={snapshot} alt="" />{/if}
      </div>
    {:else}
      {#key active.id}
        <SearchPage
          tab={active}
          settings={settingsStatus}
          onsearch={(q, page) => runSearch(active, q, page)}
          onnavigate={(text) => navigate(active, text)}
          onopen={(url, background) => openResult(active, url, background)}
          onswitchprovider={switchProvider}
          onopensettings={() => (settingsOpen = true)}
        />
      {/key}
    {/if}
  </div>
</div>

{#if settingsOpen}
  <Settings
    status={settingsStatus}
    onclose={() => {
      settingsOpen = false
      pendingSearch = null
    }}
    onchange={onSettingsChange}
  />
{/if}

{#if historyOpen}
  <History
    onclose={() => (historyOpen = false)}
    onsearch={(q) => {
      historyOpen = false
      runSearch(tabs.active, q)
    }}
    onopen={(url, background) => {
      if (background) tabs.openUrl(tabs.create({ activate: false, after: tabs.active }), url)
      else {
        historyOpen = false
        tabs.openUrl(tabs.active, url)
      }
    }}
  />
{/if}

<style>
  .app { height: 100%; display: flex; flex-direction: column; }

  .tabbar {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    padding: 6px 8px 0;
    background: var(--surface);
    min-height: 40px;
  }
  .tabs { display: flex; gap: 2px; min-width: 0; flex: 0 1 auto; overflow: hidden; }
  .tab {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 1 220px;
    min-width: 48px;
    height: 34px;
    padding: 0 6px 0 12px;
    border-radius: 9px 9px 0 0;
    font-size: 13px;
    cursor: default;
    user-select: none;
    color: var(--muted);
  }
  .tab:hover { background: color-mix(in srgb, var(--bg) 50%, transparent); }
  .tab.active { background: var(--bg); color: var(--fg); }
  .tab img { flex-shrink: 0; }
  .tab-icon { flex-shrink: 0; width: 16px; text-align: center; font-size: 12px; }
  .tab-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .tab-close {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    border: 0;
    border-radius: 50%;
    background: none;
    font-size: 10px;
    cursor: pointer;
    color: var(--muted);
  }
  .tab-close:hover { background: var(--surface); color: var(--fg); }
  .spinner {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .new-tab {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    margin-bottom: 2px;
    border: 0;
    border-radius: 50%;
    background: none;
    font-size: 20px;
    cursor: pointer;
    color: var(--muted);
  }
  .new-tab:hover { background: var(--bg); color: var(--fg); }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  .toolbar > button {
    position: relative;
    flex-shrink: 0;
    width: 34px;
    height: 34px;
    border: 0;
    border-radius: 50%;
    background: none;
    font-size: 18px;
    cursor: pointer;
  }
  .toolbar > button:hover:not(:disabled) { background: var(--surface); }
  .toolbar > button:disabled { opacity: 0.35; cursor: default; }
  .address {
    flex: 1;
    min-width: 0;
    height: 34px;
    margin: 0 6px;
    padding: 0 14px;
    border-radius: 17px;
    background: var(--surface);
    font-size: 14px;
    display: flex;
  }
  .address.focused { background: var(--bg); box-shadow: 0 0 0 2px var(--accent); }
  .shield { font-size: 16px !important; }
  .shield.off { opacity: 0.4; }
  .badge {
    position: absolute;
    right: 0;
    bottom: 2px;
    min-width: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--accent);
    color: var(--bg);
    font-size: 9px;
    font-weight: 700;
    line-height: 14px;
  }

  .progress { height: 2px; background: transparent; flex-shrink: 0; }
  .progress.active {
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    background-size: 200% 100%;
    animation: slide 1s linear infinite;
  }
  @keyframes slide { from { background-position: 100% 0; } to { background-position: -100% 0; } }

  .content { flex: 1; min-height: 0; overflow-y: auto; }
  .content.web { overflow: hidden; display: flex; }
  .viewport { flex: 1; position: relative; }
  .snapshot { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: top left; }
</style>

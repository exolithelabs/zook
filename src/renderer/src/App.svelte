<script lang="ts">
  import type { Shortcut } from '../../main/index'
  import type { ProviderId, Vertical } from '../../main/providers'
  import type { SettingsStatus } from '../../main/settings'
  import Chat from './Chat.svelte'
  import History from './History.svelte'
  import Icon from './Icon.svelte'
  import SearchPage from './SearchPage.svelte'
  import Settings, { type SettingsSection } from './Settings.svelte'
  import Sidebar from './Sidebar.svelte'
  import SuggestInput, { type Suggestion } from './SuggestInput.svelte'
  import { chats, groundedFor } from './chat.svelte'
  import { errorMessage } from './errors'
  import { view } from './view.svelte'

  let settingsStatus = $state<SettingsStatus | null>(null)
  let settingsOpen = $state(false)
  // Settings section to scroll to when the dialog opens.
  let settingsSection = $state<SettingsSection | undefined>()
  let historyOpen = $state(false)
  // Null until the saved preference has loaded.
  let sidebarOpen = $state<boolean | null>(null)
  let addressOpen = $state(false)
  let addressInput = $state('')
  let addressFocused = $state(false)
  // The home screen's own search box, shown while nothing has been searched yet.
  let homeInput = $state('')
  let homeOpen = $state(false)
  let address = $state<SuggestInput>()
  let viewport = $state<HTMLDivElement>()
  let snapshot = $state<string | null>(null)
  // A page view captured right after being shown again can come back blank or mis-scaled,
  // so a recent snapshot of the same page is reused instead.
  let lastSnapshot: { pageId: number; img: string } | null = null
  let shownAt = 0
  // A search the user tried before adding an API key; it runs once a key is saved.
  let pendingSearch: { query: string; vertical?: Vertical } | null = null
  let searchToken = 0

  const page = $derived(view.page?.state ?? null)
  // Narrow values, so effects below don't re-run on every page state update.
  const pageId = $derived(view.page?.id ?? 0)
  const pageOpen = $derived(view.page !== null)
  const overlayOpen = $derived(settingsOpen || historyOpen || addressOpen || homeOpen)
  // The chat shown as the AI result type, once its thread is loaded.
  const aiChat = $derived(
    view.showing === 'search' && view.search?.ai && chats.current?.id === view.search.chatId
      ? chats.current
      : null
  )
  const activeReady = $derived(
    settingsStatus?.providers.some((p) => p.id === settingsStatus?.active && p.source !== 'none') ?? false
  )

  $effect(() => {
    window.zook.settings.get().then((s) => {
      settingsStatus = s
      sidebarOpen ??= s.sidebarOpen
    })
    chats.refresh()
    const offs = [
      window.zook.page.onState((s) => view.updateState(s)),
      window.zook.page.onSearch((query) => runSearch(query)),
      // Only links followed in the top popup stack; anything from a page beneath is stale.
      window.zook.page.onLink(({ from, url }) => view.page?.id === from && view.push(url)),
      window.zook.onShortcut(onShortcut),
      chats.listen()
    ]
    return () => offs.forEach((off) => off())
  })

  // Keep the address bar in sync with the view, unless the user is typing in it.
  $effect(() => {
    const value = view.showing === 'chat' ? '' : (view.search?.query ?? '')
    if (!addressFocused) addressInput = value
  })

  // Returning to a search with AI selected (e.g. searching the same query again after
  // visiting another chat) loads that thread back.
  $effect(() => {
    const id = view.showing === 'search' && view.search?.ai ? view.search.chatId : null
    if (id && chats.currentId !== id) chats.open(id)
  })

  // The window title says what is showing, the popup's page first.
  $effect(() => {
    const title = view.page
      ? page?.title || page?.url || view.page.pendingUrl
      : view.showing === 'chat'
          ? chats.current?.title
          : view.search?.query
    document.title = title ? `${title} – Zook` : 'Zook'
  })

  // Keep the native page view fitted to the top popup's viewport, which moves as the window and sidebar change
  // and as popups open and close. It runs before the effect below, so a revealed page is shown at its own size.
  $effect(() => {
    if (!viewport) return
    const el = viewport
    const sync = () => {
      const r = el.getBoundingClientRect()
      window.zook.page.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
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

  // The native page view always draws above the app's HTML, so only the top popup's page is shown, and
  // while a dropdown or dialog is open it is hidden behind a screenshot too.
  $effect(() => {
    const id = pageId
    if (!pageOpen) {
      window.zook.page.show(null)
      snapshot = null
      return
    }
    if (!overlayOpen) {
      window.zook.page.show(id)
      snapshot = null
      shownAt = Date.now()
      return
    }
    if (lastSnapshot?.pageId === id && Date.now() - shownAt < 1000) {
      snapshot = lastSnapshot.img
      window.zook.page.show(null)
      return
    }
    let cancelled = false
    window.zook.page.capture(id).then((img) => {
      if (cancelled) return
      snapshot = img
      if (img) lastSnapshot = { pageId: id, img }
      window.zook.page.show(null)
    })
    return () => {
      cancelled = true
    }
  })

  function supportedVertical(vertical: Vertical | undefined): Vertical {
    const status = settingsStatus
    const supports = status?.providers.find((p) => p.id === status.active)?.supports ?? ['web']
    return vertical && supports.includes(vertical) ? vertical : 'web'
  }

  // A search keeps the current vertical unless one is given.
  async function runSearch(query: string, page = 0, vertical = view.search?.vertical) {
    query = query.trim()
    if (!query) return
    if (settingsStatus && !activeReady) {
      pendingSearch = { query, vertical }
      openSettings('search')
      return
    }
    vertical = supportedVertical(vertical)
    const token = ++searchToken
    // The same query keeps its AI chat and selected type (e.g. when switching provider); a different one doesn't.
    const prev = view.search?.query === query ? view.search : null
    view.go('search')
    view.search = {
      query,
      vertical,
      results: [],
      page,
      hasMore: false,
      loading: true,
      error: '',
      token,
      chatId: prev?.chatId ?? null,
      ai: prev?.ai ?? false
    }
    try {
      const res = await window.zook.search(vertical, query, page)
      if (view.search?.token !== token) return
      view.search = { ...view.search, results: res.results, hasMore: res.hasMore, loading: false }
    } catch (e) {
      if (view.search?.token !== token) return
      view.search = { ...view.search, loading: false, error: errorMessage(e) }
    }
  }

  function toUrl(text: string): string | null {
    if (/^https?:\/\//i.test(text)) return text
    if (/^localhost(:\d+)?(\/\S*)?$/i.test(text)) return `http://${text}`
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(text) && !/\s/.test(text)) return `https://${text}`
    return null
  }

  // Address bar and home search box: URLs are opened directly, anything else is searched.
  function navigate(text: string) {
    const url = toUrl(text.trim())
    if (url) view.open(url)
    else runSearch(text)
  }

  function pickSuggestion(s: Suggestion) {
    if (s.kind === 'page') view.open(s.url)
    else runSearch(s.text)
  }

  // Leaving AI for the vertical already loaded shows its results again without searching;
  // any other vertical is searched. The chat stays with the query either way.
  function showVertical(vertical: Vertical) {
    const s = view.search
    if (!s) return
    s.ai = false
    if (vertical !== s.vertical) runSearch(s.query, 0, vertical)
  }

  // AI as a result type: asks about the query the first time, then shows that same chat.
  function showAI() {
    const s = view.search
    if (!s || s.ai) return
    s.ai = true
    if (s.chatId && (s.chatId === chats.currentId || chats.list.some((t) => t.id === s.chatId))) return
    s.chatId = chats.ask(s.query, groundedFor(settingsStatus)).id
  }

  function openThread(id: string) {
    view.go('chat')
    chats.open(id)
  }

  // Deleting a chat also forgets it as its search's AI answer.
  function deleteThread(id: string) {
    const wasCurrent = id === chats.currentId
    if (view.search?.chatId === id) {
      view.search.chatId = null
      view.search.ai = false
    }
    chats.remove(id)
    // There's no blank chat to fall back on, so leaving the deleted one shows the search view instead.
    if (wasCurrent && view.showing === 'chat') view.go('search')
  }

  function setSidebar(open: boolean) {
    sidebarOpen = open
    window.zook.settings.setSidebar(open)
  }

  function openSettings(section?: SettingsSection) {
    settingsSection = section
    settingsOpen = true
  }

  async function switchProvider(id: ProviderId) {
    settingsStatus = await window.zook.settings.setActive(id)
    if (view.search) runSearch(view.search.query)
  }

  function onSettingsChange(s: SettingsStatus) {
    settingsStatus = s
    const ready = s.providers.some((p) => p.id === s.active && p.source !== 'none')
    if (ready && pendingSearch) {
      const { query, vertical } = pendingSearch
      pendingSearch = null
      settingsOpen = false
      runSearch(query, 0, vertical)
    }
  }

  // Esc closes the top popup when the app has focus. Inside the page, Esc stays the page's own key.
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && view.page && !overlayOpen) view.closeTop()
  }

  // How much further in each stacked popup sits than the one beneath, so their edges show.
  const STACK_STEP = 14

  function host(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  }

  function onShortcut(shortcut: Shortcut) {
    if (shortcut === 'focus-address') address?.focus()
    else if (shortcut === 'history') historyOpen = !historyOpen
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app">
  {#if sidebarOpen}
    <Sidebar
      activeId={view.showing === 'chat' || aiChat ? chats.currentId : null}
      onselect={openThread}
      ondelete={deleteThread}
      oncollapse={() => setSidebar(false)}
    />
  {/if}

  <div class="main">
    <nav class="toolbar" aria-label="Navigation">
      {#if sidebarOpen === false}
        <button onclick={() => setSidebar(true)} title="Show chats" aria-label="Show chats"><Icon name="menu" /></button>
      {/if}

      <div class="address" class:focused={addressFocused}>
        <SuggestInput
          bind:this={address}
          bind:value={addressInput}
          id="address"
          placeholder="Search or enter address"
          selectOnFocus
          onsubmit={navigate}
          onpick={pickSuggestion}
          onopenchange={(open) => (addressOpen = open)}
          onfocuschange={(focused) => (addressFocused = focused)}
        />
      </div>

      <button onclick={() => (historyOpen = true)} title="History (Ctrl+H)" aria-label="History"><Icon name="history" /></button>
      <button onclick={() => openSettings()} title="Settings" aria-label="Settings"><Icon name="settings" /></button>
    </nav>

    <div class="content">
      {#if view.showing === 'chat'}
        {#if chats.current}
          {#key chats.current.id}
            <Chat
              chat={chats.current}
              settings={settingsStatus}
              onopen={(url) => view.open(url)}
              onopensettings={(chatSection) => openSettings(chatSection ? 'chat' : 'search')}
            />
          {/key}
        {/if}
      {:else if !view.search}
        <div class="home">
          <div class="home-box">
            <SuggestInput
              bind:value={homeInput}
              placeholder="Search or enter address"
              autofocus
              onsubmit={navigate}
              onpick={pickSuggestion}
              onopenchange={(open) => (homeOpen = open)}
            />
          </div>
        </div>
      {:else}
        <SearchPage
          search={view.search}
          settings={settingsStatus}
          onsearch={runSearch}
          onvertical={showVertical}
          onopen={(url) => view.open(url)}
          onswitchprovider={switchProvider}
          onopensettings={() => openSettings('search')}
          onaskai={showAI}
        >
          {#snippet ai()}
            {#if aiChat}
              {#key aiChat.id}
                <Chat
                  chat={aiChat}
                  inline
                  settings={settingsStatus}
                  onopen={(url) => view.open(url)}
                  onopensettings={(chatSection) => openSettings(chatSection ? 'chat' : 'search')}
                />
              {/key}
            {/if}
          {/snippet}
        </SearchPage>
      {/if}

      <!-- Web pages open in a stack of popups over the view, which stays as it was underneath. Only the top
           popup is live; the ones beneath show how they looked when covered. -->
      {#if view.pages.length}
        <div class="popup-backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && view.closeAll()}>
          <div class="popup-stack">
            {#each view.pages as p, i (p.id)}
              {@const top = i === view.pages.length - 1}
              {@const url = p.state?.url || p.pendingUrl}
              {@const blocked = settingsStatus?.adblock ? (p.state?.blocked ?? 0) : 0}
              <div
                class="popup"
                class:under={!top}
                style:inset="{i * STACK_STEP}px"
                role="dialog"
                aria-modal={top ? 'true' : undefined}
                aria-hidden={top ? undefined : 'true'}
                aria-label={p.state?.title || 'Web page'}
              >
                <header class="popup-bar">
                  {#if p.state?.favicon}
                    <img class="favicon" src={p.state.favicon} alt="" width="16" height="16" />
                  {:else}
                    <span class="favicon globe"><Icon name="globe" /></span>
                  {/if}
                  <span class="popup-title" title={url}>
                    <span class="popup-name">{p.state?.title || host(url)}</span>
                    <span class="popup-host">{host(url)}</span>
                  </span>
                  {#if top}
                    <!-- The blocked count sits on the shield's top-right corner. -->
                    <button
                      class="shield"
                      class:off={!settingsStatus?.adblock}
                      onclick={() => openSettings('general')}
                      title={settingsStatus?.adblock
                        ? `${p.state?.blocked ?? 0} ads and trackers blocked on this page`
                        : 'Ad blocking is off'}
                      aria-label="Ad blocking"
                    >
                      <span class="shield-icon">
                        <Icon name="shield" />
                        {#if blocked}<span class="shield-count">{blocked > 99 ? '99+' : blocked}</span>{/if}
                      </span>
                    </button>
                    <button onclick={() => window.zook.page.openExternal(p.id)} title="Open in system browser" aria-label="Open in system browser">
                      <Icon name="external" />
                    </button>
                    <button onclick={() => view.closeTop()} title="Close (Esc)" aria-label="Close">
                      <Icon name="close" />
                    </button>
                    <div class="progress" class:active={p.state?.loading ?? true}></div>
                  {/if}
                </header>
                {#if top}
                  <div class="viewport" bind:this={viewport}>
                    {#if snapshot}<img class="snapshot" src={snapshot} alt="" />{/if}
                  </div>
                {:else}
                  <div class="viewport">
                    {#if p.snapshot}<img class="snapshot" src={p.snapshot} alt="" />{/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>

{#if settingsOpen}
  <Settings
    status={settingsStatus}
    section={settingsSection}
    onclose={() => {
      settingsOpen = false
      settingsSection = undefined
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
      runSearch(q)
    }}
    onopen={(url) => {
      historyOpen = false
      view.open(url)
    }}
  />
{/if}

<style>
  .app { height: 100%; display: flex; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  .toolbar > button {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--muted);
    cursor: pointer;
    transition: background-color 0.12s, color 0.12s;
  }
  .toolbar > button:hover { background: var(--surface); color: var(--fg); }
  .address {
    flex: 1;
    min-width: 0;
    height: 34px;
    margin: 0 6px;
    padding: 0 14px;
    border: 1px solid transparent;
    border-radius: 17px;
    background: var(--surface);
    font-size: 14px;
    display: flex;
    transition: background-color 0.12s, border-color 0.12s, box-shadow 0.12s;
  }
  .address.focused { background: var(--bg); border-color: var(--focus-border); box-shadow: var(--focus-ring); }
  /* Sits a little above centre, where the eye lands on an empty window. */
  .home { height: 100%; display: flex; justify-content: center; align-items: flex-start; padding: 24vh 24px 0; }
  .home-box {
    width: 100%;
    max-width: 600px;
    height: 46px;
    padding: 0 14px;
    border: 1px solid var(--box-border);
    border-radius: 23px;
    background: var(--bg);
    box-shadow: var(--box-shadow);
    font-size: 16px;
    display: flex;
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  .home-box:hover { box-shadow: var(--box-shadow-raised); }
  .home-box:focus-within { border-color: var(--focus-border); box-shadow: var(--box-shadow-raised), var(--focus-ring); }
  .progress { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: transparent; }
  .progress.active {
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    background-size: 200% 100%;
    animation: slide 1s linear infinite;
  }
  @keyframes slide { from { background-position: 100% 0; } to { background-position: -100% 0; } }

  /* Each view scrolls inside itself (results, transcript), so the content area never does. */
  .content { flex: 1; min-height: 0; overflow: hidden; position: relative; }

  /* The popup covers the content area only, so the toolbar and sidebar stay usable around it. */
  .popup-backdrop {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
    padding: clamp(10px, 2.5vw, 28px);
    background: rgb(0 0 0 / 0.4);
  }
  .popup-stack { position: relative; flex: 1; min-width: 0; }
  /* Each popup is inset a step further than the one beneath (set inline), so the stack's edges show. */
  .popup {
    position: absolute;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--box-border);
    border-radius: 12px;
    background: var(--bg);
    box-shadow: 0 16px 48px rgb(0 0 0 / 0.25), 0 2px 6px rgb(0 0 0 / 0.08);
    overflow: hidden;
  }
  /* Popups beneath the top one show only their edges, dimmed so the top one reads as active. */
  .popup.under .popup-bar, .popup.under .viewport { opacity: 0.7; }
  .popup-bar {
    position: relative;
    flex-shrink: 0;
    /* The same height whether or not the action buttons are there. */
    min-height: 41px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 6px 4px 14px;
    border-bottom: 1px solid var(--box-border);
  }
  .favicon { flex-shrink: 0; width: 16px; height: 16px; margin-right: 10px; border-radius: 3px; }
  .globe { display: flex; color: var(--muted); }
  .popup-title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; overflow: hidden; white-space: nowrap; }
  .popup-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .popup-host { flex-shrink: 0; font-size: 12px; color: var(--muted); }
  .popup-bar > button {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-width: 32px;
    height: 32px;
    padding: 0 8px;
    border: 0;
    border-radius: 16px;
    background: none;
    color: var(--muted);
    cursor: pointer;
    transition: background-color 0.12s, color 0.12s;
  }
  .popup-bar > button:hover { background: var(--surface); color: var(--fg); }
  .shield-icon { position: relative; display: inline-flex; }
  /* Centred on the icon's top-right corner, so it sits half inside and half outside it whatever its width.
     Only as wide as its digits, on a soft translucent backing with a hairline edge and a gentle shadow.
     The backing stays mostly opaque so the shield's outline doesn't run through the digits. */
  .shield-count {
    position: absolute;
    top: 0;
    left: 100%;
    transform: translate(-50%, -50%);
    min-width: 12px;
    height: 12px;
    padding: 0 2px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--surface) 85%, transparent);
    backdrop-filter: blur(3px);
    box-shadow: 0 0 0 0.5px var(--box-border), 0 1px 3px rgb(0 0 0 / 0.15);
    color: var(--fg);
    font-size: 8px;
    font-weight: 700;
    line-height: 12px;
    letter-spacing: -0.2px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .shield.off :global(.icon) { opacity: 0.45; }
  /* The page's native view is fitted to this box; its corners are rounded to match in main. */
  .viewport { flex: 1; position: relative; overflow: hidden; }
  .snapshot { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: top left; }
</style>

<script lang="ts" module>
  export type SettingsSection = 'search' | 'chat' | 'general' | 'updates' | 'licenses'
</script>

<script lang="ts">
  import type { ProviderId } from '../../main/providers'
  import type { ChatBackendStatus, ProviderStatus, SettingsStatus } from '../../main/settings'
  import Icon, { type IconName } from './Icon.svelte'
  import Licenses from './Licenses.svelte'
  import { errorMessage } from './errors'
  import { formatSize, installLabel, updates } from './updates.svelte'

  let {
    status,
    section,
    onclose,
    onchange
  }: {
    status: SettingsStatus | null
    // Where to open; defaults to Search.
    section?: SettingsSection
    onclose: () => void
    onchange: (status: SettingsStatus) => void
  } = $props()

  // The credential form that's open. There is only ever one, across every section.
  // `chat:new` is a custom backend being added.
  type Target = `provider:${ProviderId}` | `chat:${string}` | 'suggest'
  const NEW_CHAT = 'chat:new'

  let current = $state<SettingsSection>('search')
  let editing = $state<Target | null>(null)
  let values = $state<Record<string, string>>({})
  let reveal = $state(false)
  let busy = $state(false)
  let error = $state('')
  let confirmRemove = $state(false)

  const activeProvider = $derived(status?.providers.find((p) => p.id === status.active && p.source !== 'none'))
  const chatReady = $derived(Boolean(status?.chat.active))

  const sections = $derived<{ id: SettingsSection; label: string; icon: IconName; needsSetup: boolean }[]>([
    { id: 'search', label: 'Search', icon: 'search', needsSetup: Boolean(status) && !activeProvider },
    { id: 'chat', label: 'AI chat', icon: 'chat', needsSetup: Boolean(status) && !chatReady },
    { id: 'general', label: 'General', icon: 'settings', needsSetup: false },
    { id: 'updates', label: 'Updates', icon: 'download', needsSetup: false },
    { id: 'licenses', label: 'Licenses', icon: 'license', needsSetup: false }
  ])
  // Opens on the requested section once settings have loaded, with its form ready if it isn't set up.
  let opened = false
  $effect(() => {
    if (opened || !status) return
    opened = true
    go(section ?? 'search')
  })

  function go(to: SettingsSection) {
    current = to
    cancelEdit()
    if (!status) return
    if (to === 'search' && !status.providers.some((p) => p.source !== 'none')) {
      editProvider(status.providers.find((p) => p.id === status.active) ?? status.providers[0])
    }
  }

  function startEdit(target: Target, initial: Record<string, string>) {
    editing = target
    values = initial
    reveal = false
    error = ''
    confirmRemove = false
  }

  function cancelEdit() {
    editing = null
    error = ''
    confirmRemove = false
  }

  // Saving checks the key against the service first, so this can take a moment.
  async function apply(action: () => Promise<SettingsStatus>) {
    busy = true
    error = ''
    try {
      onchange(await action())
      editing = null
      confirmRemove = false
    } catch (err) {
      error = errorMessage(err)
    } finally {
      busy = false
    }
  }

  // Esc backs out one step at a time, so a half-typed key isn't lost by closing the dialog.
  function onkeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    if (confirmRemove) confirmRemove = false
    else if (editing) cancelEdit()
    else onclose()
  }

  function autofocus(el: HTMLElement, on?: boolean) {
    if (on) el.focus()
  }

  // Search providers

  function editProvider(p: ProviderStatus) {
    startEdit(`provider:${p.id}`, Object.fromEntries(p.fields.map((f) => [f.id, ''])))
  }

  function saveProvider(e: SubmitEvent, p: ProviderStatus) {
    e.preventDefault()
    apply(() => window.zook.settings.save(p.id, $state.snapshot(values)))
  }

  async function activate(p: ProviderStatus) {
    if (p.source === 'none' || status?.active === p.id) return
    onchange(await window.zook.settings.setActive(p.id))
  }

  // AI chat

  // The backend whose form is open, or null for a new custom one.
  let chatId = $state<string | null>(null)
  // Built-in backends fill in their own endpoint; it's only shown as a field for custom ones, or when asked for.
  let customUrl = $state(false)
  const chatBackend = $derived(chatId === null ? undefined : status?.chat.backends.find((b) => b.id === chatId))
  const chatCustom = $derived(chatId === null || Boolean(chatBackend?.custom))
  const chatNeedsKey = $derived(Boolean(chatBackend?.needsKey))

  function editChat(b: ChatBackendStatus) {
    chatId = b.id
    startEdit(`chat:${b.id}`, {
      name: b.custom ? b.name : '',
      protocol: b.protocol,
      baseUrl: b.baseUrl,
      model: b.model,
      apiKey: ''
    })
    customUrl = b.custom || b.baseUrl !== b.defaultBaseUrl
    typeModel = false
  }

  function addCustomChat() {
    chatId = null
    startEdit(NEW_CHAT, { name: '', protocol: 'openai', baseUrl: '', model: '', apiKey: '' })
    customUrl = true
    typeModel = false
  }

  async function activateChat(b: ChatBackendStatus) {
    if (b.source === 'none' || status?.chat.active === b.id) return
    onchange(await window.zook.settings.setActiveChat(b.id))
  }

  function normalizeUrl(url: string | undefined): string {
    return (url ?? '').trim().replace(/\/+$/, '')
  }

  function hostOf(url: string | undefined): string {
    try {
      return new URL(normalizeUrl(url)).host
    } catch {
      return ''
    }
  }

  // A saved key is kept when the field is left blank, but only for the same endpoint.
  const chatKeyKept = $derived(
    Boolean(chatBackend && chatBackend.source !== 'none' && chatBackend.hint) &&
      chatBackend?.baseUrl === normalizeUrl(values.baseUrl)
  )

  function chatForm() {
    return {
      name: values.name ?? '',
      protocol: values.protocol ?? '',
      baseUrl: values.baseUrl ?? '',
      model: values.model ?? '',
      apiKey: values.apiKey ?? ''
    }
  }

  // The backend's models, fetched once the endpoint (and key, where needed) are filled in.
  let models = $state<string[]>([])
  let modelsLoading = $state(false)
  let modelsError = $state('')
  // Type a model id instead of picking one, e.g. when it isn't listed.
  let typeModel = $state(false)
  let modelsRequest = 0

  $effect(() => {
    if (!editing?.startsWith('chat:')) return
    // Only what the list depends on, so picking a model or naming the backend doesn't refetch it.
    const form = { protocol: values.protocol ?? '', baseUrl: values.baseUrl ?? '', apiKey: values.apiKey ?? '' }
    const id = chatId
    const ready =
      /^https?:\/\/[^/]/i.test(form.baseUrl.trim()) && (!chatNeedsKey || form.apiKey.trim() !== '' || chatKeyKept)
    const request = ++modelsRequest
    models = []
    modelsError = ''
    modelsLoading = ready
    if (!ready) return
    // Waits for typing to pause, so a half-typed key or URL isn't sent.
    const timer = setTimeout(async () => {
      try {
        const list = await window.zook.settings.listChatModels(id, form)
        if (request === modelsRequest) models = list
      } catch (err) {
        if (request === modelsRequest) modelsError = errorMessage(err)
      } finally {
        if (request === modelsRequest) modelsLoading = false
      }
    }, 400)
    return () => clearTimeout(timer)
  })

  // The current model stays selectable even when the backend doesn't list it.
  const modelOptions = $derived(
    values.model?.trim() && !models.includes(values.model.trim()) ? [values.model.trim(), ...models] : models
  )

  function saveChat(e: SubmitEvent) {
    e.preventDefault()
    apply(() => window.zook.settings.saveChat(chatId, chatForm()))
  }

  let groundedError = $state('')

  // Like the other switches, a failure is shown rather than leaving the switch flipped with nothing saved.
  async function setGrounded(grounded: boolean) {
    groundedError = ''
    try {
      onchange(await window.zook.settings.setChatGrounded(grounded))
    } catch (err) {
      groundedError = errorMessage(err)
    }
  }

  // General

  let adblockBusy = $state(false)
  let adblockError = $state('')

  async function toggleAdblock(enabled: boolean) {
    adblockBusy = true
    adblockError = ''
    try {
      onchange(await window.zook.settings.setAdblock(enabled))
    } catch (err) {
      adblockError = errorMessage(err)
    } finally {
      adblockBusy = false
    }
  }

  // Updates

  const update = $derived(updates.status)
  const updateState = $derived(update?.state)
  const updateRelease = $derived(updateState && 'release' in updateState ? updateState.release : undefined)

  function formatDate(iso: string): string {
    const date = new Date(iso)
    return isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { dateStyle: 'medium' })
  }

  let logsError = $state('')

  async function openLogs() {
    logsError = ''
    try {
      await window.zook.logs.open()
    } catch (err) {
      logsError = errorMessage(err)
    }
  }

  function saveSuggest(e: SubmitEvent) {
    e.preventDefault()
    apply(() => window.zook.settings.saveSuggestKey(values.apiKey))
  }
</script>

<svelte:window {onkeydown} />

{#snippet keyState(source: 'settings' | 'env' | 'none', hint: string)}
  {#if source === 'settings'}
    <code>{hint}</code>
  {:else if source === 'env'}
    <code>{hint}</code> · .env
  {:else}
    Not set up
  {/if}
{/snippet}

{#snippet field(id: string, label: string, opts: { secret?: boolean; placeholder?: string; optional?: boolean; focus?: boolean })}
  <label class="field-label">
    <span>{label}{#if opts.optional}<span class="optional"> · optional</span>{/if}</span>
    <span class="field">
      <input
        type={opts.secret && !reveal ? 'password' : 'text'}
        bind:value={values[id]}
        placeholder={opts.placeholder ?? ''}
        autocomplete="off"
        spellcheck="false"
        use:autofocus={opts.focus}
      />
      {#if opts.secret && values[id]}
        <button
          type="button"
          class="reveal"
          onclick={() => (reveal = !reveal)}
          title={reveal ? 'Hide' : 'Show'}
          aria-label={reveal ? 'Hide key' : 'Show key'}
        >
          <Icon name={reveal ? 'eye-closed' : 'eye'} />
        </button>
      {/if}
    </span>
  </label>
{/snippet}

{#snippet formActions(removable: boolean, onremove: () => void, disabled: boolean)}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="actions">
    {#if removable}
      {#if confirmRemove}
        <button type="button" class="btn" onclick={() => (confirmRemove = false)}>Keep</button>
        <button type="button" class="btn danger" disabled={busy} onclick={onremove}>Confirm remove</button>
      {:else}
        <button type="button" class="btn quiet danger" onclick={() => (confirmRemove = true)}>Remove</button>
      {/if}
    {/if}
    <span class="spacer"></span>
    {#if !confirmRemove}
      <button type="button" class="btn" onclick={cancelEdit}>Cancel</button>
      <button type="submit" class="btn primary" disabled={busy || disabled}>{busy ? 'Checking…' : 'Save'}</button>
    {/if}
  </div>
{/snippet}

{#snippet getKey(url: string)}
  <a href={url} target="_blank" rel="noreferrer">Get a key <Icon name="external" /></a>
{/snippet}

{#snippet chatSetup(b: ChatBackendStatus | undefined)}
  <form onsubmit={saveChat}>
    {#if chatCustom}
      {@render field('name', 'Name', { placeholder: hostOf(values.baseUrl) || 'My backend', focus: true })}
      <label class="field-label">
        <span>API format</span>
        <span class="field">
          <select bind:value={values.protocol}>
            {#each status?.chat.protocols ?? [] as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
          </select>
        </span>
      </label>
    {:else if b?.note || b?.signupUrl}
      <p class="hint">
        {b.note ?? ''}
        {#if b.signupUrl}{@render getKey(b.signupUrl)}{/if}
      </p>
    {/if}
    {#if customUrl}
      {@render field('baseUrl', 'Endpoint', { placeholder: 'https://example.com/v1' })}
    {:else}
      <p class="hint">
        <code>{values.baseUrl}</code>
        <button type="button" class="link" onclick={() => (customUrl = true)}>Change URL</button>
      </p>
    {/if}
    {@render field('apiKey', 'API key', {
      secret: true,
      optional: !chatNeedsKey,
      placeholder: chatKeyKept ? `Keep ${b?.hint}` : '',
      focus: !chatCustom
    })}
    {#if typeModel || (!modelsLoading && models.length === 0)}
      {@render field('model', 'Model', { placeholder: 'model id', focus: typeModel })}
    {:else}
      <label class="field-label">
        <span>Model</span>
        <span class="field">
          <select
            value={values.model}
            disabled={modelsLoading}
            onchange={(e) => {
              if (e.currentTarget.value === '') typeModel = true
              else values.model = e.currentTarget.value
            }}
          >
            {#if modelsLoading}
              <option value={values.model}>Loading models…</option>
            {:else}
              {#each modelOptions as m (m)}<option value={m}>{m}</option>{/each}
              <option value="">Other…</option>
            {/if}
          </select>
        </span>
      </label>
    {/if}
    {#if modelsError && !typeModel}
      <p class="hint">Couldn't load models: {modelsError}</p>
    {:else if typeModel && models.length > 0}
      <p class="hint"><button type="button" class="link" onclick={() => (typeModel = false)}>Pick from list</button></p>
    {/if}
    {@render formActions(
      b?.source === 'settings',
      () => b && apply(() => window.zook.settings.clearChat(b.id)),
      !values.baseUrl?.trim() || !values.model?.trim() || (chatNeedsKey && !values.apiKey?.trim() && !chatKeyKept)
    )}
  </form>
{/snippet}

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header>
      <h2 id="settings-title">Settings</h2>
      <button class="close" onclick={onclose} title="Close (Esc)" aria-label="Close"><Icon name="close" /></button>
    </header>

    <div class="body">
      <nav aria-label="Settings sections">
        {#each sections as s (s.id)}
          <button class:current={current === s.id} aria-current={current === s.id ? 'page' : undefined} onclick={() => go(s.id)}>
            <Icon name={s.icon} />
            <span class="nav-label">{s.label}</span>
            {#if s.needsSetup}<span class="dot" aria-label="Needs setting up"></span>{/if}
          </button>
        {/each}
        {#if status && !status.canEncrypt}
          <p class="nav-note">No keyring found: keys are stored unencrypted.</p>
        {/if}
      </nav>

      <div class="content">
        {#if !status}
          <p class="muted">Loading…</p>
        {:else if current === 'search'}
          <ul class="cards">
            {#each status.providers as p (p.id)}
              {@const target: Target = `provider:${p.id}`}
              {@const configured = p.source !== 'none'}
              {@const active = status.active === p.id && configured}
              <li class="card" class:active class:open={editing === target}>
                <div class="card-head">
                  <label class="pick" class:disabled={!configured} title={configured ? `Search with ${p.name}` : 'Add a key first'}>
                    <input type="radio" name="provider" checked={active} disabled={!configured} onchange={() => activate(p)} />
                    <span class="name">{p.name}</span>
                    <span class="state">{@render keyState(p.source, p.hint)}</span>
                  </label>
                  {#if editing !== target}
                    <button class="btn" class:primary={!configured && !activeProvider} onclick={() => editProvider(p)}>
                      {configured ? 'Change' : 'Add key'}
                    </button>
                  {/if}
                </div>
                {#if editing === target}
                  <form onsubmit={(e) => saveProvider(e, p)}>
                    {#if p.note}<p class="warn">{p.note}</p>{/if}
                    <p class="hint">{@render getKey(p.signupUrl)}</p>
                    {#each p.fields as f, i (f.id)}
                      {@render field(f.id, f.label, { secret: f.secret, placeholder: f.placeholder, focus: i === 0 })}
                    {/each}
                    {@render formActions(
                      p.source === 'settings',
                      () => apply(() => window.zook.settings.clear(p.id)),
                      p.fields.some((f) => !values[f.id]?.trim())
                    )}
                  </form>
                {/if}
              </li>
            {/each}
          </ul>
        {:else if current === 'chat'}
          <ul class="cards">
            {#each status.chat.backends as b (b.id)}
              {@const target: Target = `chat:${b.id}`}
              {@const configured = b.source !== 'none'}
              {@const active = status.chat.active === b.id}
              <li class="card" class:active class:open={editing === target}>
                <div class="card-head">
                  <label class="pick" class:disabled={!configured} title={configured ? `Chat with ${b.name}` : 'Set it up first'}>
                    <input type="radio" name="chat-backend" checked={active} disabled={!configured} onchange={() => activateChat(b)} />
                    <span class="name">
                      {b.name}{#if b.custom}<span class="optional">
                          · {status.chat.protocols.find((p) => p.id === b.protocol)?.name}</span
                        >{/if}
                    </span>
                    <span class="state">
                      {#if configured}
                        <code class="model">{b.model}</code>
                        {#if b.hint}<code>{b.hint}</code>{/if}
                        {#if b.source === 'env'}· .env{/if}
                      {:else}
                        Not set up
                      {/if}
                    </span>
                  </label>
                  {#if editing !== target}
                    <button class="btn" class:primary={!configured && !chatReady} onclick={() => editChat(b)}>
                      {configured ? 'Change' : 'Set up'}
                    </button>
                  {/if}
                </div>
                {#if editing === target}{@render chatSetup(b)}{/if}
              </li>
            {/each}
            {#if editing === NEW_CHAT}
              <li class="card open">
                <div class="card-head"><span class="name">New custom backend</span></div>
                {@render chatSetup(undefined)}
              </li>
            {/if}
          </ul>
          {#if editing !== NEW_CHAT}
            <button class="add" onclick={addCustomChat}><Icon name="plus" /> Custom backend</button>
          {/if}

          <!-- Always shows and saves the preference itself. Without a search provider it can't take effect yet,
               which the row says, rather than the switch pretending to be off and refusing to change. -->
          <label class="switch-row card">
            <input
              type="checkbox"
              role="switch"
              class="switch"
              checked={status.chat.grounded}
              onchange={(e) => setGrounded(e.currentTarget.checked)}
            />
            <span class="name">Let AI search the web</span>
            {#if !activeProvider}
              <span class="state warn">
                No search provider
                <button type="button" class="link" onclick={() => go('search')}>Set up</button>
              </span>
            {/if}
          </label>
          {#if groundedError}<p class="error" role="alert">{groundedError}</p>{/if}
        {:else if current === 'general'}
          <label class="switch-row card">
            <input
              type="checkbox"
              role="switch"
              class="switch"
              checked={status.adblock}
              disabled={adblockBusy}
              onchange={(e) => toggleAdblock(e.currentTarget.checked)}
            />
            <span class="name">Block ads and trackers</span>
            {#if adblockBusy}<span class="state">Loading…</span>{/if}
          </label>
          {#if adblockError}<p class="error" role="alert">{adblockError}</p>{/if}

          <div class="card" class:open={editing === 'suggest'}>
            <div class="card-head">
              <span class="name">Online suggestions<span class="optional"> · Brave</span></span>
              <span class="state">{@render keyState(status.suggest.source, status.suggest.hint)}</span>
              {#if editing !== 'suggest'}
                <button class="btn" onclick={() => startEdit('suggest', { apiKey: '' })}>
                  {status.suggest.source === 'none' ? 'Add key' : 'Change'}
                </button>
              {/if}
            </div>
            {#if editing === 'suggest'}
              <form onsubmit={saveSuggest}>
                <p class="hint">Brave Autosuggest plan, separate from Brave Search. {@render getKey('https://brave.com/search/api/')}</p>
                {@render field('apiKey', 'API key', { secret: true, focus: true })}
                {@render formActions(
                  status.suggest.source === 'settings',
                  () => apply(() => window.zook.settings.clearSuggestKey()),
                  !values.apiKey?.trim()
                )}
              </form>
            {/if}
          </div>

          <div class="card">
            <div class="card-head">
              <span class="name">Logs<span class="optional"> · errors and crash reports, kept on this device</span></span>
              <button class="btn" onclick={openLogs}>Open folder</button>
            </div>
          </div>
          {#if logsError}<p class="error" role="alert">{logsError}</p>{/if}
        {:else if current === 'licenses'}
          <Licenses />
        {:else if update && updateState}
          <div class="card" class:open={Boolean(updateRelease)}>
            <div class="card-head">
              <span class="name">Zook {update.current}</span>
              <span class="state" class:warn={updateState.phase === 'error'}>
                {#if updateState.phase === 'checking'}
                  Checking…
                {:else if updateState.phase === 'current'}
                  Up to date
                {:else if updateState.phase === 'available'}
                  {updateState.release.version} available{#if updateState.release.size}<span>
                      · {formatSize(updateState.release.size)}</span
                    >{/if}
                {:else if updateState.phase === 'downloading'}
                  {formatSize(updateState.received)} of {formatSize(updateState.release.size ?? 0)}
                {:else if updateState.phase === 'ready'}
                  {updateState.release.version} {update.install === 'appimage' ? 'installed' : 'downloaded'}
                {/if}
              </span>
              {#if updateState.phase === 'downloading'}
                <button class="btn" onclick={updates.cancel}>Cancel</button>
              {:else if updateState.phase === 'ready'}
                <button class="btn primary" onclick={updates.install}>{installLabel(update)}</button>
              {:else if updateRelease && update.install !== 'link'}
                <button class="btn primary" onclick={updates.download}>
                  {updateState.phase === 'error' ? 'Try again' : 'Download and install'}
                </button>
              {:else if updateRelease}
                <a class="btn primary" href={updateRelease.url} target="_blank" rel="noreferrer">Download <Icon name="external" /></a>
              {:else}
                <button class="btn" disabled={!update.canCheck || updateState.phase === 'checking'} onclick={updates.check}>
                  Check now
                </button>
              {/if}
            </div>
            {#if updateState.phase === 'downloading'}
              <progress class="progress" max={updateState.release.size ?? 0} value={updateState.received}></progress>
            {/if}
            {#if updateRelease}
              <div class="release">
                <p class="hint">
                  What's new in {updateRelease.version}{#if formatDate(updateRelease.date)}<span> · {formatDate(updateRelease.date)}</span>{/if}
                  · <a href={updateRelease.url} target="_blank" rel="noreferrer">Release page <Icon name="external" /></a>
                </p>
                {#if updateRelease.notes}<p class="notes">{updateRelease.notes}</p>{/if}
              </div>
            {/if}
          </div>
          {#if updateState.phase === 'error'}<p class="error" role="alert">{updateState.message}</p>{/if}
          {#if updates.error}<p class="error" role="alert">{updates.error}</p>{/if}
          {#if update.reason}
            <p class="hint">
              {update.reason}
              <a href={update.releasesUrl} target="_blank" rel="noreferrer">Releases <Icon name="external" /></a>
            </p>
          {/if}

          <label class="switch-row card">
            <input
              type="checkbox"
              role="switch"
              class="switch"
              checked={update.auto}
              disabled={!update.canCheck}
              onchange={(e) => updates.setAuto(e.currentTarget.checked)}
            />
            <span class="name">Check for updates automatically</span>
            {#if update.checkedAt}
              <span class="state">Last checked {new Date(update.checkedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>
            {/if}
          </label>
          <p class="hint">
            Updates come from GitHub releases and are only installed once their signature and checksum check out.
          </p>
        {:else}
          <p class="muted">Loading…</p>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgb(0 0 0 / 0.4);
  }
  /* A fixed size, so moving between sections doesn't make the dialog jump. */
  .panel {
    width: 100%;
    max-width: 720px;
    height: min(560px, calc(100vh - 32px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--box-border);
    border-radius: 12px;
    background: var(--bg);
    box-shadow: 0 10px 40px rgb(0 0 0 / 0.3);
  }
  header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px 8px 18px;
    border-bottom: 1px solid var(--border);
  }
  h2 { margin: 0; font-size: 16px; }
  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .close:hover { background: var(--surface); color: var(--fg); }

  .body { flex: 1; min-height: 0; display: flex; }

  nav {
    flex: 0 0 160px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 6px;
    border-right: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 50%, var(--bg));
    overflow-y: auto;
  }
  nav button {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--muted);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.12s, color 0.12s;
  }
  nav button:hover { background: var(--surface); color: var(--fg); }
  nav button.current { background: var(--surface); color: var(--fg); }
  .nav-label { flex: 1; font-size: 14px; font-weight: 500; }
  .dot { flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%; background: var(--error); }
  .nav-note { margin: auto 6px 4px; padding-top: 8px; font-size: 12px; line-height: 1.4; color: var(--error); }

  .content { flex: 1; min-width: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 14px 16px 20px; }
  p { margin: 4px 0; font-size: 13px; line-height: 1.45; }
  .hint { margin: 0 0 4px; font-size: 13px; color: var(--muted); }
  a { color: var(--link); white-space: nowrap; }
  code { padding: 1px 6px; border-radius: 4px; background: var(--surface); font-size: 12px; }
  .muted { color: var(--muted); }
  .optional { font-weight: 400; color: var(--muted); }
  .warn, .error { color: var(--error); }
  .error { font-size: 13px; }

  .cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .card {
    display: block;
    padding: 8px 12px;
    border: 1px solid var(--box-border);
    border-radius: 8px;
    background: var(--bg);
    box-shadow: var(--box-shadow);
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  .card.active { border-color: var(--focus-border); }
  .card.open { box-shadow: var(--box-shadow-raised); }
  .card-head { display: flex; align-items: center; gap: 10px; min-height: 30px; }
  .card-head > .name { flex: 1; min-width: 0; }
  .pick { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .pick .name { flex: 1; min-width: 0; }
  .pick.disabled { cursor: default; }
  .pick input { flex-shrink: 0; width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
  .name { font-size: 14px; font-weight: 500; }
  .state { flex-shrink: 0; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .state.warn { color: var(--error); }
  .state .model { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Quieter than a card, so it reads as an option rather than another backend. */
  .add {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 36px;
    border: 1px dashed var(--box-border);
    border-radius: 8px;
    background: none;
    color: var(--muted);
    font-size: 13px;
    cursor: pointer;
    transition: background-color 0.12s, color 0.12s, border-color 0.12s;
  }
  .add:hover { border-color: var(--focus-border); background: color-mix(in srgb, var(--surface) 60%, var(--bg)); color: var(--fg); }

  form { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--box-border); }
  .field-label { display: block; margin-top: 8px; font-size: 13px; }
  .field-label > span:first-child { display: block; margin-bottom: 4px; color: var(--muted); }
  .field {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 3px 0 10px;
    border: 1px solid var(--box-border);
    border-radius: 8px;
    background: var(--bg);
    box-shadow: var(--box-shadow);
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  .field:focus-within { border-color: var(--focus-border); box-shadow: var(--focus-ring); }
  /* The field's ring already shows focus. */
  .field select:focus-visible { outline: none; }
  .field input, .field select {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: 0;
    background: none;
    color: var(--fg);
    font: inherit;
    font-size: 14px;
  }
  .field input { font-family: ui-monospace, monospace; font-size: 13px; }
  .field select option { background: var(--bg); }
  .reveal {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .reveal:hover { background: var(--surface); color: var(--fg); }

  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
  .spacer { flex: 1; }
  .btn {
    height: 28px;
    padding: 0 12px;
    border: 1px solid var(--box-border);
    border-radius: 8px;
    background: var(--bg);
    box-shadow: var(--box-shadow);
    font-size: 13px;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 0.12s;
  }
  .btn:hover:not(:disabled) { background: var(--surface); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn.primary { border-color: var(--accent); background: var(--accent); color: var(--bg); font-weight: 600; }
  .btn.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
  .btn.danger { color: var(--error); }
  .btn.quiet { border-color: transparent; background: none; box-shadow: none; padding: 0 6px; }
  .link { border: 0; background: none; padding: 0; color: var(--link); font: inherit; cursor: pointer; }
  .link:hover { text-decoration: underline; }

  .switch-row { display: flex; align-items: center; gap: 10px; min-height: 30px; cursor: pointer; }
  .switch-row .name { flex: 1; min-width: 0; }
  .switch {
    appearance: none;
    position: relative;
    flex-shrink: 0;
    width: 34px;
    height: 20px;
    margin: 0;
    border-radius: 10px;
    background: var(--border);
    cursor: inherit;
    transition: background-color 0.15s;
  }
  .switch::before {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--bg);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);
    transition: transform 0.15s;
  }
  .switch:checked { background: var(--accent); }
  .switch:checked::before { transform: translateX(14px); }
  .switch:disabled { opacity: 0.5; }
  .progress { display: block; width: 100%; height: 6px; margin: 8px 0 2px; accent-color: var(--accent); }
  .release { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--box-border); }
  .notes { max-height: 220px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  a.btn { display: inline-flex; align-items: center; gap: 6px; color: inherit; text-decoration: none; }
  a.btn.primary { color: var(--bg); }
  .switch:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 50%, transparent); outline-offset: 2px; }

  /* Narrow windows: the section list becomes a row of tabs above the content. */
  @media (max-width: 720px) {
    .body { flex-direction: column; }
    nav { flex: none; flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); }
    nav button { flex-shrink: 0; }
    .nav-note { display: none; }
    .content { padding: 12px; }
  }
</style>

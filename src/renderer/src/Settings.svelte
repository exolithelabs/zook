<script lang="ts">
  import type { ProviderId } from '../../main/providers'
  import type { ProviderStatus, SettingsStatus } from '../../main/settings'
  import { errorMessage } from './errors'

  let {
    status,
    onclose,
    onchange
  }: {
    status: SettingsStatus | null
    onclose: () => void
    onchange: (status: SettingsStatus) => void
  } = $props()

  let editing = $state<ProviderId | null>(null)
  let values = $state<Record<string, string>>({})
  let reveal = $state(false)
  let saving = $state(false)
  let error = $state('')
  let message = $state<{ id: ProviderId; text: string } | null>(null)

  // Open the active provider's form when nothing is set up yet.
  $effect(() => {
    if (status && editing === null && !status.providers.some((p) => p.source !== 'none')) {
      edit(status.providers.find((p) => p.id === status.active) ?? status.providers[0])
    }
  })

  function edit(p: ProviderStatus) {
    editing = editing === p.id ? null : p.id
    values = Object.fromEntries(p.fields.map((f) => [f.id, '']))
    reveal = false
    error = ''
    message = null
  }

  async function save(e: SubmitEvent, p: ProviderStatus) {
    e.preventDefault()
    saving = true
    error = ''
    message = null
    try {
      onchange(await window.zook.settings.save(p.id, $state.snapshot(values)))
      editing = null
      message = { id: p.id, text: 'Verified and saved.' }
    } catch (err) {
      error = errorMessage(err)
    } finally {
      saving = false
    }
  }

  async function remove(p: ProviderStatus) {
    onchange(await window.zook.settings.clear(p.id))
    editing = null
    message = { id: p.id, text: 'Saved key removed.' }
  }

  async function activate(p: ProviderStatus) {
    onchange(await window.zook.settings.setActive(p.id))
  }

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

  let suggestEditing = $state(false)
  let suggestKey = $state('')
  let suggestSaving = $state(false)
  let suggestError = $state('')

  async function saveSuggest(e: SubmitEvent) {
    e.preventDefault()
    suggestSaving = true
    suggestError = ''
    try {
      onchange(await window.zook.settings.saveSuggestKey(suggestKey))
      suggestKey = ''
      suggestEditing = false
    } catch (err) {
      suggestError = errorMessage(err)
    } finally {
      suggestSaving = false
    }
  }

  async function removeSuggest() {
    onchange(await window.zook.settings.clearSuggestKey())
    suggestEditing = false
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header>
      <h2 id="settings-title">Settings</h2>
      <button class="close" onclick={onclose} aria-label="Close">✕</button>
    </header>
    <h3>Search provider</h3>
    <p class="muted intro">
      Add an API key for any provider below, then choose which one Zook searches with.
      {#if status && !status.canEncrypt}
        <br /><span class="warn">No system keyring found, so keys are stored unencrypted.</span>
      {/if}
    </p>

    <ul class="providers">
      {#each status?.providers ?? [] as p (p.id)}
        {@const configured = p.source !== 'none'}
        {@const active = status?.active === p.id}
        <li class:active class:open={editing === p.id}>
          <div class="row">
            <input
              type="radio"
              name="provider"
              checked={active}
              disabled={!configured}
              onchange={() => activate(p)}
              aria-label={`Search with ${p.name}`}
              title={configured ? `Search with ${p.name}` : 'Add a key first'}
            />
            <div class="info">
              <div class="name">
                {p.name}
                {#if active && configured}<span class="badge">In use</span>{/if}
              </div>
              <div class="state muted">
                {#if p.source === 'settings'}
                  Key saved <code>{p.hint}</code>
                {:else if p.source === 'env'}
                  Using <code>{p.hint}</code> from .env
                {:else}
                  Not set up
                {/if}
                {#if !p.paginated}· single page of results{/if}
              </div>
            </div>
            <button class="ghost" onclick={() => edit(p)}>
              {editing === p.id ? 'Cancel' : configured ? 'Change' : 'Add key'}
            </button>
          </div>

          {#if message?.id === p.id}<p class="ok">{message.text}</p>{/if}

          {#if editing === p.id}
            <form onsubmit={(e) => save(e, p)}>
              <p class="muted">
                {p.description}
                <a href={p.signupUrl} target="_blank" rel="noreferrer">Get a key ↗</a>
              </p>
              {#if p.note}<p class="warn">{p.note}</p>{/if}

              {#each p.fields as f (f.id)}
                <label>
                  <span>{f.label}</span>
                  <div class="field">
                    <input
                      type={f.secret && !reveal ? 'password' : 'text'}
                      bind:value={values[f.id]}
                      placeholder={f.placeholder ?? (configured ? 'Enter a new value to replace it' : '')}
                      autocomplete="off"
                      spellcheck="false"
                    />
                    {#if f.secret}
                      <button type="button" class="ghost small" onclick={() => (reveal = !reveal)}>
                        {reveal ? 'Hide' : 'Show'}
                      </button>
                    {/if}
                  </div>
                </label>
              {/each}

              {#if error}<p class="error">{error}</p>{/if}

              <div class="actions">
                {#if p.source === 'settings'}
                  <button type="button" class="ghost danger" onclick={() => remove(p)}>Remove saved key</button>
                {/if}
                <button
                  type="submit"
                  class="primary"
                  disabled={saving || p.fields.some((f) => !values[f.id]?.trim())}
                >
                  {saving ? 'Checking…' : 'Save'}
                </button>
              </div>
            </form>
          {/if}
        </li>
      {/each}
    </ul>

    <h3>Privacy</h3>
    <label class="toggle">
      <input
        type="checkbox"
        checked={status?.adblock ?? true}
        disabled={adblockBusy}
        onchange={(e) => toggleAdblock(e.currentTarget.checked)}
      />
      <span>
        <strong>Block ads and trackers</strong>
        <span class="muted">Uses the EasyList and EasyPrivacy filter lists, updated weekly. Applies to pages opened in Zook.</span>
      </span>
    </label>
    {#if adblockBusy}<p class="muted">Loading filter lists…</p>{/if}
    {#if adblockError}<p class="error">{adblockError}</p>{/if}

    <h3>Search suggestions</h3>
    <p class="muted">
      Suggestions always include your history. For online suggestions as you type, add a
      <a href="https://brave.com/search/api/" target="_blank" rel="noreferrer">Brave Autosuggest</a> key (a separate
      plan from Brave Search).
    </p>
    <div class="suggest-card">
      <div class="row">
        <div class="info">
          <div class="name">Brave Autosuggest <span class="muted optional">optional</span></div>
          <div class="state muted">
            {#if status?.suggest.source === 'settings'}
              Key saved <code>{status.suggest.hint}</code>
            {:else if status?.suggest.source === 'env'}
              Using <code>{status.suggest.hint}</code> from .env
            {:else}
              History suggestions only
            {/if}
          </div>
        </div>
        <button class="ghost" onclick={() => { suggestEditing = !suggestEditing; suggestError = '' }}>
          {suggestEditing ? 'Cancel' : status?.suggest.source === 'none' ? 'Add key' : 'Change'}
        </button>
      </div>
      {#if suggestEditing}
        <form onsubmit={saveSuggest}>
          <label>
            <span>API key</span>
            <div class="field">
              <input type="password" bind:value={suggestKey} autocomplete="off" spellcheck="false" />
            </div>
          </label>
          {#if suggestError}<p class="error">{suggestError}</p>{/if}
          <div class="actions">
            {#if status?.suggest.source === 'settings'}
              <button type="button" class="ghost danger" onclick={removeSuggest}>Remove saved key</button>
            {/if}
            <button type="submit" class="primary" disabled={suggestSaving || !suggestKey.trim()}>
              {suggestSaving ? 'Checking…' : 'Save'}
            </button>
          </div>
        </form>
      {/if}
    </div>
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
    max-width: 580px;
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px 24px 24px;
    box-shadow: 0 10px 40px rgb(0 0 0 / 0.3);
  }
  header { display: flex; align-items: center; justify-content: space-between; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 22px 0 4px; font-size: 15px; }
  .toggle { display: flex; gap: 12px; align-items: flex-start; margin-top: 10px; font-size: 14px; cursor: pointer; }
  .toggle input { accent-color: var(--accent); width: 16px; height: 16px; margin: 2px 0 0; }
  .toggle > span { display: flex; flex-direction: column; gap: 2px; }
  .toggle .muted { font-size: 13px; }
  .suggest-card { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-top: 8px; }
  .suggest-card form { padding-left: 0; }
  .optional { font-weight: 400; font-size: 12px; }
  p { margin: 6px 0; font-size: 14px; line-height: 1.5; }
  .intro { margin-bottom: 16px; }
  a { color: var(--link); white-space: nowrap; }
  code { background: var(--surface); padding: 1px 6px; border-radius: 4px; font-size: 12px; }
  .close { border: 0; background: none; font-size: 16px; cursor: pointer; color: var(--muted); }

  .providers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .providers li { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .providers li.active { border-color: var(--accent); }
  .row { display: flex; align-items: center; gap: 12px; }
  .row input[type='radio'] { accent-color: var(--accent); width: 16px; height: 16px; margin: 0; }
  .info { flex: 1; min-width: 0; }
  .name { font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 8px; }
  .state { font-size: 13px; margin-top: 2px; }
  .badge {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 0 7px;
  }

  form { margin-top: 10px; padding-left: 28px; }
  label { display: block; margin-top: 10px; font-size: 13px; }
  label > span { display: block; margin-bottom: 4px; color: var(--muted); }
  .field {
    display: flex;
    gap: 8px;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px 4px 4px 12px;
  }
  .field:focus-within { border-color: var(--accent); }
  .field input {
    flex: 1;
    min-width: 0;
    height: 28px;
    border: 0;
    outline: 0;
    background: none;
    color: var(--fg);
    font-size: 14px;
    font-family: ui-monospace, monospace;
  }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  button.primary, button.ghost {
    border-radius: 8px;
    padding: 6px 14px;
    cursor: pointer;
    font-size: 13px;
    white-space: nowrap;
  }
  button.small { padding: 2px 10px; }
  .primary { border: 0; background: var(--accent); color: var(--bg); font-weight: 600; }
  .primary:disabled { opacity: 0.5; cursor: default; }
  .ghost { border: 1px solid var(--border); background: var(--surface); }
  .danger { color: var(--error); }
  .muted { color: var(--muted); }
  .warn, .error { color: var(--error); }
  .ok { color: #188038; }
</style>

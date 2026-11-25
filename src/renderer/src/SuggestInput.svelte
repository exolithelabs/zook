<script lang="ts" module>
  export type Suggestion =
    | { kind: 'history' | 'suggest'; text: string }
    | { kind: 'page'; text: string; url: string }
</script>

<script lang="ts">
  import Icon from './Icon.svelte'
  let {
    value = $bindable(''),
    id,
    placeholder = '',
    autofocus = false,
    selectOnFocus = false,
    onsubmit,
    onpick,
    onopenchange,
    onfocuschange
  }: {
    value?: string
    id?: string
    placeholder?: string
    autofocus?: boolean
    selectOnFocus?: boolean
    onsubmit: (text: string) => void
    onpick: (s: Suggestion) => void
    onopenchange?: (open: boolean) => void
    onfocuschange?: (focused: boolean) => void
  } = $props()

  const uid = $props.id()
  const listId = `${uid}-list`
  let input = $state<HTMLInputElement>()
  let items = $state<Suggestion[]>([])
  let highlighted = $state(-1)
  let focused = $state(false)
  let request = 0
  let remoteTimer: ReturnType<typeof setTimeout> | undefined

  const open = $derived(focused && items.length > 0)

  $effect(() => {
    onopenchange?.(open)
  })

  $effect(() => {
    if (autofocus) input?.focus()
  })

  async function refresh(text: string) {
    const current = ++request
    clearTimeout(remoteTimer)
    const local = await window.zook.suggest.local(text)
    if (current !== request) return
    const lower = text.trim().toLowerCase()
    const seen = new Set<string>([lower])
    const history: Suggestion[] = local.searches
      .filter((q) => !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()))
      .map((q) => ({ kind: 'history', text: q }))
    const pages: Suggestion[] = local.pages.map((p) => ({ kind: 'page', text: p.title || p.url, url: p.url }))
    items = [...history, ...pages]
    highlighted = -1

    if (!lower) return
    remoteTimer = setTimeout(async () => {
      const remote = await window.zook.suggest.remote(text)
      if (current !== request) return
      const extra: Suggestion[] = remote
        .filter((q) => !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()))
        .slice(0, Math.max(0, 8 - history.length - pages.length))
        .map((q) => ({ kind: 'suggest', text: q }))
      items = [...history, ...extra, ...pages]
    }, 150)
  }

  function close() {
    request++
    clearTimeout(remoteTimer)
    items = []
    highlighted = -1
  }

  function pick(s: Suggestion) {
    close()
    input?.blur()
    onpick(s)
  }

  function submit(e: SubmitEvent) {
    e.preventDefault()
    const choice = items[highlighted]
    if (choice) return pick(choice)
    const text = value.trim()
    if (!text) return
    close()
    input?.blur()
    onsubmit(text)
  }

  async function removeHistory(e: MouseEvent, s: Suggestion) {
    e.preventDefault()
    e.stopPropagation()
    await window.zook.history.removeSearch(s.text)
    refresh(value)
    input?.focus()
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (open) close()
      else input?.blur()
    } else if (open && e.key === 'ArrowDown') {
      e.preventDefault()
      highlighted = (highlighted + 1) % items.length
    } else if (open && e.key === 'ArrowUp') {
      e.preventDefault()
      highlighted = highlighted <= 0 ? items.length - 1 : highlighted - 1
    } else if (open && e.key === 'Delete' && e.shiftKey && items[highlighted]?.kind === 'history') {
      e.preventDefault()
      removeHistory(new MouseEvent('click'), items[highlighted])
    }
  }

  export function focus() {
    input?.focus()
    input?.select()
  }
</script>

<form class="suggest" onsubmit={submit}>
  <input
    bind:this={input}
    bind:value
    {id}
    {placeholder}
    spellcheck="false"
    autocomplete="off"
    role="combobox"
    aria-expanded={open}
    aria-controls={listId}
    aria-autocomplete="list"
    oninput={() => refresh(value)}
    onfocus={() => {
      focused = true
      onfocuschange?.(true)
      if (selectOnFocus) input?.select()
      if (!value) refresh('')
    }}
    onblur={() => {
      focused = false
      onfocuschange?.(false)
      close()
    }}
    {onkeydown}
  />
  {#if open}
    <ul class="dropdown" id={listId} role="listbox">
      {#each items as s, i (s.kind + s.text + (s.kind === 'page' ? s.url : ''))}
        <li
          role="option"
          aria-selected={i === highlighted}
          class:highlighted={i === highlighted}
          onmousedown={(e) => {
            e.preventDefault()
            pick(s)
          }}
          onmouseenter={() => (highlighted = i)}
        >
          <span class="icon"><Icon name={s.kind === 'history' ? 'history' : s.kind === 'page' ? 'globe' : 'search'} /></span>
          <span class="text">{s.text}</span>
          {#if s.kind === 'page'}<span class="url">{s.url.replace(/^https?:\/\/(www\.)?/, '')}</span>{/if}
          {#if s.kind === 'history'}
            <button
              type="button"
              class="remove"
              title="Remove from history (Shift+Delete)"
              aria-label="Remove from history"
              onmousedown={(e) => removeHistory(e, s)}><Icon name="close" /></button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</form>

<style>
  .suggest { position: relative; flex: 1; min-width: 0; }
  input {
    width: 100%;
    height: 100%;
    border: 0;
    outline: 0;
    background: none;
    color: var(--fg);
    font: inherit;
  }
  .dropdown {
    position: absolute;
    top: calc(100% + 6px);
    left: -14px;
    right: -14px;
    margin: 0;
    padding: 6px 0;
    list-style: none;
    background: var(--bg);
    border: 1px solid var(--box-border);
    border-radius: 12px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.12), 0 1px 3px rgb(0 0 0 / 0.06);
    z-index: 20;
    font-size: 14px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 14px;
    cursor: pointer;
  }
  li.highlighted { background: var(--surface); }
  .icon { display: flex; justify-content: center; width: 18px; flex-shrink: 0; color: var(--muted); }
  .text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .url {
    color: var(--link);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }
  .remove {
    display: inline-flex;
    align-items: center;
    margin-left: auto;
    border: 0;
    background: none;
    color: var(--muted);
    cursor: pointer;
    opacity: 0;
    padding: 0 4px;
  }
  li.highlighted .remove { opacity: 1; }
</style>

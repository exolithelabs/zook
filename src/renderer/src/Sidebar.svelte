<script lang="ts">
  import Icon from './Icon.svelte'
  import type { ThreadSummary } from '../../main/threads'
  import { chats } from './chat.svelte'

  let {
    activeId,
    onselect,
    ondelete,
    oncollapse
  }: {
    // The thread on screen, if a chat is showing.
    activeId: string | null
    onselect: (id: string) => void
    ondelete: (id: string) => void
    oncollapse: () => void
  } = $props()

  let now = $state(Date.now())
  let renaming = $state<string | null>(null)
  let renameValue = $state('')
  let confirmDelete = $state<string | null>(null)
  let filter = $state('')

  // Past chats whose title contains the search text, ignoring case.
  const q = $derived(filter.trim().toLowerCase())
  const shown = $derived(q ? chats.list.filter((t) => t.title.toLowerCase().includes(q)) : chats.list)

  // Esc clears the search first, without also closing a web popup behind it.
  function filterKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && filter) {
      e.stopPropagation()
      filter = ''
    }
  }

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000)
    return () => clearInterval(timer)
  })

  function ago(at: number): string {
    const s = Math.max(0, (now - at) / 1000)
    if (s < 60) return 'now'
    if (s < 3600) return `${Math.floor(s / 60)}m`
    if (s < 86400) return `${Math.floor(s / 3600)}h`
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
    if (s < 365 * 86400) return `${Math.floor(s / (7 * 86400))}w`
    return `${Math.floor(s / (365 * 86400))}y`
  }

  function tooltip(t: ThreadSummary): string {
    const when = new Date(t.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    return t.backend ? `${t.title}\n${when} · ${t.backend.model} · ${t.backend.name}` : `${t.title}\n${when}`
  }

  function startRename(t: ThreadSummary) {
    confirmDelete = null
    renaming = t.id
    renameValue = t.title
  }

  function commitRename() {
    const id = renaming
    renaming = null
    const thread = chats.list.find((t) => t.id === id)
    if (id && thread && renameValue.trim() !== thread.title) chats.rename(id, renameValue)
  }

  function renameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') commitRename()
    else if (e.key === 'Escape') renaming = null
  }

  function focusSelect(el: HTMLInputElement) {
    el.focus()
    el.select()
  }
</script>

<aside class="sidebar" aria-label="Chats">
  <header>
    {#if chats.list.length}
      <label class="search">
        <Icon name="search" />
        <input
          type="search"
          bind:value={filter}
          onkeydown={filterKey}
          placeholder="Search chats"
          aria-label="Search chats by title"
          spellcheck="false"
          autocomplete="off"
        />
      </label>
    {/if}
    <!-- The sidebar only shows when open, so this is always the close control; ☰ in the toolbar reopens it. -->
    <!-- The menu icon that opened the sidebar, turning into a close icon on hover. -->
    <button class="icon collapse" onclick={oncollapse} title="Hide chats" aria-label="Hide chats">
      <span class="idle"><Icon name="menu" /></span>
      <span class="hover"><Icon name="close" /></span>
    </button>
  </header>

  {#if chats.list.length}<h2 class="label">AI chats</h2>{/if}
  <ul class="threads">
    {#each shown as t (t.id)}
      <li class:active={t.id === activeId}>
        {#if renaming === t.id}
          <input
            class="rename"
            bind:value={renameValue}
            onkeydown={renameKey}
            onblur={commitRename}
            maxlength="120"
            aria-label="Chat title"
            use:focusSelect
          />
        {:else if confirmDelete === t.id}
          <span class="confirm">Delete this chat?</span>
          <button class="ghost" onclick={() => (confirmDelete = null)}>Cancel</button>
          <button class="ghost danger" onclick={() => ondelete(t.id)}>Delete</button>
        {:else}
          <button class="entry" onclick={() => onselect(t.id)} title={tooltip(t)}>
            {#if chats.busy(t.id)}<span class="dot" aria-label="Replying"></span>{/if}
            <span class="title">{t.title}</span>
            <span class="time">{ago(t.updatedAt)}</span>
          </button>
          <span class="actions">
            <button onclick={() => startRename(t)} title="Rename" aria-label="Rename"><Icon name="edit" /></button>
            <button onclick={() => ((renaming = null), (confirmDelete = t.id))} title="Delete" aria-label="Delete"><Icon name="close" /></button>
          </span>
        {/if}
      </li>
    {:else}
      <li class="empty">
        {#if q}No chats match “{filter.trim()}”.{:else}Chats you start from a search’s AI tab are kept here.{/if}
      </li>
    {/each}
  </ul>
</aside>

<style>
  .sidebar {
    flex: 0 0 256px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    /* Halfway between the page and --surface: present, but quieter than the content. */
    background: color-mix(in srgb, var(--surface) 50%, var(--bg));
    border-right: 1px solid var(--border);
  }
  /* Same height as the toolbar beside it, so their bottom borders line up. */
  header {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
  }
  .search {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 12px;
    border: 1px solid var(--box-border);
    border-radius: 17px;
    background: var(--bg);
    box-shadow: var(--box-shadow);
    color: var(--muted);
    cursor: text;
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  .search:focus-within { border-color: var(--focus-border); box-shadow: var(--focus-ring); }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: 0;
    background: none;
    color: var(--fg);
    font: inherit;
    font-size: 13px;
  }
  .search input::-webkit-search-cancel-button { cursor: pointer; }
  .icon {
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
  }
  .icon:hover { background: var(--surface); color: var(--fg); }
  .collapse span { display: inline-flex; }
  .collapse .hover, .collapse:hover .idle, .collapse:focus-visible .idle { display: none; }
  .collapse:hover .hover, .collapse:focus-visible .hover { display: inline-flex; }

  .label {
    margin: 0;
    padding: 14px 18px 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .threads { list-style: none; margin: 0; padding: 4px 8px 8px; flex: 1; min-height: 0; overflow-y: auto; }
  li {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 34px;
    margin-bottom: 1px;
    border-radius: 8px;
    color: var(--fg);
    font-size: 13px;
    transition: background-color 0.12s;
  }
  li:hover, li.active { background: var(--surface); }
  li.active { font-weight: 600; }
  .entry {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 10px;
    border: 0;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .time { flex-shrink: 0; font-size: 11px; font-weight: 400; color: var(--muted); font-variant-numeric: tabular-nums; }
  .dot {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse { 50% { opacity: 0.25; } }

  /* Rename and delete show on hover, in place of the time. */
  .actions {
    position: absolute;
    right: 4px;
    display: none;
    gap: 2px;
    /* Same as the hovered row, so the buttons cover the time cleanly. */
    background: var(--surface);
  }
  li:hover .actions, li:focus-within .actions { display: flex; }
  li:hover .time, li:focus-within .time { visibility: hidden; }
  .actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .actions button:hover { background: var(--bg); color: var(--fg); }

  .rename {
    flex: 1;
    min-width: 0;
    height: 30px;
    margin: 2px;
    padding: 0 8px;
    border: 1px solid var(--focus-border);
    border-radius: 7px;
    outline: 0;
    box-shadow: var(--focus-ring);
    background: var(--bg);
    color: var(--fg);
    font: inherit;
  }
  .confirm { flex: 1; min-width: 0; padding-left: 10px; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ghost { border: 0; background: none; padding: 4px 6px; border-radius: 6px; font-size: 12px; cursor: pointer; color: var(--muted); }
  .ghost:hover { background: var(--bg); }
  .ghost.danger { color: var(--error); }
  .empty { display: block; padding: 24px 12px; font-size: 12px; line-height: 1.5; color: var(--muted); text-align: center; }
  .empty:hover { background: none; }
</style>

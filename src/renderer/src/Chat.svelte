<script lang="ts">
  import { untrack } from 'svelte'
  import Icon, { iconSvg } from './Icon.svelte'
  import type { SettingsStatus } from '../../main/settings'
  import { chats, groundedFor, type ChatThread } from './chats.svelte'
  import { renderMarkdown } from './markdown'

  let {
    chat,
    settings,
    onopen,
    onopensettings,
    inline = false
  }: {
    chat: ChatThread
    settings: SettingsStatus | null
    onopen: (url: string) => void
    // True to jump to the AI chat section.
    onopensettings: (chatSection: boolean) => void
    // Shown as a result type, lined up with the search page's column instead of centred.
    inline?: boolean
  } = $props()

  let draft = $state('')
  let input = $state<HTMLTextAreaElement>()
  let transcript = $state<HTMLDivElement>()
  // Follow new text only while the user is already at the bottom.
  let pinned = true

  const busy = $derived(chat.requestId !== null)
  const ready = $derived(settings ? settings.chat.active !== null : true)

  $effect(() => {
    input?.focus()
  })

  $effect(() => {
    // Re-run as the last turn grows.
    const last = chat.turns.at(-1)
    void last?.content
    void last?.status
    if (transcript && pinned) transcript.scrollTop = transcript.scrollHeight
  })

  // Grow the box with its text, up to the CSS max-height.
  $effect(() => {
    void draft
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
  })

  function send() {
    if (busy || !draft.trim()) return
    pinned = true
    chats.send(chat, draft, groundedFor(settings))
    draft = ''
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape' && busy) {
      e.preventDefault()
      chats.stop(chat)
    }
  }

  // The question being edited, by turn index, and its new text.
  let editing = $state<number | null>(null)
  let editDraft = $state('')
  let editInput = $state<HTMLTextAreaElement>()

  // Another thread on screen drops an edit in progress.
  $effect(() => {
    void chat.id
    editing = null
  })

  $effect(() => {
    if (editing === null || !editInput) return
    const end = untrack(() => editDraft.length)
    editInput.focus()
    editInput.setSelectionRange(end, end)
  })

  $effect(() => {
    void editDraft
    if (!editInput) return
    editInput.style.height = 'auto'
    editInput.style.height = `${editInput.scrollHeight}px`
  })

  function startEdit(i: number, text: string) {
    editDraft = text
    editing = i
  }

  function saveEdit() {
    if (editing === null || !editDraft.trim()) return
    pinned = true
    chats.edit(chat, editing, editDraft, groundedFor(settings))
    editing = null
  }

  function onEditKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      saveEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      editing = null
    }
  }

  function onscroll() {
    if (!transcript) return
    pinned = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40
  }

  // Replies whose source list is open, by turn index.
  let openSources = $state<Record<number, boolean>>({})

  $effect(() => {
    void chat.id
    openSources = {}
  })

  function hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  }

  // Which reply was just copied, to show a tick on its button for a moment.
  let copied = $state<number | null>(null)
  let copiedTimer: ReturnType<typeof setTimeout> | undefined

  async function copyReply(i: number, text: string) {
    await navigator.clipboard.writeText(text)
    copied = i
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied = null), 1500)
  }

  // Code blocks are rendered HTML, so their copy buttons are handled here and swap their own icon.
  async function copyCode(button: HTMLButtonElement) {
    const code = button.closest('.code-block')?.querySelector('pre')?.textContent ?? ''
    await navigator.clipboard.writeText(code)
    button.innerHTML = iconSvg('check')
    button.classList.add('done')
    setTimeout(() => {
      button.innerHTML = iconSvg('copy')
      button.classList.remove('done')
    }, 1500)
  }

  // Links in replies (citations included) open in place of the chat.
  function linkClick(e: MouseEvent) {
    const copy = (e.target as HTMLElement).closest<HTMLButtonElement>('.copy-code')
    if (copy) {
      copyCode(copy)
      return
    }
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-url]')
    if (!link) return
    e.preventDefault()
    if (e.button === 0) onopen(link.dataset.url!)
  }
</script>

<main class="chat" class:inline>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="transcript" bind:this={transcript} {onscroll} onclick={linkClick} onauxclick={(e) => e.preventDefault()}>
    <div class="column">
      {#each chat.turns as turn, i (i)}
        {#if turn.role === 'user' && editing === i}
          <div class="turn user">
            <div class="edit-box">
              <textarea bind:this={editInput} bind:value={editDraft} onkeydown={onEditKeydown} rows="1" aria-label="Edit message"
              ></textarea>
              <div class="edit-actions">
                <button class="pill" onclick={() => (editing = null)}>Cancel</button>
                <button class="pill primary" onclick={saveEdit} disabled={!editDraft.trim()}>Send</button>
              </div>
            </div>
          </div>
        {:else if turn.role === 'user'}
          <div class="turn user">
            <!-- The first question started the chat, so only later ones can be edited. -->
            {#if i > 0}
              <button class="action edit" onclick={() => startEdit(i, turn.content)} title="Edit message" aria-label="Edit message">
                <Icon name="edit" />
              </button>
            {/if}
            <div class="bubble">{turn.content}</div>
          </div>
        {:else}
          <div class="turn assistant">
            {#if turn.content}
              <div class="md" class:streaming={turn.status === 'streaming' && !turn.activity}>
                {@html renderMarkdown(turn.content, turn.sources)}
              </div>
            {/if}
            {#if turn.activity}
              <p class="muted status" title={turn.activity.text}>
                <span class="dot"></span>
                <span class="activity">
                  {turn.activity.kind === 'search' ? `Searching “${turn.activity.text}”` : `Reading ${turn.activity.text}`}…
                </span>
              </p>
            {:else if turn.status === 'streaming' && !turn.content}
              <p class="muted status"><span class="dot"></span>Thinking…</p>
            {/if}
            {#if turn.error}
              <p class="error">{turn.error}</p>
              {#if turn.error.includes('Settings')}
                <button class="pill" onclick={() => onopensettings(!turn.error?.includes('search') && !turn.error?.includes('No API key'))}>Open Settings</button>
              {/if}
            {/if}
            {#if !turn.status && (turn.content || turn.error)}
              {@const canRetry = Boolean(turn.error) && i === chat.turns.length - 1 && !busy}
              <div class="reply-actions">
                {#if turn.content}
                  <button
                    class="action"
                    onclick={() => copyReply(i, turn.content)}
                    title={copied === i ? 'Copied' : 'Copy reply'}
                    aria-label="Copy reply"
                  >
                    <Icon name={copied === i ? 'check' : 'copy'} />
                  </button>
                {/if}
                {#if canRetry}
                  <button class="action labelled" onclick={() => chats.retry(chat, groundedFor(settings))} title="Ask again">
                    <Icon name="retry" /> Retry
                  </button>
                {/if}
              </div>
            {/if}
            {#if turn.sources?.length && !turn.status}
              {@const open = openSources[i] ?? false}
              <section class="sources">
                <button
                  class="sources-toggle"
                  aria-expanded={open}
                  aria-controls={`sources-${i}`}
                  onclick={() => (openSources[i] = !open)}
                >
                  <span class="favicons" aria-hidden="true">
                    {#each turn.sources.slice(0, 4) as s (s.n)}
                      {#if s.favicon}
                        <img src={s.favicon} alt="" width="16" height="16" />
                      {:else}
                        <span class="favicon-fallback">{hostOf(s.url).charAt(0).toUpperCase()}</span>
                      {/if}
                    {/each}
                  </span>
                  {turn.sources.length} {turn.sources.length === 1 ? 'source' : 'sources'}
                  <span class="chevron" class:open><Icon name="chevron" /></span>
                </button>
                {#if open}
                  <div class="sources-panel" id={`sources-${i}`}>
                    {#if turn.queries?.length}
                      <p class="queries">
                        <Icon name="search" />
                        <span>{turn.queries.map((q) => `“${q}”`).join(' · ')}</span>
                      </p>
                    {/if}
                    <ol aria-label="Sources">
                      {#each turn.sources as s (s.n)}
                        <li>
                          <a href={s.url} data-url={s.url} title={s.url}>
                            <span class="n">{s.n}</span>
                            {#if s.favicon}
                              <img src={s.favicon} alt="" width="16" height="16" />
                            {:else}
                              <span class="favicon-fallback">{hostOf(s.url).charAt(0).toUpperCase()}</span>
                            {/if}
                            <span class="source-text">
                              <span class="source-title">{s.title}</span>
                              <span class="source-host">{hostOf(s.url)}</span>
                            </span>
                          </a>
                        </li>
                      {/each}
                    </ol>
                  </div>
                {/if}
              </section>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  </div>

  <div class="composer">
    <div class="column">
      <div class="box">
        <textarea
          bind:this={input}
          bind:value={draft}
          {onkeydown}
          rows="1"
          placeholder={ready ? 'Message Zook AI' : 'Set up an AI model in Settings to start chatting'}
          aria-label="Message"
        ></textarea>
        {#if busy}
          <button class="send stop" onclick={() => chats.stop(chat)} title="Stop (Esc)" aria-label="Stop"><Icon name="stop" /></button>
        {:else}
          <button class="send" onclick={send} disabled={!draft.trim()} title="Send (Enter)" aria-label="Send"><Icon name="send" /></button>
        {/if}
      </div>
    </div>
  </div>
</main>

<style>
  .chat { height: 100%; display: flex; flex-direction: column; }
  .transcript { flex: 1; min-height: 0; overflow-y: auto; }
  .column { max-width: 760px; margin: 0 auto; padding: 0 24px; }
  /* As a result type: the search page's centred column, so it lines up with the tabs above. */
  .chat.inline { height: auto; flex: 1; min-height: 0; }
  .chat.inline .column {
    max-width: calc(var(--reading, 680px) + 2 * var(--gutter, 24px));
    margin: 0 auto;
    padding-left: var(--gutter, 24px);
    padding-right: var(--gutter, 24px);
  }
  .transcript .column { padding-top: 24px; padding-bottom: 24px; }
  .muted { color: var(--muted); }
  .error { color: var(--error); font-size: 14px; margin: 6px 0; }

  .turn { margin-bottom: 20px; }
  .turn.user { display: flex; justify-content: flex-end; align-items: center; gap: 4px; }
  /* Shown beside a question while it's hovered or focused. */
  .action.edit { opacity: 0; transition: opacity 0.12s, background-color 0.12s, color 0.12s; }
  .turn.user:hover .action.edit, .action.edit:focus-visible { opacity: 1; }
  .edit-box {
    width: min(100%, 560px);
    border: 1px solid var(--box-border);
    border-radius: 16px;
    padding: 10px 12px 8px 14px;
    background: var(--bg);
    box-shadow: var(--box-shadow);
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  .edit-box:focus-within { border-color: var(--focus-border); box-shadow: var(--box-shadow-raised), var(--focus-ring); }
  .edit-box textarea { width: 100%; padding: 0; }
  .edit-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
  .edit-actions .pill { padding: 4px 12px; font-size: 13px; color: var(--fg); }
  .pill.primary { background: var(--accent); border-color: transparent; color: var(--bg); }
  .pill:disabled { opacity: 0.4; cursor: default; }
  .bubble {
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 16px 16px 4px 16px;
    background: var(--surface);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .status { display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 13px; }
  .activity { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse { 50% { opacity: 0.25; } }

  .md { line-height: 1.6; font-size: 15px; overflow-wrap: anywhere; }
  .md :global(p) { margin: 0 0 10px; }
  .md :global(:is(h1, h2, h3, h4, h5, h6)) { margin: 18px 0 8px; font-weight: 650; line-height: 1.3; }
  .md :global(h1) { font-size: 1.35em; }
  .md :global(h2) { font-size: 1.2em; }
  .md :global(h3) { font-size: 1.08em; }
  .md :global(:is(h4, h5, h6)) { font-size: 1em; }
  .md :global(h6) { color: var(--muted); }
  .md > :global(:first-child) { margin-top: 0; }
  .md :global(hr) { margin: 16px 0; border: 0; border-top: 1px solid var(--box-border); }
  .md :global(del) { color: var(--muted); }
  .md :global(ul), .md :global(ol) { margin: 0 0 10px; padding-left: 24px; }
  .md :global(li) { margin: 2px 0; }
  .md :global(li > :is(ul, ol)) { margin: 2px 0 4px; }
  .md :global(li > p:last-child) { margin-bottom: 4px; }
  .md :global(li.task) { list-style: none; display: flex; align-items: baseline; gap: 8px; margin-left: -20px; }
  .md :global(li.task input) { margin: 0; accent-color: var(--accent); }
  .md :global(.math) { font-family: ui-monospace, monospace; font-size: 13px; }
  .md :global(.math-block) {
    margin: 0 0 10px;
    padding: 8px 12px;
    border: 1px solid var(--box-border);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: var(--box-shadow);
    font-family: ui-monospace, monospace;
    font-size: 13px;
    white-space: pre-wrap;
    overflow-x: auto;
  }
  .md :global(code) { background: var(--surface); padding: 1px 5px; border-radius: 4px; font-size: 13px; font-family: ui-monospace, monospace; }
  .md :global(.code-block) {
    margin: 0 0 10px;
    border: 1px solid var(--box-border);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: var(--box-shadow);
    overflow: hidden;
  }
  .md :global(.code-head) { display: flex; align-items: center; height: 28px; padding: 0 4px 0 12px; }
  .md :global(.code-lang) { font-size: 12px; color: var(--muted); font-family: ui-monospace, monospace; }
  .md :global(.copy-code) {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .md :global(.copy-code:hover) { background: var(--bg); color: var(--fg); }
  .md :global(.copy-code.done) { color: var(--ok); }
  .md :global(.copy-code .icon) { display: inline-block; }
  .md :global(pre) { margin: 0; padding: 0 12px 10px; overflow-x: auto; }
  .md :global(pre code) { background: none; padding: 0; }
  .md :global(blockquote) {
    margin: 0 0 10px;
    padding: 2px 0 2px 14px;
    border-left: 3px solid var(--box-border);
    color: var(--muted);
  }
  .md :global(blockquote > :last-child) { margin-bottom: 0; }
  .md :global(.table) {
    margin: 0 0 12px;
    overflow-x: auto;
    border: 1px solid var(--box-border);
    border-radius: 8px;
    box-shadow: var(--box-shadow);
  }
  .md :global(table) { width: 100%; border-collapse: collapse; font-size: 14px; line-height: 1.45; }
  .md :global(th), .md :global(td) { padding: 6px 12px; text-align: left; vertical-align: top; }
  .md :global(th) { background: var(--surface); font-weight: 600; }
  .md :global(tbody tr + tr td) { border-top: 1px solid var(--box-border); }
  .md :global(a) { color: var(--link); }
  .md :global(a.cite) {
    display: inline-block;
    min-width: 17px;
    margin: 0 1px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--surface);
    border: 1px solid var(--box-border);
    font-size: 11px;
    line-height: 16px;
    text-align: center;
    text-decoration: none;
    vertical-align: 2px;
  }
  .md :global(a.cite:hover) { border-color: var(--link); }
  /* Blinking cursor after the last block while text streams in. */
  .md.streaming > :global(:last-child)::after {
    content: '▍';
    margin-left: 1px;
    color: var(--accent);
    animation: blink 1s steps(2, start) infinite;
  }
  @keyframes blink { to { visibility: hidden; } }

  /* Under a finished reply: quiet until hovered. */
  .reply-actions { display: flex; align-items: center; gap: 2px; margin: -4px 0 4px -6px; }
  .action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-width: 28px;
    height: 28px;
    padding: 0 6px;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--muted);
    font-size: 13px;
    cursor: pointer;
    transition: background-color 0.12s, color 0.12s;
  }
  .action:hover { background: var(--surface); color: var(--fg); }
  .action.labelled { padding: 0 10px 0 8px; }

  /* Under a reply: a quiet summary that opens into the full list. */
  .sources { margin: 2px 0 0; }
  .sources-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 8px 0 6px;
    margin-left: -6px;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    transition: background-color 0.12s, color 0.12s;
  }
  .sources-toggle:hover { background: var(--surface); color: var(--fg); }
  .favicons { display: inline-flex; }
  .favicons > :global(*) { box-shadow: 0 0 0 2px var(--bg); }
  .favicons > :global(* + *) { margin-left: -5px; }
  .sources img, .favicon-fallback { flex-shrink: 0; width: 16px; height: 16px; border-radius: 50%; background: var(--surface); }
  .favicon-fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 9px;
    font-weight: 600;
  }
  .chevron { display: inline-flex; transition: transform 0.15s; }
  .chevron.open { transform: rotate(90deg); }
  .sources-panel {
    margin-top: 4px;
    border: 1px solid var(--box-border);
    border-radius: 12px;
    box-shadow: var(--box-shadow);
    overflow: hidden;
  }
  .queries {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0;
    padding: 8px 12px;
    border-bottom: 1px solid var(--box-border);
    background: var(--surface);
    color: var(--muted);
    font-size: 12px;
  }
  .queries :global(.icon) { flex-shrink: 0; align-self: center; width: 13px; height: 13px; }
  .sources-panel ol { list-style: none; margin: 0; padding: 4px; max-height: 320px; overflow-y: auto; }
  .sources-panel a {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 8px;
    color: var(--fg);
    text-decoration: none;
  }
  .sources-panel a:hover { background: var(--surface); }
  .sources .n {
    flex-shrink: 0;
    min-width: 18px;
    height: 18px;
    border-radius: 9px;
    background: var(--surface);
    color: var(--muted);
    font-size: 11px;
    line-height: 18px;
    text-align: center;
  }
  .source-text { display: flex; flex-direction: column; min-width: 0; }
  .source-title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .source-host { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .composer { background: var(--bg); }
  .composer .column { padding-top: 12px; padding-bottom: 16px; }
  .box {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    border: 1px solid var(--box-border);
    border-radius: 22px;
    padding: 6px 6px 6px 16px;
    background: var(--bg);
    box-shadow: var(--box-shadow);
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  .box:focus-within { border-color: var(--focus-border); box-shadow: var(--box-shadow-raised), var(--focus-ring); }
  textarea {
    flex: 1;
    min-width: 0;
    max-height: 200px;
    border: 0;
    outline: 0;
    resize: none;
    background: none;
    color: var(--fg);
    font: inherit;
    font-size: 15px;
    line-height: 1.5;
    padding: 5px 0;
  }
  .send {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 50%;
    background: var(--accent);
    color: var(--bg);
    cursor: pointer;
  }
  .send:disabled { opacity: 0.35; cursor: default; }
  .pill {
    border: 1px solid var(--box-border);
    box-shadow: var(--box-shadow);
    background: var(--surface);
    border-radius: 18px;
    padding: 6px 14px;
    cursor: pointer;
  }
</style>

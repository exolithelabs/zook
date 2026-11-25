<script lang="ts">
  import Icon, { iconSvg } from './Icon.svelte'
  import type { SettingsStatus } from '../../main/settings'
  import { chats, groundedFor, type ChatThread } from './chat.svelte'
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
  const ready = $derived(settings ? settings.chat.source !== 'none' : true)

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

  function onscroll() {
    if (!transcript) return
    pinned = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40
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
        {#if turn.role === 'user'}
          <div class="turn user"><div class="bubble">{turn.content}</div></div>
        {:else}
          <div class="turn assistant">
            {#if turn.status === 'searching'}
              <p class="muted status"><span class="dot"></span>Searching the web…</p>
            {:else if turn.status === 'streaming' && !turn.content}
              <p class="muted status"><span class="dot"></span>Thinking…</p>
            {/if}
            {#if turn.content}
              <div class="md" class:streaming={turn.status === 'streaming'}>
                {@html renderMarkdown(turn.content, turn.sources)}
              </div>
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
            {#if turn.sources?.length}
              <ol class="sources" aria-label="Sources">
                {#each turn.sources as s (s.n)}
                  <li>
                    <a href={s.url} data-url={s.url} title={`${s.title}\n${s.url}`}>
                      <span class="n">{s.n}</span>
                      {#if s.favicon}<img src={s.favicon} alt="" width="14" height="14" />{/if}
                      <span class="source-title">{s.title}</span>
                    </a>
                  </li>
                {/each}
              </ol>
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
  .turn.user { display: flex; justify-content: flex-end; }
  .bubble {
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 16px 16px 4px 16px;
    background: var(--surface);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .status { display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 14px; }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse { 50% { opacity: 0.25; } }

  .md { line-height: 1.6; font-size: 15px; overflow-wrap: anywhere; }
  .md :global(p) { margin: 0 0 10px; }
  .md :global(.heading) { font-weight: 700; margin-top: 14px; }
  .md :global(ul), .md :global(ol) { margin: 0 0 10px; padding-left: 24px; }
  .md :global(li) { margin: 2px 0; }
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

  .sources { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
  .sources a {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 240px;
    padding: 3px 10px 3px 4px;
    border: 1px solid var(--box-border);
    box-shadow: var(--box-shadow);
    border-radius: 14px;
    background: var(--bg);
    color: var(--fg);
    text-decoration: none;
    font-size: 12px;
  }
  .sources a:hover { background: var(--surface); }
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
  .sources img { flex-shrink: 0; border-radius: 50%; }
  .source-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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

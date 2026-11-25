<script lang="ts">
  import type { Notices } from '../../main/licenses'
  import Icon from './Icon.svelte'
  import { errorMessage } from './errors'

  let notices = $state<Notices | null>(null)
  let error = $state('')
  let openError = $state('')
  let filter = $state('')
  // A license picked from the summary chips, matched exactly. Combines with the text filter.
  let license = $state<string | null>(null)
  // Which notices are expanded, by key. Closed ones don't render their text, which runs to hundreds of KB.
  let expanded = $state<Record<string, boolean>>({})
  // The notice whose text was just copied, so its button can say so for a moment.
  let copied = $state('')
  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  let filterInput = $state<HTMLInputElement>()

  $effect(() => {
    window.zook.licenses.get().then(
      (n) => (notices = n),
      (err) => (error = errorMessage(err))
    )
  })

  const shown = $derived.by(() => {
    const q = filter.trim().toLowerCase()
    let packages = notices?.packages ?? []
    if (license) packages = packages.filter((p) => p.license === license)
    return q ? packages.filter((p) => p.name.toLowerCase().includes(q) || p.license.toLowerCase().includes(q)) : packages
  })

  // How many packages use each license, most common first.
  const summary = $derived.by(() => {
    const counts = new Map<string, number>()
    for (const p of notices?.packages ?? []) counts.set(p.license, (counts.get(p.license) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  })

  const filtered = $derived(Boolean(license || filter.trim()))

  function clearFilters() {
    filter = ''
    license = null
    filterInput?.focus()
  }

  // Escape empties the filter first, and only closes Settings once there's nothing left to clear.
  function clearOnEscape(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !filter) return
    e.stopPropagation()
    filter = ''
  }

  async function copy(key: string, text: string) {
    await navigator.clipboard.writeText(text)
    copied = key
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied = ''), 1500)
  }

  async function openChromium() {
    openError = ''
    try {
      await window.zook.licenses.openChromium()
    } catch (err) {
      openError = errorMessage(err)
    }
  }
</script>

{#snippet notice(key: string, title: string, version: string, license: string, text: string, url?: string)}
  <details class="item" bind:open={expanded[key]}>
    <summary>
      <span class="chevron"><Icon name="chevron" /></span>
      <span class="name">{title}</span>
      <span class="version">{version}</span>
      <span class="spacer"></span>
      <span class="tag">{license}</span>
    </summary>
    {#if expanded[key]}
      <div class="detail">
        <div class="toolbar">
          {#if url}
            <a class="link" href={url} target="_blank" rel="noreferrer">
              <span>{url.replace(/^https?:\/\//, '')}</span>
              <Icon name="external" />
            </a>
          {/if}
          <span class="spacer"></span>
          <button class="btn quiet" onclick={() => copy(key, text)} aria-label="Copy license text for {title}">
            <Icon name={copied === key ? 'check' : 'copy'} />
            {copied === key ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre>{text}</pre>
      </div>
    {/if}
  </details>
{/snippet}

{#if error}
  <p class="error" role="alert">{error}</p>
{:else if !notices}
  <p class="muted">Loading…</p>
{:else}
  <section>
    <h3>App</h3>
    {@render notice('app', notices.app.name, notices.app.version, notices.app.license, notices.app.text)}
  </section>

  <section>
    <h3>Runtime</h3>
    {@render notice('electron', 'Electron', notices.electron.version, notices.electron.license, notices.electron.text, 'https://www.electronjs.org')}
    <div class="item runtime">
      <dl>
        <div><dt>Chromium</dt><dd>{notices.runtime.chromium}</dd></div>
        <div><dt>Node.js</dt><dd>{notices.runtime.node}</dd></div>
      </dl>
      <span class="spacer"></span>
      <button class="btn" onclick={openChromium}>Open notices <Icon name="external" /></button>
    </div>
    {#if openError}<p class="error" role="alert">{openError}</p>{/if}
    <p class="hint">Chromium, Node.js and the libraries they include are covered by the notices that ship with Electron.</p>
  </section>

  <section>
    <h3>Packages <span class="count">{notices.packages.length}</span></h3>
    <div class="chips" role="group" aria-label="Filter by license">
      {#each summary as [name, n] (name)}
        <button
          class="chip"
          class:on={license === name}
          aria-pressed={license === name}
          onclick={() => (license = license === name ? null : name)}
        >
          {name}<span class="n">{n}</span>
        </button>
      {/each}
    </div>
    <label class="filter">
      <Icon name="search" />
      <input
        bind:this={filterInput}
        bind:value={filter}
        placeholder="Filter by name or license"
        spellcheck="false"
        aria-label="Filter packages"
        onkeydown={clearOnEscape}
      />
      {#if filtered}
        <span class="matches" aria-live="polite">{shown.length} of {notices.packages.length}</span>
        <button class="clear" onclick={clearFilters} aria-label="Clear filters"><Icon name="close" /></button>
      {/if}
    </label>
    <div class="list">
      {#each shown as p (`${p.name}@${p.version}`)}
        {@render notice(`${p.name}@${p.version}`, p.name, p.version, p.license, p.text, p.url)}
      {:else}
        <div class="empty">
          <p class="muted">No packages match.</p>
          <button class="btn" onclick={clearFilters}>Clear filters</button>
        </div>
      {/each}
    </div>
  </section>
{/if}

<style>
  section { display: flex; flex-direction: column; gap: 6px; }
  section + section { margin-top: 14px; }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 2px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .count {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--surface);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0;
  }
  p { margin: 0; font-size: 13px; line-height: 1.45; }
  .hint, .muted { color: var(--muted); }
  .hint { font-size: 12px; }
  .error { color: var(--error); }
  .list { display: flex; flex-direction: column; gap: 6px; }
  .spacer { flex: 1; }

  /* Focus here is a soft ring rather than the app's default outline, to match the boxes it sits on. */
  button:focus-visible, summary:focus-visible, a:focus-visible { outline: none; box-shadow: var(--focus-ring); }

  .item {
    border: 1px solid var(--box-border);
    border-radius: 10px;
    background: var(--bg);
    box-shadow: var(--box-shadow);
    transition: box-shadow 0.15s, border-color 0.15s;
  }
  .item:hover { box-shadow: var(--box-shadow-raised); }
  .item[open] { border-color: color-mix(in srgb, var(--border) 75%, transparent); box-shadow: var(--box-shadow-raised); }
  summary, .runtime { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 6px 12px 6px 8px; }
  .runtime { padding-left: 12px; }
  summary { list-style: none; cursor: pointer; border-radius: 10px; transition: background-color 0.12s; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { background: color-mix(in srgb, var(--surface) 45%, transparent); }
  .item[open] summary { border-radius: 10px 10px 0 0; }
  .chevron { flex-shrink: 0; display: inline-flex; color: var(--muted); transition: transform 0.15s; }
  .item[open] .chevron { transform: rotate(90deg); }
  .name { min-width: 0; font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .version { flex-shrink: 0; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .tag {
    flex-shrink: 0;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--surface);
    font-size: 11px;
    font-weight: 500;
    color: var(--muted);
  }

  dl { display: flex; flex-wrap: wrap; gap: 4px 20px; margin: 0; }
  dl div { display: flex; align-items: baseline; gap: 6px; }
  dt { font-size: 14px; font-weight: 500; }
  dd { margin: 0; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }

  .detail { padding: 0 12px 12px; }
  .toolbar { display: flex; align-items: center; gap: 8px; min-height: 30px; margin-bottom: 4px; }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    border-radius: 4px;
    color: var(--link);
    font-size: 12px;
    text-decoration: none;
  }
  .link span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .link:hover span { text-decoration: underline; }
  pre {
    max-height: 280px;
    margin: 0;
    padding: 10px 12px;
    overflow: auto;
    border-radius: 8px;
    background: color-mix(in srgb, var(--surface) 55%, var(--bg));
    box-shadow: inset 0 0 0 1px var(--box-border);
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    height: 28px;
    padding: 0 12px;
    border: 1px solid var(--box-border);
    border-radius: 8px;
    background: var(--bg);
    box-shadow: var(--box-shadow);
    font-size: 13px;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 0.12s, box-shadow 0.12s;
  }
  .btn:hover { background: var(--surface); }
  .btn:focus-visible { box-shadow: var(--box-shadow), var(--focus-ring); }
  .btn.quiet { height: 26px; padding: 0 8px; border-color: transparent; background: none; box-shadow: none; color: var(--muted); font-size: 12px; }
  .btn.quiet:hover { background: var(--surface); color: var(--fg); }
  .btn.quiet:focus-visible { box-shadow: var(--focus-ring); }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 6px 0 10px;
    border: 1px solid var(--box-border);
    border-radius: 999px;
    background: var(--bg);
    box-shadow: var(--box-shadow);
    font-size: 12px;
    cursor: pointer;
    transition: background-color 0.12s, border-color 0.12s, box-shadow 0.12s;
  }
  .chip:hover { background: color-mix(in srgb, var(--surface) 60%, var(--bg)); }
  .chip.on {
    border-color: var(--focus-border);
    background: color-mix(in srgb, var(--accent) 10%, var(--bg));
    color: color-mix(in srgb, var(--accent) 70%, var(--fg));
  }
  .chip:focus-visible { box-shadow: var(--box-shadow), var(--focus-ring); }
  .n {
    min-width: 18px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--surface);
    font-size: 11px;
    color: var(--muted);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .chip.on .n { background: color-mix(in srgb, var(--accent) 16%, var(--bg)); color: inherit; }

  .filter {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    margin: 4px 0 2px;
    padding: 0 4px 0 12px;
    border: 1px solid var(--box-border);
    border-radius: 8px;
    background: var(--bg);
    box-shadow: var(--box-shadow);
    color: var(--muted);
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  .filter:focus-within { border-color: var(--focus-border); box-shadow: var(--box-shadow), var(--focus-ring); }
  .filter input { flex: 1; min-width: 0; border: 0; outline: none; background: none; color: var(--fg); font: inherit; font-size: 13px; }
  .matches { flex-shrink: 0; font-size: 12px; font-variant-numeric: tabular-nums; }
  .clear {
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
  .clear:hover { background: var(--surface); color: var(--fg); }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 20px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--surface) 35%, var(--bg));
  }
</style>

<script lang="ts">
  import Icon from './Icon.svelte'
  import { formatSize, installLabel, updates } from './updates.svelte'

  let { ondetails }: { ondetails: () => void } = $props()

  const release = $derived(updates.banner)
  const state = $derived(updates.status?.state)
  const status = $derived(updates.status)
</script>

{#if release && state}
  <div class="banner" role="status">
    <Icon name="download" />
    <span class="text">
      {#if state.phase === 'ready' && status?.install === 'appimage'}
        Zook {release.version} is installed. Restart to start using it.
      {:else if state.phase === 'ready'}
        Zook {release.version} is downloaded and verified. Run the installer to finish updating.
      {:else if state.phase === 'downloading'}
        Downloading Zook {release.version}… {formatSize(state.received)} of {formatSize(release.size ?? 0)}
      {:else if state.phase === 'error'}
        <span class="error">{state.message}</span>
      {:else}
        Zook {release.version} is available.
      {/if}
    </span>
    {#if state.phase === 'downloading'}
      <progress max={release.size ?? 0} value={state.received}></progress>
      <button class="btn" onclick={updates.cancel}>Cancel</button>
    {:else}
      <button class="btn quiet" onclick={ondetails}>What's new</button>
      {#if state.phase === 'ready' && status}
        <button class="btn primary" onclick={updates.install}>{installLabel(status)}</button>
      {:else if status && status.install !== 'link'}
        <button class="btn primary" onclick={updates.download}>{state.phase === 'error' ? 'Try again' : 'Update'}</button>
      {:else}
        <a class="btn primary" href={release.url} target="_blank" rel="noreferrer">Download <Icon name="external" /></a>
      {/if}
      <button
        class="close"
        onclick={() => (updates.dismissed = release.version)}
        title="Not now"
        aria-label="Dismiss update"
      >
        <Icon name="close" />
      </button>
    {/if}
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 10px 0;
    padding: 6px 6px 6px 12px;
    border: 1px solid var(--box-border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 6%, var(--bg));
    box-shadow: var(--box-shadow);
    font-size: 13px;
    color: var(--accent);
  }
  .text { flex: 1; min-width: 0; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .error { color: var(--error); }
  progress { flex-shrink: 0; width: 120px; height: 6px; accent-color: var(--accent); }
  .btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 12px;
    border: 1px solid var(--box-border);
    border-radius: 6px;
    background: var(--bg);
    box-shadow: var(--box-shadow);
    color: var(--fg);
    font-size: 13px;
    text-decoration: none;
    cursor: pointer;
  }
  .btn:hover { background: var(--surface); }
  .btn.primary { border-color: var(--accent); background: var(--accent); color: var(--bg); font-weight: 600; }
  .btn.primary:hover { background: var(--accent); filter: brightness(1.08); }
  .btn.quiet { border-color: transparent; background: none; box-shadow: none; color: var(--link); }
  .btn.quiet:hover { background: none; text-decoration: underline; }
  .close {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .close:hover { background: var(--surface); color: var(--fg); }
</style>

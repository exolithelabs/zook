<script lang="ts" module>
  // Line icons on a 24-unit grid, drawn at 16px with one stroke weight so they match everywhere.
  // Circles are written as two arcs so every shape is a path.
  const paths = {
    chevron: ['M9 6l6 6-6 6'],
    chat: ['M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    copy: ['M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
    download: ['M12 4v11', 'M7.5 10.5L12 15l4.5-4.5', 'M5 20h14'],
    edit: ['M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z', 'M14 6l4 4'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0'],
    // A closed lid with lashes.
    'eye-closed': ['M3 10c2.5 3.3 5.5 5 9 5s6.5-1.7 9-5', 'M12 15v3', 'M7.3 13.8l-1.4 2.6', 'M16.7 13.8l1.4 2.6', 'M4.6 12l-2.1 1.9', 'M19.4 12l2.1 1.9'],
    globe: [
      'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0',
      'M3 12h18',
      'M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9s1.3-6.5 3.8-9z'
    ],
    history: ['M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5', 'M3.5 4v4.5H8', 'M12 7.5V12l3 2'],
    // A page with a folded corner.
    license: ['M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M14 3v5h5', 'M9 13h6', 'M9 17h6'],
    menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
    plus: ['M12 5v14', 'M5 12h14'],
    retry: ['M20 12a8 8 0 1 1-2.3-5.7', 'M20 4v4.5h-4.5'],
    search: ['M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0', 'M16 16l4 4'],
    send: ['M12 19V5', 'M6 11l6-6 6 6'],
    settings: [
      'M4 6h9',
      'M13 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
      'M17 6h3',
      'M4 12h3',
      'M7 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
      'M11 12h9',
      'M4 18h11',
      'M15 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
      'M19 18h1'
    ],
    shield: ['M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z'],
    stop: ['M7 7h10v10H7z']
  } satisfies Record<string, string[]>

  // A hollow stop square reads oddly, so it is the one solid shape.
  const filled = new Set<IconName>(['stop'])

  export type IconName = keyof typeof paths

  // The same icon as markup, for HTML built outside a component (e.g. rendered Markdown).
  export function iconSvg(name: IconName): string {
    const fill = filled.has(name) ? 'currentColor' : 'none'
    return `<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name].map((d) => `<path d="${d}"/>`).join('')}</svg>`
  }
</script>

<script lang="ts">
  let { name }: { name: IconName } = $props()
</script>

<svg
  class="icon"
  viewBox="0 0 24 24"
  width="16"
  height="16"
  fill={filled.has(name) ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each paths[name] as d (d)}<path {d} />{/each}
</svg>

<style>
  /* Sits on the text's middle when inline; flex parents centre it themselves. */
  .icon { display: inline-block; flex-shrink: 0; vertical-align: -0.2em; }
</style>

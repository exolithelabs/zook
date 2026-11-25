import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
// Records which packages end up in each bundle, for scripts/licenses.mjs.
import { bundledPackages } from './scripts/licenses.mjs'

export default defineConfig({
  main: {
    plugins: [bundledPackages()]
  },
  // `index` is the app's own preload; `web` runs in the web pages shown in popups.
  preload: {
    plugins: [bundledPackages()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          web: resolve(__dirname, 'src/preload/web.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [svelte(), bundledPackages()]
  }
})

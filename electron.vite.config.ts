import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  main: {},
  // `index` is the app's own preload; `web` runs in the web pages shown in popups.
  preload: {
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
    plugins: [svelte()]
  }
})

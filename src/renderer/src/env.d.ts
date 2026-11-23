/// <reference types="svelte" />
/// <reference types="vite/client" />
import type { ZookApi } from '../../preload/index'

declare global {
  interface Window {
    zook: ZookApi
  }
}

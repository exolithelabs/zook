import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ChatPresetId } from '../main/chat'
import type { History } from '../main/history'
import type { ChatSource, PageState, Shortcut } from '../main/index'
import type { ProviderId, SearchResponse, Vertical } from '../main/providers'
import type { SettingsStatus } from '../main/settings'
import type { ChatBackend, Thread, ThreadSummary } from '../main/threads'

function listen<T>(channel: string, cb: (value: T) => void) {
  const handler = (_e: IpcRendererEvent, value: T) => cb(value)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api = {
  search: (vertical: Vertical, query: string, page = 0): Promise<SearchResponse> =>
    ipcRenderer.invoke('search', vertical, query, page),
  settings: {
    get: (): Promise<SettingsStatus> => ipcRenderer.invoke('settings:get'),
    save: (id: ProviderId, creds: Record<string, string>): Promise<SettingsStatus> =>
      ipcRenderer.invoke('settings:save', id, creds),
    clear: (id: ProviderId): Promise<SettingsStatus> => ipcRenderer.invoke('settings:clear', id),
    setActive: (id: ProviderId): Promise<SettingsStatus> => ipcRenderer.invoke('settings:setActive', id),
    setAdblock: (enabled: boolean): Promise<SettingsStatus> => ipcRenderer.invoke('settings:setAdblock', enabled),
    saveSuggestKey: (key: string): Promise<SettingsStatus> => ipcRenderer.invoke('settings:saveSuggestKey', key),
    clearSuggestKey: (): Promise<SettingsStatus> => ipcRenderer.invoke('settings:clearSuggestKey'),
    setSidebar: (open: boolean) => ipcRenderer.send('settings:setSidebar', open),
    // The API key goes to main only; status reports back just its last four characters.
    saveChat: (preset: ChatPresetId, baseUrl: string, model: string, apiKey: string): Promise<SettingsStatus> =>
      ipcRenderer.invoke('settings:saveChat', preset, baseUrl, model, apiKey),
    // A blank key uses the saved one, for the same base URL only.
    listChatModels: (preset: ChatPresetId, baseUrl: string, apiKey: string): Promise<string[]> =>
      ipcRenderer.invoke('settings:listChatModels', preset, baseUrl, apiKey),
    clearChat: (): Promise<SettingsStatus> => ipcRenderer.invoke('settings:clearChat'),
    setChatGrounded: (grounded: boolean): Promise<SettingsStatus> =>
      ipcRenderer.invoke('settings:setChatGrounded', grounded)
  },
  chat: {
    // Resolves with a request id and the model answering; the reply arrives through the events below.
    start: (
      messages: { role: 'user' | 'assistant'; content: string }[],
      grounded: boolean,
      sessionId: string
    ): Promise<{ requestId: string; backend: ChatBackend }> =>
      ipcRenderer.invoke('chat:start', messages, grounded, sessionId),
    abort: (requestId: string): Promise<void> => ipcRenderer.invoke('chat:abort', requestId),
    onSources: (cb: (e: { requestId: string; sources: ChatSource[] }) => void) => listen('chat:sources', cb),
    onDelta: (cb: (e: { requestId: string; text: string }) => void) => listen('chat:delta', cb),
    onDone: (cb: (e: { requestId: string; finishReason: string }) => void) => listen('chat:done', cb),
    onError: (cb: (e: { requestId: string; message: string }) => void) => listen('chat:error', cb)
  },
  suggest: {
    local: (input: string): Promise<{ searches: string[]; pages: { url: string; title: string }[] }> =>
      ipcRenderer.invoke('suggest:local', input),
    remote: (input: string): Promise<string[]> => ipcRenderer.invoke('suggest:remote', input)
  },
  history: {
    get: (): Promise<History> => ipcRenderer.invoke('history:get'),
    removeSearch: (query: string): Promise<void> => ipcRenderer.invoke('history:removeSearch', query),
    removeVisit: (url: string): Promise<void> => ipcRenderer.invoke('history:removeVisit', url),
    clear: (): Promise<void> => ipcRenderer.invoke('history:clear')
  },
  // Saved chat threads. Each call that changes one resolves with the updated list.
  threads: {
    list: (): Promise<ThreadSummary[]> => ipcRenderer.invoke('threads:list'),
    get: (id: string): Promise<Thread | null> => ipcRenderer.invoke('threads:get', id),
    save: (thread: Thread): Promise<ThreadSummary[]> => ipcRenderer.invoke('threads:save', thread),
    rename: (id: string, title: string): Promise<ThreadSummary[]> => ipcRenderer.invoke('threads:rename', id, title),
    delete: (id: string): Promise<ThreadSummary[]> => ipcRenderer.invoke('threads:delete', id)
  },
  // Each popup is numbered by the renderer; only the top one's page is shown.
  page: {
    open: (id: number, url: string) => ipcRenderer.send('page:open', id, url),
    show: (id: number | null) => ipcRenderer.send('page:show', id),
    close: (id: number) => ipcRenderer.send('page:close', id),
    openExternal: (id: number) => ipcRenderer.send('page:external', id),
    capture: (id: number): Promise<string | null> => ipcRenderer.invoke('page:capture', id),
    setBounds: (b: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('page:bounds', b),
    onState: (cb: (state: PageState) => void) => listen('page:state', cb),
    // "Search for …" from a page's context menu.
    onSearch: (cb: (query: string) => void) => listen('page:search', cb),
    // A link followed in the popup `from`, to open as a new popup on top.
    onLink: (cb: (link: { from: number; url: string }) => void) => listen('page:link', cb)
  },
  onShortcut: (cb: (shortcut: Shortcut) => void) => listen('shortcut', cb)
}

export type ZookApi = typeof api

contextBridge.exposeInMainWorld('zook', api)

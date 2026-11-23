import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { History } from '../main/history'
import type { Shortcut, TabState } from '../main/index'
import type { ProviderId, SearchResponse } from '../main/providers'
import type { SettingsStatus } from '../main/settings'

function listen<T>(channel: string, cb: (value: T) => void) {
  const handler = (_e: IpcRendererEvent, value: T) => cb(value)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api = {
  search: (query: string, page = 0): Promise<SearchResponse> => ipcRenderer.invoke('search', query, page),
  settings: {
    get: (): Promise<SettingsStatus> => ipcRenderer.invoke('settings:get'),
    save: (id: ProviderId, creds: Record<string, string>): Promise<SettingsStatus> =>
      ipcRenderer.invoke('settings:save', id, creds),
    clear: (id: ProviderId): Promise<SettingsStatus> => ipcRenderer.invoke('settings:clear', id),
    setActive: (id: ProviderId): Promise<SettingsStatus> => ipcRenderer.invoke('settings:setActive', id),
    setAdblock: (enabled: boolean): Promise<SettingsStatus> => ipcRenderer.invoke('settings:setAdblock', enabled),
    saveSuggestKey: (key: string): Promise<SettingsStatus> => ipcRenderer.invoke('settings:saveSuggestKey', key),
    clearSuggestKey: (): Promise<SettingsStatus> => ipcRenderer.invoke('settings:clearSuggestKey')
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
  tabs: {
    open: (tabId: number, url: string, fresh = false) => ipcRenderer.send('tab:open', tabId, url, fresh),
    show: (tabId: number | null) => ipcRenderer.send('tab:show', tabId),
    close: (tabId: number) => ipcRenderer.send('tab:close', tabId),
    back: (tabId: number) => ipcRenderer.send('tab:back', tabId),
    forward: (tabId: number) => ipcRenderer.send('tab:forward', tabId),
    reload: (tabId: number) => ipcRenderer.send('tab:reload', tabId),
    stop: (tabId: number) => ipcRenderer.send('tab:stop', tabId),
    openExternal: (tabId: number) => ipcRenderer.send('tab:external', tabId),
    capture: (tabId: number): Promise<string | null> => ipcRenderer.invoke('tab:capture', tabId),
    setBounds: (b: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('tab:bounds', b),
    onState: (cb: (state: TabState) => void) => listen('tab:state', cb),
    // A page asked to open a link in a new tab.
    onNew: (cb: (req: { url: string; background: boolean }) => void) => listen('tab:new', cb),
    onSearchNew: (cb: (query: string) => void) => listen('search:new-tab', cb)
  },
  onShortcut: (cb: (shortcut: Shortcut) => void) => listen('shortcut', cb)
}

export type ZookApi = typeof api

contextBridge.exposeInMainWorld('zook', api)

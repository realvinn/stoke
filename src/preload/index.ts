import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { CH } from '@shared/ipc'
import type { HearthApi } from '@shared/api'
import type { Rect, LaunchOptions, Settings } from '@shared/types'

/** Subscribe helper that hands back an unsubscribe function. */
function on<A extends unknown[]>(
  channel: string,
  cb: (...args: A) => void
): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: HearthApi = {
  platform: process.platform,

  window: {
    minimize: () => ipcRenderer.send(CH.winMinimize),
    maximize: () => ipcRenderer.send(CH.winMaximize),
    close: () => ipcRenderer.send(CH.winClose),
    isMaximized: () => ipcRenderer.invoke(CH.winIsMaximized),
    onMaximizedChanged: (cb) => on<[boolean]>(CH.winMaximizedChanged, cb)
  },

  cli: {
    info: () => ipcRenderer.invoke(CH.cliInfo)
  },

  projects: {
    list: () => ipcRenderer.invoke(CH.projectsList),
    sessions: (projectPath: string) => ipcRenderer.invoke(CH.sessionsList, projectPath),
    addRoot: () => ipcRenderer.invoke(CH.projectsAddRoot),
    open: () => ipcRenderer.invoke(CH.projectsAdd),
    hide: (path: string, hidden: boolean) => ipcRenderer.invoke(CH.projectsHide, path, hidden),
    pin: (path: string, pinned: boolean) => ipcRenderer.invoke(CH.projectsPin, path, pinned),
    reveal: (path: string) => ipcRenderer.invoke(CH.projectsReveal, path)
  },

  pty: {
    start: (opts: LaunchOptions) => ipcRenderer.invoke(CH.ptyStart, opts),
    write: (ptyId: string, data: string) => ipcRenderer.send(CH.ptyWrite, ptyId, data),
    resize: (ptyId: string, cols: number, rows: number) =>
      ipcRenderer.send(CH.ptyResize, ptyId, cols, rows),
    kill: (ptyId: string) => ipcRenderer.send(CH.ptyKill, ptyId),
    onData: (cb) => on<[string, string]>(CH.ptyData, cb),
    onExit: (cb) => on<[string, number, number | undefined]>(CH.ptyExit, cb)
  },

  context: {
    watch: (sessionId: string) => ipcRenderer.send(CH.ctxWatch, sessionId),
    unwatch: (sessionId: string) => ipcRenderer.send(CH.ctxUnwatch, sessionId),
    onUpdate: (cb) => on<[Parameters<typeof cb>[0]]>(CH.ctxUpdate, cb)
  },

  browser: {
    setBounds: (rect: Rect) => ipcRenderer.send(CH.browserSetBounds, rect),
    show: (url?: string) => ipcRenderer.send(CH.browserShow, url),
    hide: () => ipcRenderer.send(CH.browserHide),
    navigate: (url: string) => ipcRenderer.send(CH.browserNavigate, url),
    back: () => ipcRenderer.send(CH.browserBack),
    forward: () => ipcRenderer.send(CH.browserForward),
    reload: () => ipcRenderer.send(CH.browserReload),
    stop: () => ipcRenderer.send(CH.browserStop),
    openExternal: () => ipcRenderer.send(CH.browserOpenExternal),
    devtools: () => ipcRenderer.send(CH.browserDevtools),
    onState: (cb) => on<[Parameters<typeof cb>[0]]>(CH.browserState, cb)
  },

  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke(CH.settingsSet, patch),
    onChange: (cb) => on<[Settings]>(CH.settingsChanged, cb)
  },

  openExternal: (url: string) => ipcRenderer.send(CH.openExternal, url)
}

contextBridge.exposeInMainWorld('hearth', api)

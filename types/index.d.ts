export type Shown = {
  path: string
  png: string
  generation: number
  width: number
  height: number
}

declare module 'claude-code' {
  interface PluginState {
    'img-viewer': { current: Shown | null }
  }
}


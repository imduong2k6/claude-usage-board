export type BoardView = { tab: 'overview' | 'models'; range: 'all' | '30d' | '7d' }

declare module 'claude-code' {
  interface PluginState {
    'usage-board': { view: Shaped<BoardView> }
  }
}

declare module 'claude-code' {
  interface PluginState {
    'task-map': {
      /** taskmap.md and tasks/<name>.md contents, keyed by path */
      files: Shaped<Record<string, string>>
      /** '' = global view, otherwise the open task's name */
      view: Shaped<string>
    }
  }
}

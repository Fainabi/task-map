/** A subagent this session started, tracked from its spawn, tool calls and end. */
export type TrackedAgent = {
  /** the spawn's key: the tail of its Agent tool_use_id */
  key: string
  /** the engine's agent id, once started */
  id: string
  desc: string
  type: string
  state: 'running' | 'done' | 'stopped'
  tools: number
  /** the last tool call, summarised ("Read auth.ts") */
  last: string
  /** the last few tool calls, oldest first */
  recent: string[]
  /** the start of the report it handed back, once finished */
  report: string
  started: number
  ended: number
}

/** One line of a session's board file, .taskmap/board/<sid>.jsonl. */
export type BoardEntry = {
  t: number
  /** '<sid>' for a session, '<sid>/<agent key>' for one of its subagents */
  from: string
  /** whom it is addressed to, same spelling as `from`; '' for everyone */
  to: string
  /** 'post' was written by a model; 'event' by the mod */
  kind: 'post' | 'event'
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    'task-map': {
      /** taskmap.md, tasks/*.md and .taskmap/** contents, keyed by path */
      files: Shaped<Record<string, string>>
      /** '' overview, 'list', 'swarm', 'task:<name>' or 'sess:<sid>' */
      view: Shaped<string>
      /** board read marks: `at` the last time the swarm view opened, `mark` the time before */
      seen: Shaped<{ mark: number; at: number }>
      /** per reader ('<sid>' or '<sid>/<key>'), when it last read the board through the tool */
      reads: Shaped<Record<string, number>>
      /** this session's subagents, keyed by TrackedAgent.key */
      agents: Shaped<Record<string, TrackedAgent>>
      /** this session's short id */
      me: Shaped<string>
    }
  }
}

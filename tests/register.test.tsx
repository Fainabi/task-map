import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'task-map',
  component: 'Pane',
  requestId: 'task-map',
  props: {
    title: 'Task Map',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const MAP = '# 🎯 Goal\nShip it.\n\n## Tasks\n- ✅ form\n- 🔵 api — needs: form\n- ⬜ tests — needs: api\n'

// A folder in memory: every write bumps the file's modification time. The
// engine hands the hooks absolute paths, so each is read relative to the
// folder the first one shows.
function folder(on: On, files: Record<string, string>) {
  const mtime: Record<string, number> = {}
  let tick = 1
  for (const p of Object.keys(files)) mtime[p] = tick++
  let root = ''
  const rel = (p: string) => {
    if (root === '' && p.startsWith('/')) {
      const known = Object.keys(files).find(k => p.endsWith(`/${k}`))
      if (known !== undefined) root = p.slice(0, p.length - known.length)
      else if (p.endsWith('/taskmap.md')) root = p.slice(0, p.length - 'taskmap.md'.length)
    }
    return root !== '' && p.startsWith(root) ? p.slice(root.length) : p
  }
  const missing = (p: string) => new Error(`ENOENT: ${p}`)
  on('fs.read', (_, e) => {
    const text = files[rel(e.path)]
    if (text === undefined) throw missing(e.path)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    const p = rel(e.path)
    files[p] = e.text
    mtime[p] = tick++
    return { value: undefined }
  })
  on('fs.exists', (_, e) => {
    const p = rel(e.path)
    return { value: p in files || Object.keys(files).some(k => k.startsWith(`${p}/`)) }
  })
  on('fs.stat', (_, e) => {
    const p = rel(e.path)
    const text = files[p]
    if (text === undefined) throw missing(e.path)
    return { value: { kind: 'file', size: text.length, mtimeMs: mtime[p] ?? 0, isLink: false } }
  })
  on('fs.list', (_, e) => {
    const pre = `${rel(e.path)}/`
    const names = Object.keys(files).filter(k => k.startsWith(pre) && !k.slice(pre.length).includes('/'))
    return {
      value: names.map(k => ({ name: k.slice(pre.length), kind: 'file', size: 0, mtimeMs: mtime[k] ?? 0, isLink: false })),
    }
  })
  return files
}

const run = (args: string) => ({
  command: 'map',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
}) as const

function engine(on: On) {
  mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'map' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'abcdef1234567890' }))
}

test('a subagent shows in the pane with its last tool call', async ($, on) => {
  engine(on)
  const files = folder(on, { 'taskmap.md': MAP })
  let prompt = ''
  on('agent.spawn', (_, e) => {
    prompt = e.prompt
    return { model: 'test', agentId: 'agent-1' }
  })
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({
    tool_use_id: 'toolu_01abc123',
    prompt: 'Find the auth code',
    description: 'find auth',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'test',
    background: false,
    fork: false,
  })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/auth.ts', agentId: 'agent-1' })

  expect(prompt).toContain('.taskmap/agents/abcdef12-')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const row = await ui.find({ type: 'Text', text: /find auth/ })
    expect(row?.text).toContain('⟳ Explore')
    expect(row?.text).toContain('Read auth.ts')
    await ui.unmount()
  }
  expect(files['.taskmap/.gitignore']).toBe('*\n')
})

test('another session working under a task shows under that task', async ($, on) => {
  engine(on)
  folder(on, {
    'taskmap.md': MAP,
    '.taskmap/sessions/c3d4e5f6.md': 'from: api\nlabel: retries\nstate: active\n\n## Now\n📍 adding retry\n\n## Tasks\n- ✅ backoff\n- 🔵 retry on 503\n',
    '.taskmap/sessions/c3d4e5f6.json': JSON.stringify({ sid: 'c3d4e5f6', alive: true, updated: 1_000_000, agents: [] }),
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = await ui.find({ type: 'Text', text: /retries/ })
  expect(row?.text).toContain('⑂ c3d4e5f6 "retries" · 1/2 · 🔵 retry on 503')
  await ui.unmount()
})

test('/map merge folds the session tasks into the main task', async ($, on) => {
  engine(on)
  const files = folder(on, {
    'taskmap.md': MAP,
    'tasks/api.md': '## Steps\n- ✅ Pick the endpoint\n\n## Notes\nkeep\n',
    '.taskmap/sessions/abcdef12.md': 'from: api\nlabel: retries\nstate: active\n\n## Now\n📍 done\n\n## Tasks\n- ✅ backoff\n- ✅ retry on 503\n',
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run(run('merge'))

  expect(out.text).toContain('Merged 2 step(s)')
  expect(files['tasks/api.md']).toBe(
    '## Steps\n- ✅ Pick the endpoint\n- ✅ backoff (⑂ retries)\n- ✅ retry on 503 (⑂ retries)\n\n## Notes\nkeep\n',
  )
  expect(files['.taskmap/sessions/abcdef12.md']).toContain('state: merged')
  const again = await $.command.run(run('merge'))
  expect(again.text).toContain('already merged')
})

test('/map branch writes this session file', async ($, on) => {
  engine(on)
  const files = folder(on, { 'taskmap.md': MAP })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(run('branch api retry work'))

  const text = files['.taskmap/sessions/abcdef12.md'] ?? ''
  expect(text).toContain('from: api')
  expect(text).toContain('label: retry work')
  expect(text).toContain('state: active')
})

test('the board: a finished subagent posts, the tool posts and reads, the swarm shows both', async ($, on) => {
  engine(on)
  const files = folder(on, {
    'taskmap.md': MAP,
    '.taskmap/sessions/c3d4e5f6.json': JSON.stringify({ sid: 'c3d4e5f6', alive: true, updated: 999_000, agents: [] }),
    '.taskmap/board/c3d4e5f6.jsonl': `${JSON.stringify({ t: 999_000, from: 'c3d4e5f6', to: 'abcdef12', kind: 'post', text: 'form is ready' })}\n`,
  })
  on('tool.register', () => ({ value: { tool: 'mcp__task-map__board' } }))
  on('agent.spawn', () => ({ model: 'test', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({
    tool_use_id: 'toolu_01abc123',
    prompt: 'Find the auth code',
    description: 'find auth',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'test',
    background: false,
    fork: false,
  })
  await $.turn.complete({
    answer: '## Found it in src/auth.ts\nmore detail',
    durationMs: 5,
    isAborted: false,
    turnId: 't1',
    agentId: 'agent-1',
    reason: 'answer',
  })

  // The board tool is registered at run time, so the typed tool list doesn't name it.
  const board = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__task-map__board', ...input } as never)

  const mineBoard = files['.taskmap/board/abcdef12.jsonl'] ?? ''
  expect(mineBoard).toContain('started: find auth')
  expect(mineBoard).toContain('finished: find auth — Found it in src/auth.ts')

  const first = await board({ post: 'claimed api' })
  expect(String(first.result)).toContain('Posted as abcdef12.')
  expect(String(first.result)).toContain('c3d4e5f6 → abcdef12: form is ready')
  const second = await board({})
  expect(String(second.result)).toContain('Nothing new on the board.')

  // A subagent reads as itself, so it still sees the other session's post.
  const fromAgent = await board({ agentId: 'agent-1' })
  expect(String(fromAgent.result)).toContain('You are abcdef12/abc123')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'swarm' })
    expect((await ui.find({ type: 'Text', text: /◆ Swarm/ }))?.text).toContain('2 sessions · 1 agent')
    expect((await ui.find({ type: 'Text', text: /form is ready/ }))?.text).toContain('c3d4e5f6 → you  form is ready')
    expect((await ui.find({ type: 'Text', text: /claimed api/ }))?.text).toContain('you  claimed api')
    expect((await ui.find({ type: 'Text', text: /finished: find auth/ }))?.text).toContain('you/Explore')
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test("a subagent's task list: set with the plan tool, opened from the swarm", async ($, on) => {
  engine(on)
  const files = folder(on, { 'taskmap.md': MAP })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__task-map__${e.name}` } }))
  on('agent.spawn', () => ({ model: 'test', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({
    tool_use_id: 'toolu_01abc123',
    prompt: 'Find the auth code',
    description: 'find auth',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'test',
    background: false,
    fork: false,
  })
  const plan = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__task-map__plan', ...input } as never)
  const saved = await plan({
    agentId: 'agent-1',
    steps: [
      { text: 'List the auth files', status: 'done' },
      { text: 'Read the login handler', status: 'doing' },
      { text: 'Summarize', status: 'todo' },
    ],
  })
  expect(String(saved.result)).toContain('Task list saved (3 steps)')
  expect(files['.taskmap/agents/abcdef12-abc123.md']).toBe(
    '## Steps\n- ✅ List the auth files\n- 🔵 Read the login handler\n- ⬜ Summarize\n',
  )
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/login.ts', agentId: 'agent-1' })

  // The main session's own call fills its "## Tasks".
  await plan({ steps: [{ text: 'Wire the board', status: 'doing' }] })
  expect(files['.taskmap/sessions/abcdef12.md']).toContain('## Tasks\n- 🔵 Wire the board\n')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'swarm' })
    await ui.press({ key: 'crew:abcdef12:abc123' })
    expect((await ui.find({ type: 'Text', text: /Task list/ }))?.text).toContain('1/3')
    expect((await ui.find({ type: 'Text', text: /Read the login handler/ }))?.text).toContain('🔵')
    expect((await ui.find({ type: 'Text', text: /login\.ts/ }))?.text).toContain('⟳ Read login.ts')
    // Back goes to the session page, where the same agent is numbered.
    await ui.press({ key: 'back' })
    expect((await ui.find({ type: 'Button', text: /find auth/ }))?.text).toContain('1/3')
    await ui.press({ key: 'back' }) // to the swarm
    await ui.press({ key: 'back' }) // to the overview
    await ui.unmount()
  }
})

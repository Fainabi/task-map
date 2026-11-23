import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const PANE = 'task-map'
const GLOBAL = 'taskmap.md'
const DIR = 'tasks'
const STATUS = ['✅', '🔵', '⬜', '⏳']

const files = atom({ plugin: 'task-map', key: 'files' } as const, {}, { shape: 'files-1' })
const view = atom({ plugin: 'task-map', key: 'view' } as const, '', { shape: 'view-2' })

const REMINDER = [
  'Task Map: this project keeps its task map in taskmap.md (global) and tasks/<name>.md (local maps); a pane beside the chat shows them.',
  'Whenever a step finishes or the plan changes, update them in the same turn:',
  '- taskmap.md "## Tasks": one line per task, "- ✅|🔵|⬜ name — needs: a, b | note"; exactly one 🔵 task is current.',
  '- tasks/<name>.md: the "- ✅|🔵|⬜ step" lines of that task.',
  '- taskmap.md "## Now": four lines, rewritten every turn that changes something:',
  '  📍 Where we are: <one sentence>',
  '  ✅ How to check: <one small thing to try>',
  '  👉 Suggested next: <one step, why in a few words>',
  '  💡 Learned: <one concept, optional>',
  'The pane shows "## Now", so end chat replies with only "👉 next: <step>" rather than the full block.',
].join('\n')

// Pulls the "## Now" section out of taskmap.md, so it can be pinned on top.
function extractNow(text: string) {
  const lines = text.split('\n')
  const start = lines.findIndex(l => /^##\s+now\b/i.test(l.trim()))
  if (start < 0) return { now: '', rest: text }
  let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l.trim()))
  if (end < 0) end = lines.length
  return {
    now: lines.slice(start + 1, end).join('\n').trim(),
    rest: [...lines.slice(0, start), ...lines.slice(end)].join('\n'),
  }
}

type Task = { name: string; status: string; needs: string[]; note: string }

// Reads taskmap.md and every tasks/*.md into state, which redraws the pane.
async function refresh($: EngineInterface) {
  const next: Record<string, string> = {}
  const top = await $.fs.read(GLOBAL).catch(() => undefined)
  if (typeof top === 'string') next[GLOBAL] = top
  const entries = await $.fs.list(DIR).catch(() => [])
  for (const one of entries) {
    if (one.kind !== 'file' || !one.name.endsWith('.md')) continue
    const body = await $.fs.read(`${DIR}/${one.name}`).catch(() => undefined)
    if (typeof body === 'string') next[`${DIR}/${one.name}`] = body
  }
  await update($, files, () => next)
}

// Splits taskmap.md into the part before "## Tasks", the task lines, and the rest.
function parse(text: string) {
  const lines = text.split('\n')
  const start = lines.findIndex(l => /^##\s+tasks\b/i.test(l.trim()))
  if (start < 0) return { head: text, tasks: [] as Task[], tail: '' }
  let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l.trim()))
  if (end < 0) end = lines.length
  const tasks: Task[] = []
  for (const line of lines.slice(start + 1, end)) {
    const m = line.match(/^\s*[-*]\s*(\S+)?\s+([A-Za-z0-9._-]+)\s*(?:[—–-]+\s*(.*))?$/)
    if (!m) continue
    const status = STATUS.includes(m[1] ?? '') ? (m[1] as string) : '⬜'
    const rest = m[3] ?? ''
    const needsMatch = rest.match(/needs:\s*([A-Za-z0-9._,\s-]+)/i)
    const needs = needsMatch
      ? (needsMatch[1] ?? "").split(',').map(s => s.trim()).filter(Boolean)
      : []
    const note = rest.replace(/needs:\s*[A-Za-z0-9._,\s-]+/i, '').replace(/^\s*[|·]\s*/, '').replace(/\s*[|·]\s*$/, '').trim()
    tasks.push({ name: m[2] ?? "", status, needs, note })
  }
  return {
    head: lines.slice(0, start).join('\n').trim(),
    tasks,
    tail: lines.slice(end).join('\n').trim(),
  }
}

// Step lines of a local map: "- ✅ text", with **bold** markers dropped.
function steps(text: string) {
  const out: { status: string; text: string }[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*[-*]\s*(✅|🔵|⬜|⏳)\s*(.*)$/)
    if (m) out.push({ status: m[1] ?? '⬜', text: (m[2] ?? '').replace(/\*\*/g, '').trim() })
  }
  return out
}

function isBlocked(task: Task, all: Task[]) {
  if (task.status === '✅') return false
  return task.needs.some(n => all.find(t => t.name === n)?.status !== '✅')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'map',
      description: 'Open the Task Map pane (global goal, tasks, local maps)',
    })
    await refresh($)
    void $.ui.open({ id: PANE, title: 'Task Map' })
    return next(e)
  })

  // Reminds the model every turn to keep the maps and the "## Now" block current.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    return {
      ...result,
      sections: [...result.sections, { id: 'task-map:maintain', text: REMINDER, scope: 'session' as const }],
    }
  })

  on('command.run', { command: 'map' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Task Map' })
    return { text: 'Task Map opened.' }
  })

  // Redraw whenever a map file is written or edited, and at every turn's end.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.tool === 'Write' || e.tool === 'Edit') {
      const p = String(e.file_path)
      if (p.endsWith(GLOBAL) || p.includes(`/${DIR}/`)) await refresh($).catch(() => {})
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($).catch(() => {})
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Markdown } = $.ui.resolve(e)
    const top = (await read($, files))[GLOBAL]
    const now = top === undefined ? '' : extractNow(top).now
    const body = await (async () => {
      const { Box, Text, Button, Markdown } = $.ui.resolve(e)
      const all = await read($, files)
      const open = await read($, view)
      const top = all[GLOBAL]

      if (top === undefined) {
        return (
          <Box flexDirection="column">
            <Text dimColor>No taskmap.md in this folder yet.</Text>
            <Text dimColor>Ask Claude to start a task map.</Text>
          </Box>
        )
      }

      const { rest } = extractNow(top)
      const { head, tasks, tail } = parse(rest)
      const toggle = (
        <Button
          key="toggle"
          hotkey="o"
          plain
          dimColor
          onPress={() => update($, view, v => (v === '' ? 'list' : ''))}
        >
          {open === '' ? 'Task list' : 'Overview'}
        </Button>
      )
      const mark = (task: Task) => (isBlocked(task, tasks) ? '⏳' : task.status)
      const openTask = (task: Task) => () => update($, view, () => `task:${task.name}`)

      if (open.startsWith('task:')) {
        const name = open.slice(5)
        const task = tasks.find(t => t.name === name)
        const local = all[`${DIR}/${name}.md`]
        const deps = task?.needs ?? []
        return (
          <Box flexDirection="column">
            <Button key="back" hotkey="b" plain onPress={() => update($, view, () => '')}>
              Back to overview
            </Button>
            <Text bold>
              {task ? mark(task) : '⬜'} {name}
            </Text>
            {deps.length > 0 && (
              <Text dimColor>
                needs: {deps.map(d => `${tasks.find(t => t.name === d)?.status ?? '?'} ${d}`).join(', ')}
              </Text>
            )}
            {local !== undefined ? (
              <Markdown text={local} />
            ) : (
              <Text dimColor>No local map yet ({DIR}/{name}.md).</Text>
            )}
          </Box>
        )
      }

      if (open === 'list') {
        return (
          <Box flexDirection="column">
            {toggle}
            {head !== '' && <Markdown text={head} />}
            <Text bold>Tasks</Text>
            {tasks.length === 0 && <Text dimColor>No tasks under "## Tasks" yet.</Text>}
            {tasks.map((task, i) => (
              <Button
                key={`task:${task.name}`}
                hotkey={i < 9 ? String(i + 1) : undefined}
                plain
                dimColor={task.status === '✅'}
                onPress={openTask(task)}
              >
                {mark(task)} {task.name}
                <Text dimColor>
                  {task.needs.length > 0 ? `  ← ${task.needs.join(', ')}` : ''}
                  {task.note !== '' ? `  ${task.note}` : ''}
                  {all[`${DIR}/${task.name}.md`] !== undefined ? '  ›' : ''}
                </Text>
              </Button>
            ))}
            {tail !== '' && <Markdown text={tail} />}
          </Box>
        )
      }

      // Overview: the whole tree, open tasks with their steps expanded.
      const goal = head.split('\n').map(l => l.trim()).find(l => l !== '' && !l.startsWith('#')) ?? 'Goal'
      return (
        <Box flexDirection="column">
          {toggle}
          <Text bold>🎯 {goal}</Text>
          {tasks.length === 0 && <Text dimColor>No tasks under "## Tasks" yet.</Text>}
          {tasks.map((task, i) => {
            const last = i === tasks.length - 1
            const local = all[`${DIR}/${task.name}.md`]
            const list = task.status !== '✅' && local !== undefined ? steps(local) : []
            return (
              <Box key={`row:${task.name}`} flexDirection="column">
                <Button
                  key={`tree:${task.name}`}
                  hotkey={i < 9 ? String(i + 1) : undefined}
                  plain
                  dimColor={task.status === '✅'}
                  onPress={openTask(task)}
                >
                  {last ? '└─ ' : '├─ '}
                  {mark(task)} {task.name}
                  <Text dimColor>{task.needs.length > 0 ? `  ← ${task.needs.join(', ')}` : ''}</Text>
                  <Text bold>{task.status === '🔵' ? '  ← now' : ''}</Text>
                </Button>
                {list.length > 0 && (
                  <Text dimColor>
                    {last ? '     ' : '│    '}
                    {list.map(st => `${st.status} ${st.text}`).join(' · ')}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>
      )
    })()
    // Tasks fill the column from the top; the "## Now" status sits at its bottom.
    // A docked pane is exactly its body's rows tall, so it never scrolls; an
    // inline one fits its content.
    const rows = e.props.placement === 'dock' ? e.props.scroll.bodyRows : undefined
    return (
      <Box flexDirection="column" height={rows} justifyContent="space-between">
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {body}
        </Box>
        {now !== '' && (
          <Box marginTop={1} borderStyle="round" paddingX={1} flexDirection="column">
            <Markdown text={now} />
          </Box>
        )}
      </Box>
    )
  })
}

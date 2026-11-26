import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register, Timer } from 'claude-code'

import type { BoardEntry, TrackedAgent } from '../types'

const PANE = 'task-map'
const GLOBAL = 'taskmap.md'
const DIR = 'tasks'
const HUB = '.taskmap'
const SESS = `${HUB}/sessions`
const AGENTS = `${HUB}/agents`
const BOARD = `${HUB}/board`
const BOARD_KEEP = 200
const STATUS = ['✅', '🔵', '⬜', '⏳']
const POLL_MS = 3000
const IDLE_MS = 30 * 60_000
const GONE_MS = 24 * 60 * 60_000

const files = atom({ plugin: 'task-map', key: 'files' } as const, {}, { shape: 'files-1' })
const view = atom({ plugin: 'task-map', key: 'view' } as const, '', { shape: 'view-2' })
const agents = atom({ plugin: 'task-map', key: 'agents' } as const, {}, { shape: 'agents-2' })
const me = atom({ plugin: 'task-map', key: 'me' } as const, '', { shape: 'me-1' })
const seenAt = atom({ plugin: 'task-map', key: 'seen' } as const, { mark: 0, at: 0 }, { shape: 'seen-1' })
const reads = atom({ plugin: 'task-map', key: 'reads' } as const, {}, { shape: 'reads-1' })

const reminder = (sid: string) =>
  [
    'Task Map: taskmap.md is the main map, shared by every session in this folder.',
    '- "## Tasks": one line per task, "- ✅|🔵|⬜ name — needs: a, b | note"; 🔵 marks tasks in progress (several sessions may each have one).',
    '- tasks/<name>.md: the "- ✅|🔵|⬜ step" lines of that main task.',
    `You are session ${sid}. Your own file is ${SESS}/${sid}.md. Only you write it; other sessions and the pane read it:`,
    '  from: <the main task you work under, or empty>',
    '  label: <a few words on what this session does>',
    '  state: active | merged',
    '  ## Now — four lines: 📍 Where we are / ✅ How to check / 👉 Suggested next / 💡 Learned (optional)',
    '  ## Tasks — "- ✅|🔵|⬜ task" lines: this session\'s own tasks',
    'Update your file in the same turn a step finishes or the plan changes; put your Now there, not in taskmap.md.',
    'Separate: to work apart from the main plan, set "from:" to the main task and keep your own tasks in your file.',
    'Merge: when they are done, append them as steps to tasks/<from>.md and set "state: merged" (the user can also run /map merge).',
    'Edit taskmap.md and tasks/*.md in small edits right after reading them: another session may be editing too. Never edit another session\'s file.',
    'Subagents you start appear in the pane by themselves. The plan tool (mcp__task-map__plan) sets your own "## Tasks" in one call.',
    'Board: the board tool (mcp__task-map__board) posts short coordination notes every session and subagent sees ("claimed api", "api ready on /v2", "need: a fixture") and returns what is new since you last read. Read it when you start a turn while other sessions are active, and post when you claim, finish or need something. Use `to` for one session (its id) or subagent (<sid>/<key>).',
    'The pane shows your Now, so end chat replies with only "👉 next: <step>" rather than the full block.',
  ].join('\n')

const TEMPLATE = 'from: \nlabel: \nstate: active\n\n## Now\n\n## Tasks\n'

// ---------------------------------------------------------------- parsing

function findSection(lines: string[], re: RegExp) {
  const start = lines.findIndex(l => re.test(l.trim()))
  if (start < 0) return undefined
  let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l.trim()))
  if (end < 0) end = lines.length
  return { start, end }
}

// Pulls the "## Now" section out of a map, so it can be pinned at the bottom.
function extractNow(text: string) {
  const lines = text.split('\n')
  const s = findSection(lines, /^##\s+now\b/i)
  if (!s) return { now: '', rest: text }
  return {
    now: lines.slice(s.start + 1, s.end).join('\n').trim(),
    rest: [...lines.slice(0, s.start), ...lines.slice(s.end)].join('\n'),
  }
}

type Task = { name: string; status: string; needs: string[]; note: string }
type Step = { status: string; text: string }

// Splits taskmap.md into the part before "## Tasks", the task lines, and the rest.
function parse(text: string) {
  const lines = text.split('\n')
  const s = findSection(lines, /^##\s+tasks\b/i)
  if (!s) return { head: text, tasks: [] as Task[], tail: '' }
  const tasks: Task[] = []
  for (const line of lines.slice(s.start + 1, s.end)) {
    const m = line.match(/^\s*[-*]\s*(\S+)?\s+([A-Za-z0-9._-]+)\s*(?:[—–-]+\s*(.*))?$/)
    if (!m) continue
    const status = STATUS.includes(m[1] ?? '') ? (m[1] as string) : '⬜'
    const rest = m[3] ?? ''
    const needsMatch = rest.match(/needs:\s*([A-Za-z0-9._,\s-]+)/i)
    const needs = needsMatch
      ? (needsMatch[1] ?? '').split(',').map(x => x.trim()).filter(Boolean)
      : []
    const note = rest.replace(/needs:\s*[A-Za-z0-9._,\s-]+/i, '').replace(/^\s*[|·]\s*/, '').replace(/\s*[|·]\s*$/, '').trim()
    tasks.push({ name: m[2] ?? '', status, needs, note })
  }
  return {
    head: lines.slice(0, s.start).join('\n').trim(),
    tasks,
    tail: lines.slice(s.end).join('\n').trim(),
  }
}

// Step lines: "- ✅ text", with **bold** markers dropped.
function steps(text: string) {
  const out: Step[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*[-*]\s*(✅|🔵|⬜|⏳)\s*(.*)$/)
    if (m) out.push({ status: m[1] ?? '⬜', text: (m[2] ?? '').replace(/\*\*/g, '').trim() })
  }
  return out
}

function progress(list: Step[]) {
  const done = list.filter(s => s.status === '✅').length
  const cur = list.find(s => s.status === '🔵') ?? list.find(s => s.status !== '✅')
  return { done, total: list.length, cur }
}

function isBlocked(task: Task, all: Task[]) {
  if (task.status === '✅') return false
  return task.needs.some(n => all.find(t => t.name === n)?.status !== '✅')
}

// "from: api" style lines before a session file's first heading.
function meta(text: string) {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (/^#/.test(line.trim())) break
    const m = line.match(/^\s*(from|label|state)\s*:\s*(.*?)\s*$/i)
    if (m) out[(m[1] ?? '').toLowerCase()] = m[2] ?? ''
  }
  return out
}

function setMeta(text: string, key: string, value: string) {
  const lines = text.split('\n')
  const head = lines.findIndex(l => /^#/.test(l.trim()))
  const limit = head < 0 ? lines.length : head
  const re = new RegExp(`^\\s*${key}\\s*:`, 'i')
  const i = lines.findIndex((l, j) => j < limit && re.test(l))
  if (i >= 0) lines[i] = `${key}: ${value}`
  else lines.unshift(`${key}: ${value}`)
  return lines.join('\n')
}

// A session's own tasks: its "## Tasks" lines, or every step line outside "## Now".
function sessionTasks(text: string) {
  const { rest } = extractNow(text)
  const lines = rest.split('\n')
  const s = findSection(lines, /^##\s+tasks\b/i)
  return steps(s ? lines.slice(s.start + 1, s.end).join('\n') : rest)
}

function insertSteps(text: string, add: string[]) {
  if (add.length === 0) return text
  const lines = text.split('\n')
  const s = findSection(lines, /^##\s+steps\b/i)
  if (!s) return `${text.replace(/\s*$/, '')}\n\n## Steps\n${add.join('\n')}\n`
  let at = s.end
  while (at > s.start + 1 && (lines[at - 1] ?? '').trim() === '') at--
  lines.splice(at, 0, ...add)
  return lines.join('\n')
}

// Replaces the lines under "## Tasks" (adding the section when missing).
function replaceTasks(text: string, add: string[]) {
  const lines = text.split('\n')
  const s = findSection(lines, /^##\s+tasks\b/i)
  if (!s) return `${text.replace(/\s*$/, '')}\n\n## Tasks\n${add.join('\n')}\n`
  lines.splice(s.start + 1, s.end - s.start - 1, ...add, '')
  return lines.join('\n')
}

const PLAN_ICON: Record<string, string> = { done: '✅', doing: '🔵', todo: '⬜' }

type Session = {
  sid: string
  from: string
  label: string
  state: string
  now: string
  tasks: Step[]
  alive: boolean
  updated: number
  agents: TrackedAgent[]
}

function sessionsOf(all: Record<string, string>, mine: string, myAgents: TrackedAgent[], now: number) {
  const ids = new Set<string>()
  for (const p of Object.keys(all)) {
    const m = p.match(/^\.taskmap\/sessions\/([^/]+)\.(md|json)$/)
    if (m) ids.add(m[1] ?? '')
  }
  if (mine !== '') ids.add(mine)
  const out: Session[] = []
  for (const sid of ids) {
    const text = all[`${SESS}/${sid}.md`] ?? ''
    let live: { alive?: boolean; updated?: number; agents?: TrackedAgent[] } = {}
    try {
      live = JSON.parse(all[`${SESS}/${sid}.json`] ?? '{}')
    } catch {}
    const m = meta(text)
    const s: Session = {
      sid,
      from: m.from ?? '',
      label: m.label ?? '',
      state: (m.state ?? 'active').toLowerCase(),
      now: extractNow(text).now,
      tasks: sessionTasks(text),
      alive: sid === mine ? true : live.alive !== false && now - (live.updated ?? 0) < IDLE_MS,
      updated: sid === mine ? now : live.updated ?? 0,
      agents: sid === mine ? myAgents : live.agents ?? [],
    }
    const busy = s.agents.some(a => a.state === 'running')
    const hidden =
      sid !== mine &&
      (now - s.updated > GONE_MS || (!s.alive && (s.state === 'merged' || (s.tasks.length === 0 && !busy))))
    if (!hidden) out.push(s)
  }
  return out.sort((a, b) => (a.sid === mine ? -1 : b.sid === mine ? 1 : b.updated - a.updated))
}

function ago(ms: number) {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

// "Read auth.ts", "Bash npm test", "Grep TODO".
function summarize(tool: string, input: Record<string, unknown>) {
  const pick = ['file_path', 'path', 'command', 'pattern', 'url', 'description', 'prompt']
  for (const k of pick) {
    const v = input[k]
    if (typeof v === 'string' && v !== '') {
      const short = k.endsWith('path') ? (v.split('/').pop() ?? v) : v.split('\n')[0] ?? ''
      return `${tool} ${short.length > 40 ? `${short.slice(0, 39)}…` : short}`
    }
  }
  return tool
}

// ---------------------------------------------------------------- state on disk

let sid = ''
let cache: Record<string, string> = {}
let seen = new Map<string, number>()
let scanning = false
let mirror: Record<string, TrackedAgent> = {}
let flushTimer: Timer | undefined
let poll: Timer | undefined

async function mySid($: EngineInterface) {
  const id = (await $.session.id()).slice(0, 8)
  if (id !== sid) {
    sid = id
    await update($, me, () => id)
  }
  return id
}

// Re-reads the map files whose modification time changed, then redraws.
async function scan($: EngineInterface) {
  if (scanning) return
  scanning = true
  try {
    const found = new Map<string, number>()
    const top = await $.fs.stat(GLOBAL).catch(() => undefined)
    if (top?.kind === 'file') found.set(GLOBAL, top.mtimeMs)
    for (const dir of [DIR, SESS, AGENTS, BOARD]) {
      const entries: FsEntry[] = await $.fs.list(dir).catch(() => [])
      for (const one of entries) {
        const ok =
          dir === SESS ? /\.(md|json)$/.test(one.name) : dir === BOARD ? one.name.endsWith('.jsonl') : one.name.endsWith('.md')
        if (one.kind === 'file' && ok) found.set(`${dir}/${one.name}`, one.mtimeMs)
      }
    }
    let changed = found.size !== seen.size
    const fresh: Record<string, string> = {}
    for (const [p, t] of found) {
      const had = cache[p]
      if (seen.get(p) === t && had !== undefined) {
        fresh[p] = had
        continue
      }
      changed = true
      const body = await $.fs.read(p).catch(() => undefined)
      if (typeof body === 'string') fresh[p] = body
    }
    seen = found
    cache = fresh
    if (changed) await update($, files, () => fresh)
  } finally {
    scanning = false
  }
}

// Writes .taskmap/sessions/<sid>.json: whether this session is alive, and its subagents.
// Only in a folder that has a task map, so other projects stay untouched.
async function flush($: EngineInterface, alive = true) {
  if (!(await $.fs.exists(GLOBAL).catch(() => false))) return
  const id = await mySid($)
  const list = Object.values(mirror).sort((a, b) => a.started - b.started).slice(-20)
  const body = { sid: id, alive, updated: await $.clock.now(), agents: list }
  await $.fs.write(`${SESS}/${id}.json`, `${JSON.stringify(body, null, 1)}\n`)
  if (!(await $.fs.exists(`${HUB}/.gitignore`).catch(() => true))) await $.fs.write(`${HUB}/.gitignore`, '*\n')
}

function scheduleFlush($: EngineInterface) {
  if (flushTimer) return
  flushTimer = $.clock.after(1500, () => {
    flushTimer = undefined
    void flush($).catch(() => {})
  })
}

async function setAgent($: EngineInterface, match: (a: TrackedAgent) => boolean, fn: (a: TrackedAgent) => TrackedAgent) {
  await update($, agents, m => {
    const key = Object.keys(m).find(k => match(m[k] as TrackedAgent))
    const next = key === undefined ? m : { ...m, [key]: fn(m[key] as TrackedAgent) }
    mirror = next
    return next
  })
  scheduleFlush($)
}

async function editSession($: EngineInterface, id: string, fn: (text: string) => string) {
  const p = `${SESS}/${id}.md`
  const cur = await $.fs.read(p).catch(() => undefined)
  await $.fs.write(p, fn(typeof cur === 'string' ? cur : TEMPLATE))
}

// Every board file's lines, oldest first.
function boardOf(all: Record<string, string>) {
  const out: BoardEntry[] = []
  for (const [p, text] of Object.entries(all)) {
    if (!p.startsWith(`${BOARD}/`)) continue
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const b = JSON.parse(line) as Partial<BoardEntry>
        if (typeof b.t === 'number' && typeof b.text === 'string' && typeof b.from === 'string') {
          out.push({ t: b.t, from: b.from, to: b.to ?? '', kind: b.kind === 'event' ? 'event' : 'post', text: b.text })
        }
      } catch {}
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

// Appends to this session's own board file (one writer per file, so no races).
let posting: Promise<void> = Promise.resolve()
function post($: EngineInterface, entry: Omit<BoardEntry, 't'>) {
  const run = posting.then(async () => {
    if (!(await $.fs.exists(GLOBAL).catch(() => false))) return
    const id = await mySid($)
    const p = `${BOARD}/${id}.jsonl`
    const cur = await $.fs.read(p).catch(() => undefined)
    const lines = (typeof cur === 'string' ? cur : '').split('\n').filter(l => l.trim() !== '')
    const t = await $.clock.now()
    lines.push(JSON.stringify({ t, ...entry, text: entry.text.replace(/\s+/g, ' ').trim().slice(0, 300) }))
    await $.fs.write(p, `${lines.slice(-BOARD_KEEP).join('\n')}\n`)
    await scan($)
  })
  posting = run.catch(() => {})
  return run
}

// Folds a session's tasks into tasks/<from>.md as steps and marks it merged.
async function merge($: EngineInterface, id: string) {
  const p = `${SESS}/${id}.md`
  const text = await $.fs.read(p).catch(() => undefined)
  if (typeof text !== 'string') return `Session ${id} has no file (${p}) to merge.`
  const m = meta(text)
  const from = m.from ?? ''
  if (from === '') return `Session ${id} has no "from:" task. Run /map branch <task> first.`
  if ((m.state ?? '').toLowerCase() === 'merged') return `Session ${id} is already merged into ${from}.`
  const target = `${DIR}/${from}.md`
  const cur = await $.fs.read(target).catch(() => undefined)
  const local = typeof cur === 'string' ? cur : '## Steps\n'
  const tag = m.label || id
  const add = sessionTasks(text)
    .map(t => `- ${t.status} ${t.text} (⑂ ${tag})`)
    .filter(l => !local.includes(l))
  await $.fs.write(target, insertSteps(local, add))
  await $.fs.write(p, setMeta(text, 'state', 'merged'))
  await scan($)
  await post($, { from: id, to: '', kind: 'event', text: `merged ${add.length} step(s) into ${from}` }).catch(() => {})
  return `Merged ${add.length} step(s) from session ${tag} into ${target}.`
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'map',
      description: 'Task Map: open the pane, or branch / merge / label this session',
      argumentHint: '[branch <task> [label] | merge [session] | label <text>]',
    })
    await mySid($)
    await $.tool
      .register({
        name: 'board',
        description:
          'Task Map board, shared by every Claude session and subagent in this folder. Post a short coordination note (claimed / done / need / found) and get back what others posted since you last read. Call with no `post` just to read.',
        inputSchema: {
          type: 'object',
          properties: {
            post: { type: 'string', description: 'One line to post; leave out to only read.' },
            to: { type: 'string', description: 'A session id or <sid>/<agent key> to address; leave out for everyone.' },
          },
        },
        isDeferred: false,
      })
      .catch(() => {})
    await $.tool
      .register({
        name: 'plan',
        description:
          'Task Map: set your task list, shown live in the pane beside the chat. Send the whole list each time; call it when you start and whenever a step changes status. A subagent sets its own list; the main session sets its "## Tasks".',
        inputSchema: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  status: { type: 'string', enum: ['todo', 'doing', 'done'] },
                },
                required: ['text', 'status'],
              },
            },
          },
          required: ['steps'],
        },
        isDeferred: false,
      })
      .catch(() => {})
    await update($, agents, m => {
      mirror = m
      return m
    })
    await scan($)
    poll?.cancel()
    poll = $.clock.every(POLL_MS, () => void scan($).catch(() => {}))
    void flush($).catch(() => {})
    void $.ui.open({ id: PANE, title: 'Task Map' })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    poll?.cancel()
    flushTimer?.cancel()
    flushTimer = undefined
    await flush($, false).catch(() => {})
    return next(e)
  })

  // Tells the model every turn which session file is its own and how the maps work.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const id = await mySid($)
    return {
      ...result,
      sections: [...result.sections, { id: 'task-map:maintain', text: reminder(id), scope: 'session' as const }],
    }
  })

  on('command.run', { command: 'map' }, async ($, e) => {
    const [sub, ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const id = await mySid($)
    if (sub === 'branch') {
      const task = rest[0] ?? ''
      if (task === '') return { text: 'Usage: /map branch <main task> [label]' }
      const label = rest.slice(1).join(' ')
      await editSession($, id, t => {
        let out = setMeta(setMeta(t, 'from', task), 'state', 'active')
        if (label !== '') out = setMeta(out, 'label', label)
        return out
      })
      await scan($)
      await post($, { from: id, to: '', kind: 'event', text: `works under ${task}${label !== '' ? ` as "${label}"` : ''}` }).catch(() => {})
      const known = parse(cache[GLOBAL] ?? '').tasks.some(t => t.name === task)
      return {
        text: `Session ${id} now works under "${task}"${known ? '' : ' (not in taskmap.md yet)'}. Its tasks live in ${SESS}/${id}.md.`,
      }
    }
    void flush($).catch(() => {})
    if (sub === 'merge') return { text: await merge($, rest[0] ?? id) }
    if (sub === 'label') {
      const label = rest.join(' ')
      await editSession($, id, t => setMeta(t, 'label', label))
      await scan($)
      return { text: `Session ${id} is labelled "${label}".` }
    }
    await scan($)
    await $.ui.open({ id: PANE, title: 'Task Map' })
    return { text: 'Task Map opened.' }
  })

  // Subagents: ask each to keep its steps in a file, and track it from spawn to end.
  on('agent.spawn', async ($, e, next) => {
    if (!(await $.fs.exists(GLOBAL).catch(() => false))) return next(e)
    const id = await mySid($)
    const now = await $.clock.now()
    const key = (e.tool_use_id || `w${now}`).slice(-6)
    const file = `${AGENTS}/${id}-${key}.md`
    const note = `\n\n---\nTask Map: you are ${id}/${key}, and the person watches your task list in a pane. If the plan tool (mcp__task-map__plan) is available, call it first with your steps (status todo/doing/done) and again each time one changes. Otherwise, if you can write files, keep the same list in ${file} as "- ✅|🔵|⬜ step" lines. If the board tool (mcp__task-map__board) is available, post one line there when you find something other agents need. Don't edit any other Task Map file.`
    const agent: TrackedAgent = {
      key,
      id: '',
      desc: e.description,
      type: e.subagentType,
      state: 'running',
      tools: 0,
      last: '',
      recent: [],
      report: '',
      started: now,
      ended: 0,
    }
    await update($, agents, m => {
      const kept = Object.values(m).sort((a, b) => b.started - a.started).slice(0, 19)
      const nextMap: Record<string, TrackedAgent> = { [key]: agent }
      for (const a of kept) nextMap[a.key] = a
      mirror = nextMap
      return nextMap
    })
    const res = await next({ ...e, prompt: e.prompt + note })
    const agentId = res.agentId
    if (res.deny === undefined) void post($, { from: `${id}/${key}`, to: '', kind: 'event', text: `started: ${e.description}` }).catch(() => {})
    if (res.deny !== undefined) await setAgent($, a => a.key === key, a => ({ ...a, state: 'stopped', ended: now }))
    else if (agentId !== undefined) await setAgent($, a => a.key === key, a => ({ ...a, id: agentId }))
    return res
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined && Object.values(mirror).some(a => a.id === id)) {
      await setAgent($, a => a.id === id, a => ({ ...a, state: 'running', ended: 0 }))
    }
    return next(e)
  })

  // The plan tool: a subagent's whole task list, or the main session's "## Tasks".
  on('tool.call', { tool: /^mcp__task-map__plan$/ }, async ($, e) => {
    if (!(await $.fs.exists(GLOBAL).catch(() => false))) return { result: 'There is no taskmap.md in this folder, so nothing was saved.' }
    const input = e as unknown as { steps?: unknown; agentId?: string }
    const list: unknown[] = Array.isArray(input.steps) ? input.steps : []
    const lines = list
      .flatMap(x => {
        if (typeof x !== 'object' || x === null) return []
        const o = x as { text?: unknown; status?: unknown }
        const text = String(o.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
        return text === '' ? [] : [`- ${PLAN_ICON[String(o.status)] ?? '⬜'} ${text}`]
      })
      .slice(0, 30)
    const id = await mySid($)
    const agentId = input.agentId
    if (agentId === undefined) await editSession($, id, t => replaceTasks(t, lines))
    else {
      const key = Object.values(mirror).find(a => a.id === agentId)?.key ?? agentId.slice(-6)
      await $.fs.write(`${AGENTS}/${id}-${key}.md`, `## Steps\n${lines.join('\n')}\n`)
    }
    await scan($)
    return { result: `Task list saved (${lines.length} step${lines.length === 1 ? '' : 's'}). Call again when a step changes.` }
  }).catch(() => ({ result: 'The task list could not be saved just now.' }))

  // The board tool: post a line, then hand back what is new for this reader.
  on('tool.call', { tool: /^mcp__task-map__board$/ }, async ($, e) => {
    const input = e as unknown as { post?: unknown; to?: unknown; agentId?: string }
    const id = await mySid($)
    const agent = input.agentId === undefined ? undefined : Object.values(mirror).find(a => a.id === input.agentId)
    const reader = agent ? `${id}/${agent.key}` : id
    const text = typeof input.post === 'string' ? input.post.trim() : ''
    const to = typeof input.to === 'string' ? input.to.trim() : ''
    if (text !== '') await post($, { from: reader, to, kind: 'post', text })
    else await scan($)
    let last = 0
    const now = await $.clock.now()
    await update($, reads, m => {
      last = m[reader] ?? 0
      return { ...m, [reader]: now }
    })
    const fresh = boardOf(cache).filter(b => b.t > last && b.from !== reader && (b.to === '' || b.to === reader || b.to === id))
    const lines = fresh.slice(-30).map(b => `- ${ago(now - b.t)} ${b.from}${b.to !== '' ? ` → ${b.to}` : ''}: ${b.text}`)
    const head = text !== '' ? `Posted as ${reader}.` : `You are ${reader}.`
    return { result: lines.length > 0 ? `${head}\nNew on the board:\n${lines.join('\n')}` : `${head} Nothing new on the board.` }
  }).catch(() => ({ result: 'The board could not be read just now.' }))

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined && Object.values(mirror).some(a => a.id === id)) {
      const last = summarize(e.tool, e as unknown as Record<string, unknown>)
      await setAgent($, a => a.id === id, a => ({ ...a, tools: a.tools + 1, last, recent: [...(a.recent ?? []), last].slice(-8) }))
    }
    const ran = await next(e)
    if (['Write', 'Edit', 'NotebookEdit', 'Bash'].includes(e.tool)) await scan($).catch(() => {})
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const id = e.agentId
    if (id !== undefined) {
      if (Object.values(mirror).some(a => a.id === id)) {
        const ended = await $.clock.now()
        const state = e.isAborted ? 'stopped' : 'done'
        const report = e.answer.trim().slice(0, 600)
        await setAgent($, a => a.id === id, a => ({ ...a, state, ended, report }))
        const a = Object.values(mirror).find(x => x.id === id)
        if (a) {
          const first = (e.answer.split('\n').find(l => l.trim() !== '') ?? '').replace(/[#*`]/g, '').trim()
          const sid8 = await mySid($)
          const text = `${state === 'done' ? 'finished' : 'stopped'}: ${a.desc}${first !== '' ? ` — ${first.slice(0, 120)}` : ''}`
          await post($, { from: `${sid8}/${a.key}`, to: '', kind: 'event', text }).catch(() => {})
        }
      }
      return done
    }
    await scan($).catch(() => {})
    await flush($).catch(() => {})
    return done
  })

  // ---------------------------------------------------------------- the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const all = await read($, files)
    const open = await read($, view)
    const mine = await read($, me)
    const myAgents = Object.values(await read($, agents)).sort((a, b) => a.started - b.started)
    const now = await $.clock.now()
    const top = all[GLOBAL]
    const sessions = sessionsOf(all, mine, myAgents, now)
    const self = sessions.find(s => s.sid === mine)
    const nowText = self?.now || (top === undefined ? '' : extractNow(top).now)
    const go = (v: string) => () => update($, view, () => v)
    const seen = await read($, seenAt)
    const board = boardOf(all)
    const mineFrom = (f: string) => f === mine || f.startsWith(`${mine}/`)
    const unread = board.filter(b => b.kind === 'post' && b.t > seen.at && !mineFrom(b.from)).length
    const openSwarm = async () => {
      const t = await $.clock.now()
      await update($, seenAt, v => ({ mark: v.at, at: t }))
      await update($, view, () => 'swarm')
    }
    // 'you', 'c3d4e5f6', 'you/Explore', 'c3d4e5f6/Plan'
    const name = (f: string) => {
      const [sid8 = '', key] = f.split('/')
      const head = sid8 === mine ? 'you' : sid8
      if (key === undefined) return head
      const type = sessions.find(x => x.sid === sid8)?.agents.find(a => a.key === key)?.type
      return `${head}/${type ?? key}`
    }

    const who = (s: Session) => `${s.sid === mine ? 'you' : s.sid}${s.label !== '' ? ` "${s.label}"` : ''}`
    const branchText = (s: Session) => {
      const p = progress(s.tasks)
      const parts = [`⑂ ${who(s)}`]
      if (s.state === 'merged') parts.push('merged')
      else {
        if (p.total > 0) parts.push(`${p.done}/${p.total}`)
        if (p.cur) parts.push(`${p.cur.status} ${p.cur.text}`)
      }
      if (s.sid !== mine) parts.push(s.alive ? ago(now - s.updated) : 'ended')
      const running = s.agents.filter(a => a.state === 'running').length
      if (s.sid !== mine && running > 0) parts.push(`⟳ ${running} agent${running > 1 ? 's' : ''}`)
      return parts.join(' · ')
    }
    const agentIcon = (a: TrackedAgent) => (a.state === 'running' ? '⟳' : a.state === 'done' ? '✓' : '■')
    const agentRows = (s: Session, indent: string, full: boolean) => {
      const shown = full ? s.agents : s.sid === mine ? s.agents.slice(-4) : s.agents.filter(a => a.state === 'running')
      return shown.map((a, i) => {
        const icon = agentIcon(a)
        const own = all[`${AGENTS}/${s.sid}-${a.key}.md`]
        const p = own === undefined ? undefined : progress(steps(own))
        const bits = [`${icon} ${a.type}`, a.desc]
        if (p && p.total > 0) bits.push(`${p.done}/${p.total}${p.cur ? ` ${p.cur.status} ${p.cur.text}` : ''}`)
        if (a.state === 'running') {
          bits.push(`${a.tools} tool${a.tools === 1 ? '' : 's'}`)
          if (a.last !== '') bits.push(a.last)
        } else if (a.ended > 0) bits.push(ago(now - a.ended))
        if (full) {
          return (
            <Button
              key={`agent:${s.sid}:${a.key}`}
              hotkey={i < 9 ? String(i + 1) : undefined}
              plain
              dimColor={a.state !== 'running'}
              onPress={go(`agent:${s.sid}/${a.key}`)}
            >
              {indent}
              {bits.join(' · ')}
              <Text dimColor>  ›</Text>
            </Button>
          )
        }
        return (
          <Text key={`agent:${s.sid}:${a.key}`} dimColor={a.state !== 'running'}>
            {indent}
            {bits.join(' · ')}
          </Text>
        )
      })
    }
    const sessionBlock = (s: Session, indent: string) => (
      <Box key={`sess:${s.sid}`} flexDirection="column">
        <Text dimColor={s.state === 'merged' || !s.alive} bold={s.sid === mine}>
          {indent}
          {branchText(s)}
        </Text>
        {agentRows(s, `${indent}  `, false)}
      </Box>
    )

    const body = (() => {
      if (top === undefined) {
        return (
          <Box flexDirection="column">
            <Text dimColor>No taskmap.md in this folder yet.</Text>
            <Text dimColor>Ask Claude to start a task map.</Text>
            {myAgents.length > 0 && self && sessionBlock(self, '')}
          </Box>
        )
      }

      const { rest } = extractNow(top)
      const { head, tasks, tail } = parse(rest)
      const others = sessions.filter(s => s.sid !== mine).length
      const toggles = (
        <Box key="toggles" flexDirection="row" gap={2}>
          <Button key="toggle" hotkey="o" plain dimColor onPress={go(open === '' ? 'list' : '')}>
            {open === '' ? 'Task list' : 'Overview'}
          </Button>
          <Button key="swarm" hotkey="s" plain dimColor onPress={openSwarm}>
            {`Swarm (${sessions.length})${unread > 0 ? ` 💬${unread}` : ''}`}
          </Button>
        </Box>
      )
      const mark = (task: Task) => (isBlocked(task, tasks) ? '⏳' : task.status)

      if (open.startsWith('task:')) {
        const name = open.slice(5)
        const task = tasks.find(t => t.name === name)
        const local = all[`${DIR}/${name}.md`]
        const deps = task?.needs ?? []
        const attached = sessions.filter(s => s.from === name)
        return (
          <Box flexDirection="column">
            <Button key="back" hotkey="b" plain onPress={go('')}>
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
            {attached.map(s => (
              <Box key={`att:${s.sid}`} flexDirection="column">
                {sessionBlock(s, '')}
                {s.state !== 'merged' &&
                  s.tasks.map((t, i) => (
                    <Text key={`st:${s.sid}:${i}`} dimColor={t.status === '✅'}>
                      {'    '}
                      {t.status} {t.text}
                    </Text>
                  ))}
              </Box>
            ))}
          </Box>
        )
      }

      if (open.startsWith('sess:')) {
        const s = sessions.find(x => x.sid === open.slice(5))
        if (!s) {
          return (
            <Box flexDirection="column">
              <Button key="back" hotkey="b" plain onPress={openSwarm}>
                Back to swarm
              </Button>
              <Text dimColor>That session is gone.</Text>
            </Box>
          )
        }
        return (
          <Box flexDirection="column">
            <Button key="back" hotkey="b" plain onPress={openSwarm}>
              Back to swarm
            </Button>
            <Text bold>{branchText(s)}</Text>
            {s.from !== '' && <Text dimColor>under main task: {s.from}</Text>}
            {s.sid !== mine && s.now !== '' && (
              <Box borderStyle="round" paddingX={1} flexDirection="column">
                <Markdown text={s.now} />
              </Box>
            )}
            {s.tasks.length === 0 && <Text dimColor>No session tasks.</Text>}
            {s.tasks.map((t, i) => (
              <Text key={`st:${i}`} dimColor={t.status === '✅'}>
                {t.status} {t.text}
              </Text>
            ))}
            {s.agents.length > 0 && <Text bold>Subagents</Text>}
            {agentRows(s, '', true)}
          </Box>
        )
      }

      // One subagent's page: its task list, what it just did, its report and posts.
      if (open.startsWith('agent:')) {
        const [sid8 = '', key = ''] = open.slice(6).split('/')
        const s = sessions.find(x => x.sid === sid8)
        const a = s?.agents.find(x => x.key === key)
        const back = (
          <Button key="back" hotkey="b" plain dimColor onPress={go(s ? `sess:${sid8}` : 'swarm')}>
            {s ? 'Back to session' : 'Back to swarm'}
          </Button>
        )
        if (!s || !a) {
          return (
            <Box flexDirection="column">
              {back}
              <Text dimColor>That subagent is no longer listed.</Text>
            </Box>
          )
        }
        const own = all[`${AGENTS}/${sid8}-${key}.md`]
        const list = own === undefined ? [] : steps(own)
        const p = progress(list)
        const recent = a.recent ?? []
        const posts = board.filter(b => b.from === `${sid8}/${key}` && b.kind === 'post').slice(-5)
        const status =
          a.state === 'running' ? `running for ${ago(now - a.started).replace(' ago', '')}` : `${a.state} ${ago(now - a.ended)}`
        return (
          <Box flexDirection="column">
            {back}
            <Text bold>
              {agentIcon(a)} {a.type} · {a.desc}
            </Text>
            <Text dimColor>
              {status} · {a.tools} tool call{a.tools === 1 ? '' : 's'} · started by {who(s)}
            </Text>
            <Text bold>
              {'Task list'}
              <Text dimColor>{p.total > 0 ? `  ${p.done}/${p.total}` : ''}</Text>
            </Text>
            {list.length === 0 && (
              <Text dimColor>No task list yet: it appears once the agent calls the plan tool.</Text>
            )}
            {list.map((st, i) => (
              <Text key={`step:${i}`} dimColor={st.status === '✅'} bold={st.status === '🔵'}>
                {'  '}
                {st.status} {st.text}
              </Text>
            ))}
            {recent.length > 0 && <Text bold>Recent tool calls</Text>}
            {recent.slice(-6).map((r, i, arr) => (
              <Text key={`recent:${i}`} dimColor={i < arr.length - 1 || a.state !== 'running'}>
                {'  '}
                {i === arr.length - 1 && a.state === 'running' ? '⟳ ' : '· '}
                {r}
              </Text>
            ))}
            {posts.length > 0 && <Text bold>On the board</Text>}
            {posts.map((b, i) => (
              <Text key={`apost:${i}`}>
                {'  '}
                <Text dimColor>{`${ago(now - b.t)}  `}</Text>
                {b.to !== '' ? `→ ${name(b.to)}  ` : ''}
                {b.text}
              </Text>
            ))}
            {(a.report ?? '') !== '' && <Text bold>Report</Text>}
            {(a.report ?? '') !== '' && <Markdown text={a.report} />}
          </Box>
        )
      }

      // Swarm: who is working (sessions, then their subagents as a tree), then the board.
      if (open === 'swarm') {
        const allAgents = sessions.flatMap(x => x.agents)
        const running = allAgents.filter(a => a.state === 'running').length
        const shown = board.slice(-14)
        const cut = shown.findIndex(b => b.t > seen.mark && !mineFrom(b.from))
        const divider = cut > 0 && seen.mark > 0 ? cut : -1
        return (
          <Box flexDirection="column">
            <Button key="back" hotkey="b" plain dimColor onPress={go('')}>
              Back to overview
            </Button>
            <Text bold>
              ◆ Swarm
              <Text dimColor>
                {`  ${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${allAgents.length} agent${allAgents.length === 1 ? '' : 's'}${running > 0 ? `, ${running} running` : ''}`}
              </Text>
            </Text>
            {sessions.map((x, i) => {
              const p = progress(x.tasks)
              const crew = x.sid === mine ? x.agents.slice(-5) : x.agents.filter(a => a.state === 'running')
              const bits = [`${x.alive ? '◉' : '○'} ${who(x)}`]
              if (x.from !== '') bits.push(`⊂ ${x.from}`)
              if (x.state === 'merged') bits.push('merged')
              else if (p.cur) bits.push(`${p.done}/${p.total} ${p.cur.status} ${p.cur.text}`)
              if (x.sid !== mine) bits.push(x.alive ? ago(now - x.updated) : 'ended')
              return (
                <Box key={`crew:${x.sid}`} flexDirection="column">
                  <Button
                    key={`open:${x.sid}`}
                    hotkey={i < 9 ? String(i + 1) : undefined}
                    plain
                    dimColor={x.state === 'merged' || !x.alive}
                    onPress={go(`sess:${x.sid}`)}
                  >
                    <Text bold={x.sid === mine}>{bits.join(' · ')}</Text>
                  </Button>
                  {crew.map((a, j) => {
                    const icon = agentIcon(a)
                    const own = all[`${AGENTS}/${x.sid}-${a.key}.md`]
                    const ap = own === undefined ? undefined : progress(steps(own))
                    const doing =
                      a.state === 'running'
                        ? [ap?.cur ? `${ap.done}/${ap.total} ${ap.cur.text}` : '', a.last, `${a.tools} tool${a.tools === 1 ? '' : 's'}`].filter(Boolean).join(' · ')
                        : ago(now - a.ended)
                    return (
                      <Button
                        key={`crew:${x.sid}:${a.key}`}
                        plain
                        dimColor={a.state !== 'running'}
                        onPress={go(`agent:${x.sid}/${a.key}`)}
                      >
                        {j === crew.length - 1 ? ' └─ ' : ' ├─ '}
                        {icon} {a.type} · {a.desc}
                        <Text dimColor>{doing !== '' ? `  ${doing}` : ''}</Text>
                      </Button>
                    )
                  })}
                </Box>
              )
            })}
            <Text bold>
              {'── Board '}
              <Text dimColor>{board.length === 0 ? '── nothing posted yet' : `── ${board.length} post${board.length === 1 ? '' : 's'}`}</Text>
            </Text>
            {shown.map((b, i) => (
              <Box key={`post:${b.t}:${b.from}:${i}`} flexDirection="column">
                {i === divider && <Text color="cyan">── new ──</Text>}
                <Text dimColor={b.kind === 'event'} bold={b.to !== '' && mineFrom(b.to)}>
                  <Text dimColor>{`${ago(now - b.t).replace(' ago', '').padStart(4)}  `}</Text>
                  {name(b.from)}
                  {b.to !== '' ? ` → ${name(b.to)}` : ''}
                  {'  '}
                  {b.text}
                </Text>
              </Box>
            ))}
            {others === 0 && <Text dimColor>Open another Claude session in this folder to see it here.</Text>}
          </Box>
        )
      }

      if (open === 'list') {
        return (
          <Box flexDirection="column">
            {toggles}
            {head !== '' && <Markdown text={head} />}
            <Text bold>Tasks</Text>
            {tasks.length === 0 && <Text dimColor>No tasks under "## Tasks" yet.</Text>}
            {tasks.map((task, i) => (
              <Button
                key={`task:${task.name}`}
                hotkey={i < 9 ? String(i + 1) : undefined}
                plain
                dimColor={task.status === '✅'}
                onPress={go(`task:${task.name}`)}
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

      // Overview: the tree; each task's steps, then the sessions working under it.
      const goal = head.split('\n').map(l => l.trim()).find(l => l !== '' && !l.startsWith('#')) ?? 'Goal'
      const doneCount = tasks.filter(t => t.status === '✅').length
      const names = new Set(tasks.map(t => t.name))
      const loose = sessions.filter(
        s => (s.from === '' || !names.has(s.from)) && (s.tasks.length > 0 || s.agents.length > 0),
      )
      return (
        <Box flexDirection="column">
          {toggles}
          <Text bold>
            🎯 {goal}
            <Text dimColor>{tasks.length > 0 ? `  ${doneCount}/${tasks.length}` : ''}</Text>
          </Text>
          {tasks.length === 0 && <Text dimColor>No tasks under "## Tasks" yet.</Text>}
          {tasks.map((task, i) => {
            const last = i === tasks.length - 1
            const indent = last ? '     ' : '│    '
            const local = all[`${DIR}/${task.name}.md`]
            const list = task.status !== '✅' && local !== undefined ? steps(local) : []
            const attached = sessions.filter(s => s.from === task.name && (s.state !== 'merged' || task.status !== '✅'))
            return (
              <Box key={`row:${task.name}`} flexDirection="column">
                <Button
                  key={`tree:${task.name}`}
                  hotkey={i < 9 ? String(i + 1) : undefined}
                  plain
                  dimColor={task.status === '✅'}
                  onPress={go(`task:${task.name}`)}
                >
                  {last ? '└─ ' : '├─ '}
                  {mark(task)} {task.name}
                  <Text dimColor>{task.needs.length > 0 ? `  ← ${task.needs.join(', ')}` : ''}</Text>
                  <Text bold>{task.status === '🔵' ? '  ← now' : ''}</Text>
                </Button>
                {list.length > 0 && (
                  <Text dimColor>
                    {indent}
                    {list.map(st => `${st.status} ${st.text}`).join(' · ')}
                  </Text>
                )}
                {attached.map(s => sessionBlock(s, indent))}
              </Box>
            )
          })}
          {loose.length > 0 && <Text dimColor>Sessions not under a task</Text>}
          {loose.map(s => sessionBlock(s, ''))}
        </Box>
      )
    })()

    // Tasks fill the column from the top; this session's Now sits at its bottom.
    // A docked pane is exactly its body's rows tall, so it never scrolls; an
    // inline one fits its content.
    const rows = e.props.placement === 'dock' ? e.props.scroll.bodyRows : undefined
    return (
      <Box flexDirection="column" height={rows} justifyContent="space-between">
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {body}
        </Box>
        {nowText !== '' && (
          <Box marginTop={1} borderStyle="round" paddingX={1} flexDirection="column">
            <Markdown text={nowText} />
          </Box>
        )}
      </Box>
    )
  })
}

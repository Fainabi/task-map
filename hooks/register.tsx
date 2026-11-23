import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

const PANE = 'task-map'
const FILE = 'taskmap.md'
const EMPTY = `_No \`${FILE}\` yet in this folder._\n\nAsk Claude to start a task map.`

const text = atom({ plugin: 'task-map', key: 'text' } as const, EMPTY, {
  shape: 'text-1',
})

async function refresh($: Engine) {
  const body = await $.fs.read(FILE).catch(() => EMPTY)
  await update($, text, () => (typeof body === 'string' ? body : EMPTY))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'map',
      description: 'Open the Task Map pane (shows taskmap.md)',
    })
    await refresh($)
    void $.ui.open({ id: PANE, title: 'Task Map' })
    return next(e)
  })

  on('command.run', { command: 'map' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Task Map' })
    return { text: 'Task Map opened.' }
  })

  // Redraw whenever Claude writes or edits the map, and at every turn's end.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.tool === 'Write' || e.tool === 'Edit') {
      if (String(e.file_path).endsWith(FILE)) await refresh($).catch(() => {})
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Markdown } = $.ui.resolve(e)
    const body = await read($, text)
    return (
      <Box flexDirection="column">
        <Markdown text={body} />
      </Box>
    )
  })
}

## Design
- `taskmap.md` + `tasks/*.md`: the **main map**, shared by all sessions.
- `.taskmap/sessions/<sid>.md`: one per session, written only by that session's model:
  `from: <main task>`, `label:`, `state: active|merged`, `## Now`, `## Tasks`.
- `.taskmap/sessions/<sid>.json`: written only by the mod: alive, last update, subagents.
- `.taskmap/agents/<sid>-<key>.md`: a subagent's own steps (it's asked to keep them).
- Separate = set `from:`; merge = `/map merge` (or the model) appends the session's
  tasks to `tasks/<from>.md` as steps and sets `state: merged`.

## Steps
- ✅ Pick the file layout
- ✅ Session file parse + Now from own file
- ✅ /map branch, /map merge, /map label
- ✅ Overview: branches under their main task, other sessions, subagents
- ✅ Sessions view (s)
- ✅ Tests: subagent row, other session under task, merge, branch

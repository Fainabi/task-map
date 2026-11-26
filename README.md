# task-map

A Claude Code mod that keeps a **Task Map** pane beside the chat, so you always see where you are, overall and inside each task.

It has four views:

- **Overview** (the default): the goal, then every task as a tree, with the steps of each unfinished task under it. The current task is marked `← now`, and a task waiting on unfinished work shows ⏳.
- **Task list**: one line per task, with its dependencies and a note. Press `o` to switch between Overview and this list.
- **Local map**: press `1`–`9` (or click a task) to open that task's own map, then `b` to go back.
- **Swarm**: press `s` for everyone working in this folder: each session and, under it, its subagents with what they are doing right now, then the shared **board**. `1`–`9` opens a session.

At the bottom of the pane, a boxed **Now** status shows where you are, how to check it, the suggested next step and what you learned. It comes from the `## Now` section of this session's own file (or of `taskmap.md` until the session has one).

Every turn, the mod also adds a short note to Claude's instructions, asking it to keep the maps and the Now block current. You don't have to remind it.

Give the pane focus first with ctrl+x tab or a click. `/map` opens the pane again if you close it, or if your terminal is too narrow for it to open by itself. The pane redraws after each edit to the map files and at the end of every turn.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install task-map --marketplace Fainabi/task-map
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install task-map --marketplace Fainabi/task-map
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `Fainabi/task-map`, then Add plugin.

## The map files

The global map is `taskmap.md` in your project's folder. Tasks go under `## Tasks`, one per line: a status (✅ done, 🔵 now, ⬜ to do), a name, then optionally `needs:` and a note after `|`.

```markdown
## Now
📍 **Where we are:** The form is done; wiring the API
✅ **How to check:** Submit the form and watch the network tab
👉 **Suggested next:** Handle errors
💡 **Learned:** Keep each step small

# 🎯 Goal
Ship the login page.

## Tasks
- ✅ form — the login form
- 🔵 api — needs: form | wire up the backend
- ⬜ tests — needs: api

## Shape
form ──▶ api ──▶ tests
```

Each task can have a local map at `tasks/<name>.md`. Its `- ✅ / 🔵 / ⬜` lines are the steps shown in the Overview:

```markdown
## Steps
- ✅ Pick the endpoint
- 🔵 Call it from the form
- ⬜ Handle errors
```

## Several sessions and subagents

Every session open in the same folder shares `taskmap.md` and `tasks/`: that is the **main map**. Each session also keeps a file of its own, `.taskmap/sessions/<session>.md`, which only it writes and every other session reads:

```markdown
from: api
label: retry logic
state: active

## Now
📍 **Where we are:** Backoff done; adding retry on 503
👉 **Suggested next:** Test against the staging API

## Tasks
- ✅ backoff
- 🔵 retry on 503
```

- **Separate**: `from:` names the main task the session works under. Its own tasks then show under that task in the Overview, as `⑂ <session> "label" · 1/2 · 🔵 retry on 503`, with how long ago it was active. A session with no `from:` is listed under "Sessions not under a task".
- **Merge**: when its tasks are done, the session appends them as steps to `tasks/<from>.md`, each tagged `(⑂ label)`, and sets `state: merged`.

Claude keeps the session file up to date by itself; these commands do the same by hand:

| Command | What it does |
| --- | --- |
| `/map branch <task> [label]` | Work under main task `<task>` from now on |
| `/map label <text>` | Name this session |
| `/map merge [session]` | Fold this session's tasks (or an ended session's) into its main task |

**Each subagent has its own page.** Click a subagent in the Swarm view, or open a session (`1`–`9`) and press the subagent's number. The page shows its task list, its last few tool calls, its board posts and, once it's done, its report. Subagents set their task list with the `plan` tool (`mcp__task-map__plan`), which works for read-only agents such as Explore too. The main session can call it to set its own `## Tasks`.

**Subagents** that a session starts are tracked by the mod: their type, task, how many tool calls they made and the last one (`⟳ Explore · find auth · 12 tools · Read auth.ts`), then `✓` when they finish. Each subagent is also asked to keep its steps in `.taskmap/agents/<session>-<agent>.md`, and its progress shows on its row. Other sessions see your running subagents too.

### The board

The board is a feed every session and subagent in the folder shares, shown at the bottom of the Swarm view:

```
── Board ── 4 posts
  5m  c3d4e5f6        claimed form
  1m  c3d4e5f6/Plan   started: audit colors
── new ──
 now  c3d4e5f6 → you  form posts to /v2/login, is that final?
 now  you/Explore     finished: find auth code — it lives in src/auth.ts
```

- The mod posts when a subagent starts and finishes (with the first line of its report), and when a session branches or merges.
- Claude posts with the `board` tool (`mcp__task-map__board`): "claimed api", "api ready on /v2", "need: a fixture", optionally `to` one session or subagent. The same call hands back what others posted since that caller last read, so sessions actually coordinate. Read-only subagents such as Explore can post too, since it is a tool and not a file write.
- New posts since you last opened the Swarm view show as `💬3` on its button and below a `── new ──` line.
- Each session writes only its own `.taskmap/board/<session>.jsonl` (the last 200 lines), so posts never collide.

The pane re-reads the map files every 3 seconds, so changes from other sessions show up while you work. `.taskmap/` holds a `.gitignore` that keeps it out of git. A session that has been quiet for 30 minutes shows as ended, and is hidden once it is merged, has no tasks, or is a day old. Nothing is written to `.taskmap/` in a folder without a `taskmap.md`.

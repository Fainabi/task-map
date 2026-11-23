# task-map

A Claude Code mod that keeps a **Task Map** pane beside the chat, so you always see where you are, overall and inside each task.

It has three views:

- **Overview** (the default): the goal, then every task as a tree, with the steps of each unfinished task under it. The current task is marked `← now`, and a task waiting on unfinished work shows ⏳.
- **Task list**: one line per task, with its dependencies and a note. Press `o` to switch between Overview and this list.
- **Local map**: press `1`–`9` (or click a task) to open that task's own map, then `b` to go back.

At the bottom of the pane, a boxed **Now** status shows where you are, how to check it, the suggested next step and what you learned. It comes from the `## Now` section of `taskmap.md`.

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

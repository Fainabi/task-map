# task-map

A Claude Code mod that keeps a **Task Map** pane beside the chat, so you always see where you are: the goal, the steps (done / now / next) and a small shape diagram.

The pane shows `taskmap.md` from your project's folder. Claude (or you) edits that file, and the pane redraws after each edit and at the end of every turn. Run `/map` to open the pane again if you close it, or if your terminal is too narrow for it to open by itself.

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

## Example taskmap.md

```markdown
# 🎯 Goal
Ship the login page.

## Steps
- ✅ Planned the form
- 🔵 **Now:** Wire up the API
- ⬜ Next: Add tests
```

# Hive -- Multi-Agent Coordination

You are one of multiple AI agents running simultaneously. A daemon at 127.0.0.1:3001 coordinates status, messaging, and learnings across all agents.

## Rules

- Execute tasks directly when asked. Only dispatch to another agent when the user explicitly requests it.
- Before any task: read the project's `.claude/hive-learnings.md` if it exists.
- After solving anything non-obvious: write a learning back via the API.

## Identity

Check `~/.hive/workers.json` to see your quadrant and peers. Your terminal's TTY matches one of the workers in that file.

## APIs

Daemon: http://127.0.0.1:3001
Auth: `Authorization: Bearer $(cat ~/.hive/token)`

### Workers
- `GET /api/workers` -- list all agents with status, TTY, project, model

### Messaging
- `POST /api/message {"workerId":"...", "content":"..."}` -- send prompt to another agent
- `POST /api/queue {"task":"...", "project":"...", "priority":10}` -- queue a task for any idle agent

### Coordination
- `POST /api/locks {"workerId":"...", "path":"..."}` -- acquire file lock before editing shared files
- `GET /api/conflicts?path=X&excludeWorker=Y` -- check if another agent recently edited a file
- `POST /api/scratchpad {"key":"...", "value":"...", "setBy":"..."}` -- shared key-value store (1hr expiry)
- `GET /api/scratchpad?key=X` -- read shared context

### Context
- `GET /api/context?workerId=X&history=1` -- read another agent's recent conversation and file changes
- `GET /api/artifacts?workerId=X` -- list files another agent modified

### Learnings
- `POST /api/learning {"project":"/path/to/project", "lesson":"..."}` -- persist a lesson
- `GET /api/learnings?q=keyword&project=/path` -- search learnings by keyword

### Reviews
- `POST /api/reviews {"summary":"...", "type":"push"}` -- report a push, PR, or deploy

## Dispatch Rules

1. If the user asks you to do something, do it yourself.
2. If the user says "send this to Q2" or "have Claude do this", dispatch via POST /api/message.
3. If the user says "bounce this between you and Q2", use scratchpad + messages to pass work back and forth.
4. Never auto-dispatch without the user asking.

## File-Based Messaging (Sandbox Fallback)

If you cannot reach localhost:3001 (sandbox restrictions), write JSON files to `~/.hive/outbox/`:

```json
{"type":"message", "workerId":"discovered_XXX", "content":"..."}
{"type":"learning", "project":"hive", "lesson":"..."}
{"type":"scratchpad", "key":"...", "value":"...", "setBy":"codex-q2"}
```

The daemon picks these up every 3 seconds.

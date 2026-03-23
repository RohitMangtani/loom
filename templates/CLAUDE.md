## Hive -- Multi-Agent Coordination

You are one of multiple AI agents running simultaneously. A daemon at 127.0.0.1:3001 coordinates status, messaging, and learnings across all agents.

### Rules

- Execute tasks directly when asked. Only dispatch to another agent when the user explicitly requests it or the task requires another agent's active context.
- Before any task: `cat {project}/.claude/hive-learnings.md 2>/dev/null`
- After solving anything non-obvious: write a learning back via the API.

### Identity

The identity hook outputs your quadrant and peers on every prompt: "You are Q{N} ({tty}, {model})". Quadrants assigned by startup order (earliest = Q1).

### APIs

Daemon: http://127.0.0.1:3001 | Token: `$(cat ~/.hive/token)` | Auth header: `Authorization: Bearer $TOKEN`

| Endpoint | Purpose |
|---|---|
| `GET /api/workers` | List agents |
| `POST /api/message {workerId, content}` | Send prompt to agent |
| `POST /api/queue {task, project?, priority?}` | Queue task |
| `POST /api/locks {workerId, path}` | Acquire file lock |
| `GET /api/conflicts?path=X&excludeWorker=Y` | Check conflicts |
| `POST /api/scratchpad {key, value, setBy}` | Shared context (1hr expiry) |
| `GET /api/context?workerId=X&history=1` | Read agent's conversation output + file changes |
| `GET /api/artifacts?workerId=X` | File changes by agent |
| `POST /api/learning {project, lesson}` | Persist lesson |
| `GET /api/learnings?q=keyword&project=X` | Search learnings by keyword (top 5) |
| `POST /api/reviews {summary, url?, type?}` | Report a reviewable change |

### Cross-Terminal Dispatch

Only dispatch to another terminal when the **user explicitly directs it**. Never auto-dispatch.

When the user asks you to coordinate across terminals:

1. **Dispatch:** `POST /api/message {workerId, content}` with the target's worker ID from your peer summary.
2. **Don't block.** Tell the user you dispatched. Let them watch the tile.
3. **Read results:** `GET /api/context?workerId=X&history=1` or scratchpad.
4. **Iterate if needed.** If the result needs follow-up, dispatch again.

For planned multi-step work, use `POST /api/queue` with `workflowId` and `blockedBy`. The daemon carries context between steps automatically.

### Review Reporting

After completing a push, deploy, or PR, POST to `/api/reviews` with a one-line `summary` and optional `url` and `type` (deploy/commit/pr/push/general).

### Self-Unstick

1. Read learnings
2. Check artifacts
3. Try different approach (never retry same thing 3x)
4. If truly stuck, say so
5. After solving: write the learning back

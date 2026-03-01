# Hive: Claude Code Orchestrator

## What this is

A management layer for multiple Claude Code instances. You see all running workers in one dashboard, talk to any of them directly, and an orchestrator Claude watches everything and helps coordinate.

Like Find My iPhone, but for Claude Code sessions.

## Architecture

Three components, two runtimes:

```
VERCEL (Dashboard)
  Next.js App Router
  WebSocket client → connects via tunnel to daemon

LOCAL DAEMON (Mac)
  Node.js process
  - WebSocket server (dashboard connection)
  - HTTP server :3001 (hook telemetry from workers)
  - Process manager (spawns/kills Claude Code CLI)
  - Orchestrator (Agent SDK, watches state, routes commands)

  Workers: Claude Code CLI instances
  - Each runs with --output-format stream-json
  - Each has hooks that POST telemetry to daemon :3001
  - Receive commands via stdin piping from daemon
```

Data flow:
- Commands: Dashboard → WebSocket → Daemon → CLI stdin
- Telemetry: CLI hooks → HTTP POST → Daemon → WebSocket → Dashboard
- Orchestrator: Reads telemetry, runs as Agent SDK agent inside daemon, can send commands to any worker

## Local Daemon

Node.js process with four responsibilities:

### Process Manager
- Spawns Claude Code CLI: `claude --project /path --output-format stream-json`
- stream-json gives structured output (each message as JSON on stdout)
- Tracks PID, project dir, start time, alive status per worker
- Can kill workers, auto-terminates idle workers after configurable timeout

### Telemetry Receiver (HTTP :3001)
- Each worker's hooks POST to `localhost:3001/telemetry`
- Payload: session_id, event type, tool_name, summary, timestamp
- Aggregates into per-worker state

### WebSocket Server (:3002)
- Dashboard connects via cloudflared tunnel
- Pushes real-time worker state updates
- Receives commands: spawn, message, kill

### Orchestrator (Agent SDK)
- Claude agent running inside the daemon
- Custom tools:
  - `get_worker_states()` — returns current telemetry for all workers
  - `send_to_worker(id, message)` — pipes message into worker stdin
  - `spawn_worker(project, task)` — starts a new Claude Code instance
  - `kill_worker(id)` — terminates a worker
- Accessible through the dashboard's orchestrator panel
- Can proactively suggest actions based on patterns (stuck workers, finished tasks, cross-worker dependencies)

## Dashboard (Vercel)

Single page, three zones:

### Worker Grid (main area)
Each worker is a card:
- Project name + directory
- Status pill: working (green pulse) / waiting (amber) / stuck (red) / idle (gray)
- Current task description
- Context usage % bar
- Time active
- Last action (e.g., "Edited lib/auth.ts")
- Click to expand into chat view

### Chat Panel (right side)
- Tap a worker card to open its conversation stream
- Type a message — goes to that worker's stdin
- Shows worker responses in real time from stream-json output

### Orchestrator Bar (bottom)
- Always-visible input for talking to the orchestrator
- High-level commands: "Deploy crawler and update the lab page link"
- Orchestrator decomposes into worker commands
- Shows suggestions as dismissible notifications

### Spawn Controls
- "New Worker" button: pick project directory from preset list (~/factory/projects/*)
- Optional initial task
- Or: type into orchestrator bar, it spawns for you

## Hook Telemetry Protocol

Hooks installed per worker at spawn time:

| Hook Event | Reports |
|---|---|
| SessionStart | Worker alive, project dir, session ID |
| PreToolUse | About to use tool X on file Y |
| PostToolUse | Tool X completed (success/fail), output summary |
| Stop | Worker finished responding, now idle |
| SubagentStart | Worker spawned a subagent |
| SubagentStop | Subagent finished |

Payload shape:
```json
{
  "worker_id": "w_abc123",
  "session_id": "sess_xyz",
  "event": "PostToolUse",
  "tool_name": "Edit",
  "summary": "Edited lib/auth.ts lines 18-25",
  "timestamp": 1709157600000
}
```

Worker state derived from events:
```typescript
interface WorkerState {
  id: string;
  pid: number;
  project: string;
  status: "working" | "waiting" | "stuck" | "idle";
  currentAction: string | null;
  lastAction: string;
  lastActionAt: number;
  errorCount: number;
  startedAt: number;
  contextPercent: number;
}
```

Status derivation:
- working: PreToolUse within last 30s
- waiting: Stop event, no new activity
- stuck: same PreToolUse repeated 3+ times, or error count > 2 in last minute
- idle: no events for 5+ minutes

Hook injection: daemon writes temporary hooks config to `.claude/settings.local.json` in the project directory at spawn time. Hooks point to a shell script that curls the daemon.

## Tunnel & Connectivity

Cloudflared tunnel (free, no account needed) exposes daemon's WebSocket server at a stable URL. Dashboard connects to this URL.

Auth: daemon generates a random token on startup, displayed in terminal. Paste into dashboard once. All WebSocket messages include this token.

Reconnection: dashboard shows "Daemon offline" and retries every 5s. Workers keep running locally.

Local fallback: localhost:3000 works without tunnel when at your Mac.

## Project Structure

```
~/factory/projects/hive/
├── apps/
│   ├── dashboard/          # Next.js (Vercel)
│   │   ├── app/
│   │   │   └── page.tsx
│   │   ├── components/
│   │   │   ├── WorkerCard.tsx
│   │   │   ├── ChatPanel.tsx
│   │   │   └── OrchestratorBar.tsx
│   │   └── lib/
│   │       └── ws.ts
│   │
│   └── daemon/             # Node.js (local)
│       ├── src/
│       │   ├── index.ts
│       │   ├── process-mgr.ts
│       │   ├── telemetry.ts
│       │   ├── ws-server.ts
│       │   ├── orchestrator.ts
│       │   └── hooks/
│       │       └── telemetry-hook.sh
│       └── package.json
│
├── package.json            # npm workspaces
└── turbo.json
```

## Stack

- Dashboard: Next.js App Router, Tailwind CSS, dark theme (matches rmgtni.xyz)
- Daemon: Node.js, ws library, express (telemetry HTTP), Agent SDK
- Tunnel: cloudflared
- Workers: Claude Code CLI with stream-json output

## Interaction Model

- You can talk directly to any worker by clicking its card
- You can talk to the orchestrator via the bottom bar
- The orchestrator can spawn workers, route messages, and suggest actions
- Both manual spawn (click button) and orchestrator spawn (tell it what to do) supported
- Workers auto-terminate after idle timeout

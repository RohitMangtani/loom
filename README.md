# Hive

See all your AI agents on one screen. Green means working. Red means done. Yellow means stuck. Type into any tile to talk to it.

**[See the live dashboard](https://dashboard-flame-two-83.vercel.app?viewer=d6c8f4964e4fb13247a08bb616da88d557b4f34b503f1b9fe96e824822bd2bf0)** (view-only, connects to a real running instance)

Think about Find My iPhone. You open one app and see every Apple device you own. Green dot, online. Grey dot, offline. You do not open a separate app for each device. One visual layer shows you everything. Hive does the same thing for AI agents. Open four terminals, run `claude` in each, and the dashboard shows you what all of them are doing. No alt-tabbing. No guessing which one finished. No lost output from an agent stuck on a permission prompt you did not notice.

One person. Four agents. The output of a small team.

## What You Get

- **Stoplight dashboard** — 2x2 grid matching your terminal layout. Green/red/yellow at a glance. Open on your phone, tablet, or second monitor.
- **Auto-discovery** — start `claude` in any terminal and the daemon finds it within 3 seconds. No registration, no config.
- **Auto-pilot** — permission prompts auto-approve after a 3-second grace window. Agents never sit idle waiting for a click.
- **Messaging** — tap any tile, type a message, it goes straight to that agent's terminal. Direct agents from your phone.
- **Coordination** — file locks prevent two agents from editing the same file. Task queue auto-dispatches work to idle agents. Scratchpad lets agents leave notes for each other.
- **Compound learning** — every solved problem gets written to a per-project knowledge file. The next agent reads it before starting. Your fleet gets smarter over time.

## Prerequisites

- **macOS** (uses AppleScript + CGEvent for terminal interaction)
- **Node.js 20+** — [nodejs.org](https://nodejs.org)
- **Claude Code** — `npm install -g @anthropic-ai/claude-code`

## Setup

```bash
git clone https://github.com/RohitMangtani/hive.git
cd hive
bash setup.sh
```

The setup script does 5 things:
1. Checks Node.js 20+ and Claude Code CLI are installed
2. Installs all npm dependencies (monorepo workspaces)
3. Compiles the `send-return` Swift binary for auto-pilot keystroke injection
4. Configures Claude Code hooks so every agent reports live events to the daemon
5. Creates `.env` from the template

### Accessibility Permission (required)

After setup, you must grant Accessibility permission to `~/send-return`. This binary sends Return keystrokes to auto-approve agent prompts.

1. Open **System Settings → Privacy & Security → Accessibility**
2. Click the **+** button
3. Press **Cmd+Shift+G**, type `~/send-return`, and select it
4. Toggle it **on**

Without this, auto-pilot will not work and agents will stall waiting for permission approvals.

## Running

You need 3 things running:

**1. Daemon** (coordinates everything)
```bash
npm run dev:daemon
```
Starts on port 3001 (HTTP API) and port 3002 (WebSocket).

**2. Dashboard** (in a new terminal)
```bash
npm run dev:dashboard
```
Opens at `localhost:3000`.

**3. Agents** (open 4 Terminal.app tabs, run `claude` in each)
```bash
claude
```

The daemon auto-discovers agents within 3 seconds. The dashboard shows their status.

## The Quadrant Setup

Arrange your 4 terminal tabs in a 2x2 grid:

```
┌───────────┬───────────┐
│  Agent 1  │  Agent 2  │
│  (Q1)     │  (Q2)     │
├───────────┼───────────┤
│  Agent 3  │  Agent 4  │
│  (Q3)     │  (Q4)     │
└───────────┴───────────┘
```

Each agent gets a quadrant number based on when it started (earliest = Q1). The dashboard mirrors this layout so your screen matches your mental model.

**Use it as a stoplight.** Put the dashboard on a phone, tablet, or second monitor. Each agent card is a stoplight:
- **Green** — working
- **Red** — idle / done
- **Yellow** — stuck, needs input

Tap any tile to open its chat. Type a message and it goes straight to that agent's terminal.

## How It Works

### Auto-Discovery
Detects Claude processes within 3 seconds via `ps` + `lsof`. No configuration needed. Start `claude` in any terminal and the daemon finds it.

### Status Tracking
Three-layer detection pipeline determines real-time status:
1. **Hook events** — Claude Code hooks report every tool call to the daemon
2. **JSONL analysis** — reads the agent's conversation log for recent activity
3. **CPU signal** — falls back to CPU usage (>8% = working) when hooks are delayed

### Auto-Pilot
Auto-approves permission prompts so agents never sit idle waiting for you. The daemon detects when an agent is stuck on a prompt, waits a 3-second grace window (so you can override from the dashboard), then sends a Return keystroke via the `send-return` binary.

This is how you run 4 agents unattended. You give them tasks and walk away. Auto-pilot keeps them moving.

### Coordination
Multiple agents can safely work on the same codebase:
- **File locks** — acquire advisory locks before editing shared files (`POST /api/locks`)
- **Conflict detection** — check if another agent recently modified a file (`GET /api/conflicts`)
- **Scratchpad** — leave ephemeral notes for other agents (`POST /api/scratchpad`), auto-expires in 1 hour
- **Inter-agent messaging** — send a prompt to any other agent (`POST /api/message`)
- **Task queue** — push tasks to a global queue, auto-dispatched to the next idle agent (`POST /api/queue`)

### Compound Learning
Every solved problem gets written to a per-project knowledge file (`.claude/hive-learnings.md`). The next agent that works on that project reads it before starting. Every debugging session, every style correction, every architectural decision compounds. After months of running, the system knows things about your projects that no fresh agent could replicate.

### Watchdog
Monitors agents for stuck loops (same tool called 6+ times in a row). Sends warnings and can auto-intervene. Detects when agents are spinning on a problem and need a different approach.

## API Reference

All endpoints require the auth token from `~/.hive/token` via the `Authorization: Bearer <token>` header.

**Base URL:** `http://localhost:3001`

### Workers
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/workers` | List all agents with status, TTY, project, current action |

### Messaging
| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `POST` | `/api/message` | `{workerId, content}` | Send a prompt to any agent. Queued if agent is busy. |
| `GET` | `/api/message-queue` | — | View pending message queue sizes per agent |

### Task Queue
| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `GET` | `/api/queue` | — | View all queued tasks |
| `POST` | `/api/queue` | `{task, project?, priority?, blockedBy?}` | Push a task. Auto-dispatched to next idle agent. |
| `DELETE` | `/api/queue/:id` | — | Remove a queued task |

### File Coordination
| Method | Endpoint | Body / Query | Description |
|--------|----------|--------------|-------------|
| `GET` | `/api/locks` | — | List all active file locks |
| `POST` | `/api/locks` | `{workerId, path}` | Acquire lock. Returns 409 if already locked. |
| `DELETE` | `/api/locks` | `?workerId=X&path=Y` | Release lock (omit path to release all) |
| `GET` | `/api/conflicts` | `?path=X&excludeWorker=Y` | Check if another agent recently modified a file |

### Scratchpad
| Method | Endpoint | Body / Query | Description |
|--------|----------|--------------|-------------|
| `GET` | `/api/scratchpad` | `?key=X` (optional) | Read notes. Omit key for all entries. |
| `POST` | `/api/scratchpad` | `{key, value, setBy}` | Set a shared note. Auto-expires in 1 hour. |
| `DELETE` | `/api/scratchpad` | `?key=X` | Remove a note |

### Learning & Artifacts
| Method | Endpoint | Body / Query | Description |
|--------|----------|--------------|-------------|
| `POST` | `/api/learning` | `{project, lesson}` | Persist a lesson to the project's learning file |
| `GET` | `/api/artifacts` | `?workerId=X` (optional) | Recent file changes by an agent |

### Diagnostics
| Method | Endpoint | Query | Description |
|--------|----------|-------|-------------|
| `GET` | `/api/audit` | `?tty=X` (optional) | Status change audit log |
| `GET` | `/api/signals` | `?workerId=X` (optional) | Raw signal data (hooks, CPU, JSONL) |
| `GET` | `/api/debug` | — | Full daemon state dump |

### Example: Send a task to an idle agent

```bash
TOKEN=$(cat ~/.hive/token)

# Check who's available
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/workers | jq '.[] | {id, tty, status}'

# Send a message to a specific agent
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workerId":"WORKER_ID","content":"Fix the login bug in src/auth.ts"}' \
  http://localhost:3001/api/message

# Queue a task for the next idle agent
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task":"Write tests for the payment module","project":"/path/to/project"}' \
  http://localhost:3001/api/queue
```

## How Agents Use Hive

Each agent reads instructions from `~/.claude/CLAUDE.md` that tell it how to interact with the daemon. Here's what agents do automatically:

1. **Identify themselves** — read `~/.hive/workers.json` on startup to find their quadrant
2. **Check learnings** — read `.claude/hive-learnings.md` before starting any task
3. **Lock files** — acquire locks before editing files other agents might touch
4. **Write learnings** — persist lessons after solving non-obvious problems
5. **Dispatch work** — send tasks to other agents when the work involves a different project or needs a fresh perspective
6. **Use scratchpad** — leave notes about in-progress work for other agents

These behaviors are configured through the CLAUDE.md instructions, not hardcoded. You can customize how agents coordinate by editing the instructions.

## Configuration

### Environment Variables (.env)

| Variable | Default | Description |
|----------|---------|-------------|
| `HIVE_PROJECT` | `~/factory/projects/hive` | Path to the Hive project root |
| `SEND_RETURN_BIN` | `~/send-return` | Path to the CGEvent binary for auto-pilot |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:3002` | WebSocket URL the dashboard connects to |

### Claude Code Hooks

Setup configures 4 hooks in `~/.claude/settings.json`:
- **PreToolUse** — fires before every tool call, reports tool name to daemon
- **PostToolUse** — fires after every tool call, reports result
- **Notification** — fires on agent notifications (errors, completions)
- **Stop** — fires when an agent session ends

If you already have hooks configured, run `bash setup-hooks.sh` to see the JSON to merge manually.

### Authentication

Setup generates a random token at `~/.hive/token`. All API requests require this token. The daemon reads it on startup. Agents read it via their hook commands.

## Architecture

```
Daemon (Node.js, port 3001 + 3002)
├── Discovery     — finds Claude processes via ps + lsof every 3s
├── Telemetry     — receives hook events, maintains worker state
├── Auto-pilot    — detects stuck prompts, auto-approves via send-return
├── Watchdog      — detects stuck loops, sends warnings
├── Task queue    — global work queue, auto-dispatches to idle agents
├── Coordination  — file locks, scratchpad, conflict detection, learnings
├── API routes    — REST endpoints for all coordination features
└── WebSocket     — pushes live state to dashboard every second

Dashboard (Next.js, port 3000)
├── 2×2 grid      — stoplight status cards matching terminal layout
├── Live chat     — stream each agent's conversation history
└── Controls      — send messages, spawn agents, view queue
```

### Key Files

| File | Purpose |
|------|---------|
| `apps/daemon/src/index.ts` | Entry point, initializes all systems |
| `apps/daemon/src/discovery.ts` | Process discovery and status detection |
| `apps/daemon/src/telemetry.ts` | Hook event receiver, worker state machine |
| `apps/daemon/src/auto-pilot.ts` | Automatic prompt approval |
| `apps/daemon/src/tty-input.ts` | AppleScript + CGEvent terminal interaction |
| `apps/daemon/src/api-routes.ts` | All REST API endpoints |
| `apps/daemon/src/ws-server.ts` | WebSocket server for dashboard |
| `apps/daemon/src/watchdog.ts` | Stuck loop detection |
| `apps/daemon/src/task-queue.ts` | Global task queue |
| `apps/daemon/src/lock-manager.ts` | File lock coordination |
| `apps/daemon/src/scratchpad.ts` | Ephemeral shared notes |
| `apps/daemon/src/session-stream.ts` | Chat history streaming from JSONL |
| `tools/send-return.swift` | CGEvent binary source (Return keystroke) |
| `packages/types/` | Shared TypeScript types |

## Troubleshooting

**Agents not showing up on dashboard**
- Make sure the daemon is running (`npm run dev:daemon`)
- Check that hooks are configured: `cat ~/.claude/settings.json | grep hooks`
- The daemon discovers agents every 3 seconds. Wait a moment.

**Auto-pilot not working (agents stuck on prompts)**
- Grant Accessibility permission to `~/send-return` (see Setup section)
- Test it manually: `~/send-return` should send a Return keystroke to the frontmost app
- Check daemon logs for `[auto-pilot]` messages

**"Connection refused" errors**
- Daemon must be running on port 3001 before agents start
- Check nothing else is using port 3001: `lsof -i :3001`

**Dashboard shows stale data**
- Refresh the page. WebSocket reconnects automatically.
- Check that port 3002 is reachable: `curl http://localhost:3002`

**Hooks not reporting events**
- Verify hooks exist: `cat ~/.claude/settings.json | jq .hooks`
- If you had existing hooks, they may need manual merging. Run `bash setup-hooks.sh` for instructions.
- Test a hook manually: start `claude`, use any tool, check daemon logs for `[telemetry]` events.

**Build errors**
- Make sure you're on Node.js 20+: `node -v`
- Try `npm install` from the project root
- For TypeScript errors: `npx turbo build` to see full output

## Development

```bash
# Install dependencies
npm install

# Run daemon in dev mode (auto-restarts on changes)
npm run dev:daemon

# Run dashboard in dev mode
npm run dev:dashboard

# Build everything
npm run build

# Run tests
npm -w apps/daemon test
```

The project uses npm workspaces with Turbo for build orchestration. The daemon and dashboard are separate apps that share types via `packages/types/`.

## How This Was Built

This was built using the agents it manages. Four Claude Code instances iterated on the daemon and dashboard simultaneously while a human directed architecture and resolved conflicts. The compound learning system was tested in production from day one, with each session's lessons feeding the next.

- [What Hive Is](https://www.rohitmangtani.com/lab/hive) — What it does, how it works, and where it fits
- [Game Plan](https://rmgtni.xyz/lab/hive-game-plan) — The product edge and what comes next
- [System Audit](https://rmgtni.xyz/lab/hive-system-audit) — Full technical deep dive, competitor analysis, and strategy

## License

MIT

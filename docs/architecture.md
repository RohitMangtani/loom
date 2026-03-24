# Hive Architecture

This document describes how data flows through Hive, from agent process discovery to the dashboard tile turning green.

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Primary Mac                          │
│                                                             │
│  Terminal.app                                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │ claude   │ │ codex    │ │ claude   │ │ openclaw │      │
│  │ (Q1)     │ │ (Q2)     │ │ (Q3)     │ │ (Q4)     │      │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘      │
│       │             │            │             │             │
│       ▼             ▼            ▼             ▼             │
│  ┌──────────────────────────────────────────────────┐       │
│  │                 Hive Daemon                       │       │
│  │                                                   │       │
│  │  Discovery ──► Telemetry ──► WebSocket Server     │       │
│  │  (ps/lsof)     (state)       (port 3002)    ◄────┼──┐    │
│  │                    │                              │  │    │
│  │  Auto-Pilot    REST API      Satellite Relay      │  │    │
│  │  (unstick)    (port 3001)    (federation)         │  │    │
│  │                    │                              │  │    │
│  │  Watchdog      Coordination   Review Manager      │  │    │
│  │  (self-heal)   (locks/pad)    (auto-detect)       │  │    │
│  └──────────────────────────────────────────────────┘  │    │
│                                                         │    │
│                              ┌───────────────────┐      │    │
│                              │  ngrok/cloudflared │      │    │
│                              │  (public tunnel)   │──────┘    │
│                              └───────────────────┘           │
└─────────────────────────────────────────────────────────────┘
         │                              │
         │ WebSocket (wss://)           │ WebSocket (wss://)
         ▼                              ▼
  ┌──────────────┐              ┌──────────────┐
  │  Dashboard   │              │  Satellite   │
  │  (Vercel)    │              │  Mac         │
  │  Phone/Web   │              │  (more       │
  │              │              │   agents)    │
  └──────────────┘              └──────────────┘
```

## Data Flow: Agent Discovery → Dashboard

### 1. Process Discovery (`discovery.ts`)

Every 3 seconds, the daemon scans for AI agent processes:

```
ps -eo pid,pcpu,lstart,tty,command
```

This finds any process matching known patterns (`claude`, `codex`, `openclaw`, or custom agents defined in `~/.hive/agents.json`).

For each discovered process:
- `lsof -p PID` extracts the working directory, TTY device, and open file handles
- Session file resolution finds the agent's JSONL log (6-step priority chain)
- JSONL tail analysis determines initial status (working/idle)

New agents appear on the dashboard within 3-6 seconds.

### 2. Status Detection (7-Layer Pipeline)

The status detection system determines whether an agent is working (green), idle (red), or stuck (yellow). Seven cooperating layers prevent phantom green (false working state):

| Layer | Where | What it does |
|-------|-------|-------------|
| 1. Noise filtering | `analyzeJsonlTail` | Filters progress/system/file-history entries before scanning |
| 2. High confidence | `analyzeJsonlTail` | Marks tool_use as high-confidence, mid-stream heuristics as low |
| 3. Corroboration | `runJsonlAnalysis` | Low-confidence working blocked unless hooks or input confirm |
| 4. Confidence-gated cooldown | `runJsonlAnalysis` | Only high-confidence signals set the 25s working timer |
| 5. Extended cooldown | `runJsonlAnalysis` | 25s green holdover after genuine tool calls (covers API thinking) |
| 6. Idle lock | `runJsonlAnalysis` | Hysteresis-confirmed idle is locked until real evidence of work |
| 7. Input override | `runJsonlAnalysis` | Dashboard message clears idle lock immediately |

Additionally, **Layer 8 (CPU/PTY signal)** checks process CPU usage and terminal output byte offsets when other signals are ambiguous.

### 3. Hook Events (`telemetry.ts`)

Claude Code sends hook events via HTTP POST to the daemon:

- **PreToolUse**  --  Agent is about to call a tool (fastest signal, ~350ms)
- **PostToolUse**  --  Tool call completed
- **Notification**  --  Permission prompt or idle state
- **UserPromptSubmit**  --  New prompt received (triggers identity injection)
- **Stop**  --  Session ended

Hooks are routed to workers via session ID → worker ID mapping. A pending hook queue handles the race condition where hooks arrive before discovery registers the session.

### 4. WebSocket Broadcasting (`ws-server.ts`)

The WebSocket server pushes state to connected clients:

- **Dashboard clients** receive `workers` (full state), `worker_update` (single change), `chat_history` (conversation stream), and `reviews` (auto-detected push/PR/deploy events)
- **Satellite clients** exchange bidirectional worker state and command relay

### 5. Dashboard Rendering (`apps/dashboard/`)

The dashboard is a Next.js static export deployed to Vercel. It connects via WebSocket and renders:

- Agent tiles in a grid (green/yellow/red status dots)
- Chat panel for sending messages to any agent
- Spawn dialog for creating new agents
- Review drawer for git push/PR/deploy notifications
- Presence bar showing connected users
- Message attribution (who sent each message)
- Activity feed (human actions visible to all)

## Multiplayer

Hive supports multiple humans on the same dashboard with role-based access.

### User Registry (`user-registry.ts`)

Named users with per-user tokens and three roles:
- **Admin**: full control (spawn, kill, message, manage users)
- **Operator**: can message agents and manage tasks, cannot kill/spawn/manage users
- **Viewer**: read-only dashboard access

Users are stored at `~/.hive/users.json`. The existing single admin token from `~/.hive/token` is backwards-compatible: on first load, a bootstrap admin user is created from it. The legacy viewer token (SHA-256 derived) also continues to work.

### Presence

The WebSocket server tracks which users are connected and broadcasts presence to all clients. The dashboard shows who is watching in real time.

### Activity Feed

Human actions (messages sent, agents spawned, prompts approved) are broadcast as activity events to all connected clients with the user's name attached.

### REST API

- `GET /api/users` -- list all users (admin only, no tokens in response)
- `POST /api/users { name, role }` -- create user, returns token (admin only)
- `DELETE /api/users/:id` -- remove user (admin only)

## Module Map

### Core (daemon)

| Module | Responsibility | Dependencies |
|--------|---------------|-------------|
| `telemetry.ts` | Worker state, hooks, dispatch, context building | coordination, review-manager, swarm-controller |
| `discovery.ts` | Process scanning, JSONL analysis, status detection | telemetry, session-stream |
| `tty-input.ts` | Send text/keystrokes to Terminal.app tabs | AppleScript, CGEvent (macOS-specific) |
| `ws-server.ts` | WebSocket, dashboard commands, satellite federation | telemetry, tty-input, discovery |
| `session-stream.ts` | JSONL tail following, chat history parsing | fs.watch, multi-format (Claude/Codex/Gemini) |
| `auto-pilot.ts` | Auto-respond to stuck prompts (3s grace) | telemetry, tty-input |
| `watchdog.ts` | Anomaly detection, adaptive suppression, auto-learn | telemetry |
| `user-registry.ts` | Named users, role-based tokens, presence tracking | standalone |

### Extracted Modules

| Module | Responsibility | Extracted from |
|--------|---------------|---------------|
| `review-manager.ts` | Auto-detect git push/PR/deploy, review lifecycle | telemetry.ts |
| `coordination.ts` | Scratchpad, file locks, artifact tracking, conflicts | telemetry.ts |
| `swarm-controller.ts` | Cross-machine spawn/kill/exec/repair routing | telemetry.ts |

### Platform Layer

| Module | Purpose |
|--------|---------|
| `platform/interfaces.ts` | Cross-platform interfaces (TerminalIO, ProcessDiscoverer, WindowManager) |
| `platform/macos/index.ts` | Thin adapter wrapping existing macOS-specific daemon modules |
| `platform/linux/` | tmux + /proc implementation for pane-based Linux runtime control |
| `platform/index.ts` | Auto-detect OS and load the correct platform at startup |

### Packages

| Package | Purpose |
|---------|---------|
| `@rohitmangtani/hive` | CLI package for `hive init` and `hive doctor` flows |
| `@hive/types` | Shared TypeScript interfaces (WorkerState, etc.) |
| `@hive/protocol` | Typed definitions for all REST, WebSocket, and hook contracts |

## Multi-Machine Federation

Satellite machines connect to the primary daemon via WebSocket tunnel:

1. Primary runs ngrok/cloudflared tunnel exposing port 3002
2. Satellite connects with `--satellite wss://tunnel-url TOKEN`
3. Satellite runs local discovery + session streaming
4. Every 3 seconds, satellite sends `satellite_workers` with local worker states
5. Primary merges satellite workers into the dashboard alongside local ones
6. Commands (message, spawn, kill) are relayed bidirectionally

Satellite self-healing: disconnected satellites escalate from reconnect → local repair → local reinstall using stored credentials at `~/.hive/primary-url` and `~/.hive/primary-token`.

## Platform Abstraction

The daemon now loads its platform at startup through `apps/daemon/src/platform/` and routes discovery, terminal I/O, layout, local spawn/kill, and satellite-side control through that abstraction.

### Interfaces (`platform/interfaces.ts`)

- `TerminalIO`  --  send text, keystrokes, and selections to agent terminals; read terminal content
- `ProcessDiscoverer`  --  find running agent processes, get CPU usage, track PTY output
- `WindowManager`  --  spawn/close terminals, arrange window layout

### Implementations

| Platform | Location | Status |
|----------|----------|--------|
| macOS | `platform/macos/index.ts` | Thin wrapper over existing `tty-input.ts`, `discovery.ts`, `arrange-windows.ts` |
| Linux | `platform/linux/` | tmux-based: `send-keys`, `capture-pane`, `/proc` reads, pane-based layout. Wired into runtime, with live Linux host validation still pending. |

### macOS-specific code (current direct imports)

| Module | macOS dependency |
|--------|-----------------|
| `tty-input.ts` | AppleScript `do script` + CGEvent `send-return` binary |
| `discovery.ts` | `ps -eo lstart`, `lsof -p PID` |
| `arrange-windows.ts` | AppleScript window positioning |
| `process-mgr.ts` | Terminal.app tab spawning |

### What remains for Linux hardening

The platform interfaces and Linux implementation are live in the daemon now. The remaining work is:
1. Integration test on a real Linux machine with tmux installed
2. Refine pane layout behavior to better match Hive's visual quadrant model under different terminal sizes
3. Harden Linux-specific failure modes around tmux session loss, reconnects, and process cleanup
4. Expand end-to-end coverage beyond the unit-tested tmux pane manager

See [GitHub issue #4](https://github.com/RohitMangtani/hive/issues/4).

## Measured Performance

Data from a 60-day period (Jan 23 - Mar 24, 2026) comparing single-agent workflows to Hive-managed multi-agent sessions across five repositories.

### Output

| | Pre-Hive (36 days) | With Hive (25 days) |
|---|---|---|
| Commits/day | 7.6 | 38.4 |
| Active coding days | 14 of 36 (39%) | 25 of 25 (100%) |
| Repos active per day | 1 | 4 |
| Total commits | 275 | 961 |

### Parallelism

Pre-Hive, 77% of active days had a single repository receiving commits. With Hive, 60% of active days had four or more repositories receiving commits simultaneously.

| Concurrent repos | Pre-Hive | With Hive |
|---|---|---|
| 1 (sequential) | 10 days | 1 day |
| 2-3 | 2 days | 9 days |
| 4+ (parallel) | 1 day | 15 days |

### What the system tracked

Over the Hive period, the daemon logged 48,372 tool call events, 7,298 status transitions, caught 51 cross-agent file conflicts, and recorded 451 hourly coordination snapshots. The 7-layer detection pipeline described above produced these signals without any manual instrumentation from the user.

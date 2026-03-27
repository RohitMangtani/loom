# Hive Guide

A practical guide to setting up, running, and getting the most out of Hive.

For the technical deep dive, see [architecture.md](architecture.md). For the design thinking behind the visual layer, read [A Visual Workflow for AI Agents](https://rohitmangtani.com/writing/a-visual-workflow-for-ai-agents).

---

## Why Hive Exists

Running one AI agent is easy. Running four at the same time across different projects is manageable. Running eight across two machines while trying to keep track of what each one is doing, what finished, what is stuck, and what needs your attention next is where things break down. The bottleneck stops being generation and becomes coordination.

Hive is a visual coordination layer. It mirrors your terminal layout as a grid of colored tiles. Green means working. Red means done. Yellow means it needs you. You glance at your phone and know exactly which terminal needs attention without reading a single line of output.

It solves four problems:

1. **Seeing everything at once.** Color and position replace log reading. Your brain flags a yellow dot among green dots before you consciously decide to look.
2. **Moving work between agents.** Tap a tile, type what you want in plain English. For planned sequences, the task queue carries structured context forward automatically.
3. **Mixing models.** Claude, Codex, and OpenClaw in the same grid. Each does what it is best at. Different models audit each other's blind spots.
4. **Connecting machines.** Multiple computers feed into one dashboard. A second Mac appears in the same tile stack within seconds.

---

## Setup

### What You Need

- **macOS** or **Linux with tmux** (Linux support is implemented and working; live-host testing across more distributions is ongoing)
- **Node.js 20+** ([nodejs.org](https://nodejs.org))
- At least one AI CLI: `claude`, `codex`, or `openclaw`
- A free [Vercel](https://vercel.com) account (for the hosted dashboard)

### Install

The fastest path is to paste this into Claude Code or Codex and let the agent handle it:

> Install Hive for me. Clone https://github.com/RohitMangtani/hive. Before running the install script, ask me: "Which setup do you want? (1) Desktop app on this Mac, (2) New Hive environment with your own hosted dashboard, or (3) Connect this Mac to an existing Hive network on another computer."

Or install manually:

```bash
git clone https://github.com/RohitMangtani/hive.git
cd hive
bash scripts/install.sh --fresh
```

The script checks Node.js, installs dependencies, generates your auth token, configures Claude Code hooks, and optionally compiles the auto-pilot binary.

### Quick Start (local only, no Vercel)

If you just want to try it on localhost without deploying:

```bash
git clone https://github.com/RohitMangtani/hive.git
cd hive
npm run launch:local
```

Open `http://localhost:3000`, then open terminals and run `claude`, `codex`, or `openclaw tui`. Tiles appear within 3 seconds.

### macOS Permissions

After install, macOS asks for two things:

1. **Automation permission**: "Terminal wants to control Terminal." Click OK. This lets Hive send messages to agent terminals.
2. **Accessibility permission** (optional): Drag `send-return` into System Settings > Privacy & Security > Accessibility and toggle it on. This enables auto-pilot, which auto-approves agent permission prompts so they never sit idle.

### Linux Setup (tmux)

On Linux, Hive uses tmux instead of Terminal.app. Before running the daemon:

1. **Install tmux**: `sudo apt install tmux` (Debian/Ubuntu) or `sudo dnf install tmux` (Fedora).
2. **Create the session**: The daemon creates a tmux session named `hive` automatically when spawning the first agent. You can also create it manually: `tmux new-session -d -s hive -n swarm`.
3. **Attach to it**: `tmux attach -t hive` to see agent panes side by side.

No accessibility permissions or special binaries are needed on Linux. Terminal I/O goes through tmux's `send-keys` command directly. Auto-pilot works out of the box once the tmux session is running.

### Your Token

Setup prints an auth token. Copy it. Open the dashboard URL, paste the token into the input field at the top, and hit enter. You now have full admin control. The token is saved at `~/.hive/token` if you need it again.

---

## Running

### Recommended: Hosted Dashboard

```bash
npm run launch
```

This starts the daemon, opens a public tunnel, deploys the dashboard to your Vercel account, and opens it in your browser. Keep this terminal running.

### Other Options

| Command | What it does |
|---------|-------------|
| `npm run launch:local` | Daemon + dashboard on localhost only |
| `npm start` | Daemon + tunnel only (deploy dashboard separately) |
| `npm run dev:daemon` | Daemon in dev mode with auto-restart |
| `npm run dev:dashboard` | Dashboard in dev mode at localhost:3000 |
| `npm run doctor` | Diagnose and repair runtime issues |

### Starting Agents

**macOS**: Open Terminal.app windows and run any supported CLI:

```bash
claude
codex
openclaw tui
```

Each one appears on the dashboard within 3 seconds. Stack your terminal windows vertically on screen. The daemon detects their positions and maps each one to the matching tile in the dashboard stack. Move a terminal higher on screen, and it moves up in the dashboard.

**Linux**: Agents run inside tmux panes in the `hive` session. Spawn them from the dashboard or split panes manually:

```bash
tmux split-window -t hive:swarm 'claude'
tmux select-layout -t hive:swarm even-vertical
```

The daemon detects pane positions within 3 seconds. Panes are mapped to quadrant slots top-to-bottom based on their vertical position in the tmux layout.

You can also spawn agents from the dashboard. Tap "+ Agent", pick a model, optionally add a starting task, and hit Spawn.

### Phone Access

Open the dashboard URL on your phone and add it to your home screen. It runs full-screen like a native app. Tap the bell icon in the header to enable push notifications: your phone buzzes when an agent finishes or gets stuck.

---

## Features

### Stoplight Dashboard

Tiles stacked vertically, one per agent, matching your terminal layout. The color tells you the state:

- **Green**: Agent is actively working (tool calls, code generation, file edits)
- **Red**: Agent is idle or finished its task
- **Yellow**: Agent needs you (permission prompt, stuck loop, or waiting for input)

Supports 1-8 agents per machine.

### Auto-Discovery

Start any supported agent in a terminal and Hive finds it automatically via process scanning (`ps` + `lsof`). No registration, no config files, no setup per agent. The daemon checks every 3 seconds.

### Auto-Pilot

Permission prompts auto-approve after a 3-second grace window. If you want to intervene, you have 3 seconds to do it from the dashboard. Otherwise, the agent keeps moving. This is how you run agents unattended. Give them tasks and walk away.

Requires the `send-return` accessibility permission (see Setup).

### Messaging

Tap any tile and type a plain English message. It goes straight to that agent's terminal as if you typed it there. Messages queue if the agent is busy and deliver when it is ready.

Examples:
- "Stop what you are doing and fix the login bug first"
- "Read what the agent above just committed and review it"
- "Run the test suite and tell me what fails"

### Multi-Model

Claude, Codex, and OpenClaw run in the same grid. Spawn any from the dashboard. Each model brings different strengths:

- **Claude**: Deep reasoning, architecture decisions, complex refactors
- **Codex**: Fast surgical edits, code generation, test writing
- **OpenClaw**: Provider flexibility, alternative perspectives

Mix them on purpose. Use one model to audit what another built. Different models catch different blind spots.

### Multi-Machine

Connect additional Macs as satellites. On the second computer:

```bash
bash scripts/install.sh --connect wss://YOUR-TUNNEL-URL YOUR-TOKEN
```

The tunnel URL and token are printed at the end of the primary install (also at `~/.hive/tunnel-url.txt` and `~/.hive/token`). Satellite agents appear in the same dashboard alongside local ones. Messages, tasks, and coordination route transparently across machines.

Satellites run as a background service and survive sleep, reboot, and terminal close.

### Coordination

Multiple agents can safely work on the same codebase:

| Feature | How it works |
|---------|-------------|
| **Peer awareness** | Each agent sees a one-line summary of what the others are doing |
| **File locks** | Acquire advisory locks before editing shared files |
| **Conflict detection** | Check if another agent recently modified a file you are about to touch |
| **Scratchpad** | Leave ephemeral notes for other agents (auto-expire in 1 hour) |
| **Inter-agent messaging** | Send a prompt from one agent to another via the API |

### Workflow Handoffs

For multi-step work where you know the sequence:

```bash
TOKEN=$(cat ~/.hive/token)

# Step 1: Build the API
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"Build API endpoints for users","project":"/path/to/project","workflowId":"feature-auth"}' \
  http://localhost:3001/api/queue

# Step 2: Build the UI (auto-starts when step 1 finishes)
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"Build UI against the API","project":"/path/to/project","workflowId":"feature-auth","blockedBy":"STEP1_ID"}' \
  http://localhost:3001/api/queue
```

When step 1 finishes, step 2 receives: "Previous step completed by Q3: created src/api/users.ts, created src/api/auth.ts. Your task: Build UI against the API."

The system verifies git state before each handoff and flags uncommitted files or merge conflicts.

### Capability Routing

Tasks can target specific agents or machines:

```bash
# Only dispatch to machines with GPU
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"Render the video","requires":["gpu","ffmpeg"]}' \
  http://localhost:3001/api/queue

# Only dispatch to Codex agents
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"Review this PR","model":"codex"}' \
  http://localhost:3001/api/queue
```

Each machine auto-reports its capabilities (CPU, RAM, GPU, installed software). Add custom tags via `~/.hive/capabilities.json`.

### Compound Learning

Every solved problem gets written to `.claude/hive-learnings.md` in the project. The next agent that works on that project reads it before starting. Over time, the system accumulates project-specific knowledge that no fresh agent could replicate: debugging patterns, style corrections, architectural decisions.

Agents search learnings by keyword (`/api/learnings?q=keyword`) instead of reading everything, so it scales to hundreds of entries.

### Push Notifications

Two channels, zero setup:

- **macOS desktop**: Native notification when an agent goes stuck (yellow). 60-second cooldown per agent.
- **Web Push (iOS/Android/browser)**: Notification when an agent finishes (green to red). 15-second cooldown. Tap the bell icon on the dashboard to subscribe.

### Review Queue

Auto-detects `git push`, `gh pr create`, and Vercel deploys across all agents. A slide-out drawer on the dashboard shows recent changes with timestamps and links.

### Multiplayer

Invite collaborators to the same dashboard:

- **Admin**: Full control (spawn, kill, message, manage users)
- **Operator**: Can message agents and manage tasks
- **Viewer**: Read-only dashboard access

Live presence shows who is watching. Message attribution shows who sent what. An activity feed broadcasts human actions to all connected users.

### Custom Agents

Add any terminal agent by creating `~/.hive/agents.json`:

```json
[
  {
    "id": "aider",
    "label": "Aider",
    "processPattern": "aider",
    "spawnCommand": "aider"
  }
]
```

The daemon watches this file and reloads on change. No restart needed.

---

## Best Practices

### Assign by Complexity, Not by File

Give your hardest task to the top tile where you can keep an eye on it. Put independent tasks in lower tiles where they can run unattended longest. The top of the stack is your attention, the bottom is your trust.

### Use Models for What They Are Good At

Claude for architecture, planning, and complex refactors. Codex for fast edits, test writing, and code review. Run one model to audit what another built. The bugs that slip past three instances of the same model often get caught by a different one.

### Bridge Context, Do Not Repeat It

When one agent discovers something another needs, tap the other tile and paste the finding. Or use the scratchpad (`POST /api/scratchpad`) so any agent can read it. Do not re-explain things agents already know from their project's learning file.

### Let Auto-Pilot Run

Grant the accessibility permission. Without it, agents pause on every permission prompt until you manually approve. With it, they keep moving and only surface genuinely stuck situations. The 3-second grace window means you can still intervene from the dashboard if needed.

### Use Workflow Handoffs for Sequences

If you know the order (build API, then build UI, then write tests), queue all the steps with `workflowId` and `blockedBy`. The system carries structured context forward, verifies git state between steps, and you do not have to babysit transitions.

### Phone-First Monitoring

Install the dashboard as a PWA on your phone. Enable push notifications. Walk away. The agents keep running on your machine. Your phone buzzes when something finishes or needs you. Most of the time you come back and things are done.

### Write Learnings

After solving anything non-obvious, have the agent write a learning via `POST /api/learning`. The next agent that works on that project benefits from it. This compounds over weeks and months.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Agents not showing up | Make sure the daemon is running. Check hooks: `cat ~/.claude/settings.json \| grep hooks`. Wait 3 seconds. |
| Auto-pilot not working | Grant Accessibility permission to `~/send-return`. Test: run `~/send-return` and it should send a Return keystroke. |
| "Connection refused" | Daemon must be running on port 3001. Check: `lsof -i :3001` |
| Stale data after restart | Normal for a few seconds. Send one prompt to each terminal and routing self-corrects. |
| Chat in wrong terminal | Send a prompt to each terminal to update marker files. Check: `ls ~/.hive/sessions/` |
| Hooks not reporting | Claude only. Re-run `bash setup-hooks.sh`. Test by using any tool in Claude and checking daemon logs. |
| Runtime drift | Run `npm run doctor` to diagnose and repair. |

---

## Quick Reference

| What | Where |
|------|-------|
| Auth token | `~/.hive/token` |
| Daemon API | `http://localhost:3001` |
| WebSocket | `ws://localhost:3002` |
| Agent config | `~/.hive/agents.json` |
| Machine capabilities | `~/.hive/capabilities.json` |
| Notification config | `~/.hive/notifications.json` |
| Daemon state | `~/.hive/daemon-state.json` |
| Session markers | `~/.hive/sessions/` |
| Project learnings | `.claude/hive-learnings.md` |

---

Built by [Rohit Mangtani](https://rohitmangtani.com). See the [README](../README.md) for the full API reference.

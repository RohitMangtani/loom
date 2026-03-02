# Hive

Run 4 Claude Code agents at once. Coordinate them from your phone.

Hive is a local daemon that auto-discovers running Claude Code instances, tracks whether each one is working or idle, and gives you a live dashboard to monitor and message all of them. You open 4 terminals, run `claude` in each, and the daemon handles the rest — auto-approving prompts, preventing file conflicts, and compounding learnings across agents and sessions.

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

That's it. The script installs dependencies, compiles the auto-pilot binary, and wires up Claude Code hooks.

## Running

You need 3 things running:

**1. Daemon** (coordinates everything)
```bash
npm run dev:daemon
```

**2. Dashboard** (in a new terminal)
```bash
npm run dev:dashboard
```

**3. Agents** (open 4 Terminal.app tabs, run `claude` in each)

The daemon auto-discovers agents within 3 seconds. The dashboard shows their status at `localhost:3000`.

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

Each agent gets a quadrant number based on when it started (earliest = Q1). The dashboard mirrors this layout.

**Second screen as a stoplight:** Put the dashboard on a phone, tablet, or second monitor. Each agent card is a stoplight — green means working, red means idle, yellow means stuck waiting for input. You manage a fleet of AI workers by glancing at colors and tapping messages.

## What It Does

**Auto-discovery** — Detects Claude processes within 3 seconds. No configuration.

**Status tracking** — Three-layer detection pipeline (hooks, JSONL analysis, CPU signal) determines real-time status. Green = working. Red = done. Yellow = needs input.

**Auto-pilot** — Auto-approves permission prompts so agents never sit idle. 3-second grace window lets you override from the dashboard.

**Coordination** — File locks, conflict detection, shared scratchpad, inter-agent messaging, and a global task queue. Multiple agents can safely work the same codebase.

**Compound learning** — Every solved problem gets written to a per-project knowledge file. The next agent that works on that project reads it automatically. The system gets smarter with every session.

## How This Helps

This was built using the agents it manages. Four Claude Code instances iterated on the daemon and dashboard simultaneously while a human directed architecture and resolved conflicts.

- [Project page](https://www.rohitmangtani.com/lab/hive) — Full writeup on why this matters

## Architecture

```
Daemon (Node.js, port 3001 + 3002)
├── Auto-discovery — finds Claude processes via ps + lsof
├── Telemetry — receives hook events, maintains worker state
├── Auto-pilot — detects stuck prompts, auto-approves
├── Task queue — global work queue, auto-dispatches to idle agents
├── Coordination — locks, scratchpad, conflict detection, learnings
└── WebSocket — pushes live state to dashboard

Dashboard (Next.js, port 3000)
├── 2x2 agent grid — stoplight status cards
├── Live chat — stream each agent's conversation
└── Controls — send messages, spawn agents, view learnings
```

## License

MIT

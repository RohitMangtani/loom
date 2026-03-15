# Loom Dashboard

Next.js frontend for the Loom daemon. Shows a 2×2 grid of agent status cards with live chat, messaging, and spawn controls.

## Running

From the project root:
```bash
npm run dev:dashboard
```

Opens at `localhost:3000`. Requires the daemon running on port 3001/3002.

## Components

| Component | Purpose |
|-----------|---------|
| `AgentCard` | Stoplight card showing status, current action, and time |
| `ChatPanel` | Live conversation stream + message input |
| `SpawnDialog` | Spawn a new agent with a task prompt |
| `SitePasswordGate` | Viewer/Admin authentication toggle |

## Remote Access

The supported hosted flow is:

```bash
npm start
npm run deploy:dashboard
```

`npm start` creates a Cloudflare quick tunnel for the local WebSocket server and writes the public URL to `~/.hive/tunnel-url.txt`. `npm run deploy:dashboard` deploys this app to your Vercel account with that tunnel URL as `NEXT_PUBLIC_WS_URL`.

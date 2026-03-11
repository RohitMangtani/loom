#!/usr/bin/env bash
# identity.sh — UserPromptSubmit command hook for Claude Code.
# Writes TTY→session markers for restart-safe routing and prints a short
# identity/peer summary so the active worker sees the fleet state each prompt.

INPUT=$(cat)
DAEMON_URL="${HIVE_DAEMON_URL:-http://localhost:3001}"

# Extract session_id from the hook JSON payload.
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)

# stdin is a pipe, so walk up the process tree to find the owning TTY.
TTY_NAME=$(ps -o tty= -p "$PPID" 2>/dev/null | tr -d ' ')
if [ -z "$TTY_NAME" ] || [ "$TTY_NAME" = "??" ]; then
  GRANDPARENT=$(ps -o ppid= -p "$PPID" 2>/dev/null | tr -d ' ')
  [ -n "$GRANDPARENT" ] && TTY_NAME=$(ps -o tty= -p "$GRANDPARENT" 2>/dev/null | tr -d ' ')
fi

[ -z "$TTY_NAME" ] || [ "$TTY_NAME" = "??" ] && exit 0

if [ -n "$SESSION_ID" ]; then
  mkdir -p "$HOME/.hive/sessions" 2>/dev/null
  echo "$SESSION_ID" > "$HOME/.hive/sessions/$TTY_NAME"

  TOKEN=$(cat "$HOME/.hive/token" 2>/dev/null | tr -d '\n')
  if [ -n "$TOKEN" ]; then
    curl -s -X POST "${DAEMON_URL}/api/register-tty?token=${TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"session_id\":\"$SESSION_ID\",\"tty\":\"$TTY_NAME\"}" >/dev/null 2>&1 &
  fi
fi

WORKERS="$HOME/.hive/workers.json"
[ ! -f "$WORKERS" ] && exit 0

python3 -c "
import json, sys
try:
    with open('$WORKERS') as f:
        data = json.load(f)
    me = None
    peers = []
    for w in data.get('workers', []):
        if w.get('tty') == '$TTY_NAME':
            me = w
        else:
            peers.append(w)
    if not me:
        sys.exit(0)
    q = me.get('quadrant', '?')
    proj = me.get('projectName', '?')
    line = f'You are Q{q} ({me.get(\"tty\", \"?\")}, {proj})'
    if peers:
        parts = []
        for p in sorted(peers, key=lambda x: x.get('quadrant', 99)):
            pq = p.get('quadrant', '?')
            st = p.get('status', '?')
            act = (p.get('currentAction') or p.get('lastAction') or '')[:40]
            pproj = p.get('projectName', '?')
            parts.append(f'Q{pq} {st} {pproj}: {act}' if act else f'Q{pq} {st} {pproj}')
        line += '\nPeers: ' + ' | '.join(parts)
    print(line)
except Exception:
    pass
"

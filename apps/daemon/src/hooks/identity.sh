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
import json, os, sys
LOCAL_MACHINE = os.uname().nodename

def machine_label(worker):
    label = worker.get('machineLabel')
    if label:
        return label
    machine = worker.get('machine')
    if not machine or machine == 'local':
        return LOCAL_MACHINE
    return machine

def project_path(worker):
    return worker.get('project') or worker.get('projectName', '?')

try:
    with open('$WORKERS') as f:
        data = json.load(f)
    me = None
    fallback_me = None
    peers = []
    for w in data.get('workers', []):
        if w.get('tty') == '$TTY_NAME':
            if fallback_me is None:
                fallback_me = w
            machine = w.get('machine')
            label = w.get('machineLabel')
            if not machine or machine == 'local' or label == LOCAL_MACHINE:
                me = w
        else:
            peers.append(w)
    if me is None:
        me = fallback_me
    if not me:
        sys.exit(0)
    peers = [p for p in data.get('workers', []) if p is not me]
    q = me.get('quadrant', '?')
    tty = me.get('tty', '?')
    model = me.get('model', 'claude')
    line = f'You are Q{q} ({tty}, {model}) @{machine_label(me)} [{project_path(me)}]'
    if peers:
        parts = []
        for p in sorted(peers, key=lambda x: x.get('quadrant', 99)):
            pq = p.get('quadrant', '?')
            st = p.get('status', '?')
            act = (p.get('currentAction') or p.get('lastAction') or '')[:40]
            pproj = p.get('projectName', '?')
            pmodel = p.get('model', 'claude')
            tag = f'[{pmodel}] ' if pmodel != 'claude' else ''
            summary = f'Q{pq} {tag}{st} @{machine_label(p)} {pproj} [{project_path(p)}]'
            parts.append(f'{summary}: {act}' if act else summary)
        line += '\nPeers: ' + ' | '.join(parts)
    print(line)
except Exception:
    pass
"

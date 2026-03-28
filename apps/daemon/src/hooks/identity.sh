#!/usr/bin/env bash
# identity.sh — UserPromptSubmit command hook for Claude Code.
# Writes TTY→session markers for restart-safe routing and prints a short
# identity/peer summary so the active worker sees the fleet state each prompt.

INPUT=$(cat)
DAEMON_URL="${HIVE_DAEMON_URL:-http://localhost:3001}"

# Auto-start the Hive daemon if it is not running.
# On macOS, launchd handles this. On Windows/Linux, the satellite bat or
# systemd service may not be active (e.g., after reboot without login,
# or if Task Scheduler registration failed). This ensures Claude agents
# always connect to Hive without the user needing to manually start it.
if ! curl -s --connect-timeout 1 "${DAEMON_URL}/health" >/dev/null 2>&1; then
  HIVE_DIR="$HOME/.hive"
  if [ -f "$HIVE_DIR/satellite.bat" ] && command -v cmd.exe &>/dev/null; then
    # Windows: start the restart-loop bat in the background
    cmd.exe /c start /min "" "$HIVE_DIR\\satellite.bat" &>/dev/null &
  elif [ -f "$HOME/Library/LaunchAgents/com.hive.satellite.plist" ]; then
    # macOS: bootstrap the launchd plist if not loaded
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.hive.satellite.plist" 2>/dev/null
    launchctl kickstart "gui/$(id -u)/com.hive.satellite" 2>/dev/null
  elif [ -f "$HOME/Library/LaunchAgents/com.hive.daemon.plist" ]; then
    # macOS primary: bootstrap the daemon plist
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.hive.daemon.plist" 2>/dev/null
    launchctl kickstart "gui/$(id -u)/com.hive.daemon" 2>/dev/null
  elif systemctl --user is-enabled hive-satellite &>/dev/null 2>&1; then
    # Linux: start the systemd user service
    systemctl --user start hive-satellite 2>/dev/null
  fi
fi

# Extract session_id from the hook JSON payload.
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)

# stdin is a pipe, so walk up the process tree to find the owning TTY.
# On Windows (Git Bash/MSYS2), ps may not support -o tty=. Use PID fallback.
if command -v ps &>/dev/null && ps -o tty= -p 1 &>/dev/null 2>&1; then
  TTY_NAME=$(ps -o tty= -p "$PPID" 2>/dev/null | tr -d ' ')
  if [ -z "$TTY_NAME" ] || [ "$TTY_NAME" = "??" ]; then
    GRANDPARENT=$(ps -o ppid= -p "$PPID" 2>/dev/null | tr -d ' ')
    [ -n "$GRANDPARENT" ] && TTY_NAME=$(ps -o tty= -p "$GRANDPARENT" 2>/dev/null | tr -d ' ')
  fi
else
  # Windows fallback: use PID as TTY identifier (matches platform/windows discovery)
  TTY_NAME="pid:$PPID"
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

# ── Windows inbox: file-based message delivery ──────────────────────────
# On Windows, the satellite daemon can't inject text into Windows Terminal
# from a background process (no reliable Win32 API). Instead it writes
# messages to ~/.hive/inbox/pid_{PID}.msg. This hook reads the inbox on
# every UserPromptSubmit and outputs the message as additionalContext so
# the agent processes it on its next turn.
INBOX_MSG=""
if [ -d "$HOME/.hive/inbox" ]; then
  # Use the TTY_NAME we already resolved (pid:NNNNN on Windows)
  _INBOX_PID=""
  case "$TTY_NAME" in
    pid:*) _INBOX_PID="${TTY_NAME#pid:}" ;;
  esac
  if [ -n "$_INBOX_PID" ]; then
    _MSG_FILE="$HOME/.hive/inbox/pid_${_INBOX_PID}.msg"
    if [ -f "$_MSG_FILE" ]; then
      INBOX_MSG=$(cat "$_MSG_FILE" 2>/dev/null)
      rm -f "$_MSG_FILE" 2>/dev/null
    fi
    # Clean up keystroke files too (handled at the tool-call level by auto-approve)
    _KEY_FILE="$HOME/.hive/inbox/pid_${_INBOX_PID}.key"
    [ -f "$_KEY_FILE" ] && rm -f "$_KEY_FILE" 2>/dev/null
  fi
fi

WORKERS="$HOME/.hive/workers.json"
[ ! -f "$WORKERS" ] && exit 0

python3 -c "
import json, os, sys, platform
try:
    LOCAL_MACHINE = os.uname().nodename
except AttributeError:
    LOCAL_MACHINE = platform.node()

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

# Append inbox message after the identity/peer summary so it appears in
# the same system-reminder block. The agent sees this as a routed task.
if [ -n "$INBOX_MSG" ]; then
  echo ""
  echo "--- Hive Inbox Message (process this as a routed task) ---"
  echo "$INBOX_MSG"
  echo "--- End Hive Inbox Message ---"
fi

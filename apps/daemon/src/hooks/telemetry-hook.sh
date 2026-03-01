#!/usr/bin/env bash
# Hive telemetry hook — receives JSON from Claude Code hooks on stdin,
# extracts tool_name and summary, POSTs to the daemon's telemetry endpoint.
# Fire-and-forget: always exits 0 so it never blocks Claude Code.

set -e

DAEMON_URL="${HIVE_DAEMON_URL:-http://localhost:3001}"
WORKER_ID="${HIVE_WORKER_ID:-unknown}"
HOOK_EVENT="${HIVE_HOOK_EVENT:-unknown}"

# Read stdin (JSON from Claude Code hook system)
INPUT=$(cat)

# Extract tool_name from the hook JSON (if present)
TOOL_NAME=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_name', d.get('tool', {}).get('name', '')))
except:
    print('')
" 2>/dev/null || echo "")

# Build a short summary
SUMMARY=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    # Try to extract a meaningful summary
    if 'output' in d:
        s = str(d['output'])[:120]
    elif 'result' in d:
        s = str(d['result'])[:120]
    elif 'message' in d:
        s = str(d['message'])[:120]
    else:
        s = ''
    print(s)
except:
    print('')
" 2>/dev/null || echo "")

TIMESTAMP=$(python3 -c "import time; print(int(time.time() * 1000))" 2>/dev/null || echo "0")

# POST telemetry event (fire-and-forget in background)
curl -s -X POST "${DAEMON_URL}/telemetry" \
  -H "Content-Type: application/json" \
  -d "{
    \"worker_id\": \"${WORKER_ID}\",
    \"session_id\": \"${WORKER_ID}\",
    \"event\": \"${HOOK_EVENT}\",
    \"tool_name\": \"${TOOL_NAME}\",
    \"summary\": \"${SUMMARY}\",
    \"timestamp\": ${TIMESTAMP}
  }" >/dev/null 2>&1 &

exit 0

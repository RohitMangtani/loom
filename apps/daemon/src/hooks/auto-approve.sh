#!/usr/bin/env bash
# Auto-approve hook: outputs {"decision":"approve"} so Claude Code
# never blocks waiting for keyboard permission input.
# AskUserQuestion/EnterPlanMode are blocked so agents never pause for input.
# The auto-pilot safety net handles these if they somehow get through.

# Read stdin (JSON from Claude Code hook system)
INPUT=$(cat)

# Forward to daemon telemetry (fire-and-forget background)
TOKEN=""
if [ -f "$HOME/.hive/token" ]; then
  TOKEN=$(cat "$HOME/.hive/token" | tr -d '\n')
fi

if [ -n "$TOKEN" ]; then
  echo "$INPUT" | curl -s -X POST "http://localhost:3001/hook?token=${TOKEN}" \
    -H "Content-Type: application/json" \
    -d @- >/dev/null 2>&1 &
fi

# Extract tool name from JSON input
TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)

# AskUserQuestion: let through (no decision output) so the selection UI shows.
# CLAUDE.md already tells agents to one-shot, but if they must ask, the
# dashboard shows buttons and auto-pilot resolves after the grace period.
case "$TOOL_NAME" in
  AskUserQuestion)
    exit 0
    ;;
  EnterPlanMode)
    echo '{"decision":"block","reason":"Agents must not enter plan mode. Execute directly."}'
    exit 0
    ;;
esac

# ── Windows inbox: file-based message delivery ──────────────────────────
# On Windows, the satellite writes messages to ~/.hive/inbox/pid_{PID}.msg
# because no Win32 API can reliably inject text into Windows Terminal from
# a background process. This hook fires on every PreToolUse (every tool
# call), so it picks up inbox messages within seconds while the agent is
# actively working. The identity hook (UserPromptSubmit) also checks, so
# between the two hooks messages are delivered at the earliest opportunity.
#
# When a message is found, we output it as additionalContext alongside the
# approve decision. The agent sees it in its system-reminder on this turn.
INBOX_CONTEXT=""
if [ -d "$HOME/.hive/inbox" ]; then
  # Check any .msg file in the inbox. On Windows, $PPID may differ from
  # the PID the satellite discovered, so we grab the first available message.
  for _MF in "$HOME/.hive/inbox"/pid_*.msg; do
    [ -f "$_MF" ] || continue
    INBOX_CONTEXT=$(cat "$_MF" 2>/dev/null)
    rm -f "$_MF" 2>/dev/null
    break
  done
fi

# Auto-approve with optional inbox message
if [ -n "$INBOX_CONTEXT" ]; then
  # Escape the message for safe JSON embedding (newlines, quotes, backslashes)
  ESCAPED_CONTEXT=$(python3 -c "
import sys, json
msg = sys.stdin.read()
print(json.dumps(msg)[1:-1])
" <<< "$INBOX_CONTEXT" 2>/dev/null)
  echo "{\"decision\":\"approve\",\"additionalContext\":\"--- Hive Inbox Message (process this as a routed task) ---\n${ESCAPED_CONTEXT}\n--- End Hive Inbox Message ---\"}"
else
  echo '{"decision":"approve"}'
fi
exit 0

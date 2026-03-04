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

# Auto-approve everything else
echo '{"decision":"approve"}'
exit 0

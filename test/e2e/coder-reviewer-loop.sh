#!/bin/bash
# ============================================================
# E2E Test: Coder-Reviewer Loop with Nexus IPC
# ============================================================
#
# Tests the full multi-turn review loop with all data in Nexus:
#   1. Coder writes code → grove_submit_work (stored in Nexus VFS)
#   2. IPC routes to reviewer via Nexus SSE
#   3. Reviewer reviews → grove_submit_review (NOT grove_done)
#   4. IPC routes back to coder
#   5. Coder fixes → grove_submit_work
#   6. IPC routes to reviewer again
#   7. Reviewer approves → grove_submit_review + grove_done
#   8. New task sent to coder after done
#   9. Session tracks all contributions
#
# Usage:
#   NEXUS_URL=http://localhost:40970 NEXUS_API_KEY=sk-... bash test/e2e/coder-reviewer-loop.sh
# ============================================================

set -euo pipefail

GROVE_SRC="$(cd "$(dirname "$0")/../.." && pwd)"
GROVE_DIR="/tmp/grove-e2e/.grove"
MCP_SERVE="$GROVE_SRC/src/mcp/serve.ts"
NEXUS_URL="${NEXUS_URL:?Set NEXUS_URL}"
NEXUS_API_KEY="${NEXUS_API_KEY:?Set NEXUS_API_KEY}"
export GROVE_NEXUS_URL="$NEXUS_URL"
SERVER_URL="http://localhost:4515"

PASS=0
FAIL=0
assert() {
  local desc="$1" cond="$2"
  if eval "$cond"; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    FAIL=$((FAIL + 1))
  fi
}

# Query contributions via HTTP API (reads from Nexus)
count_contributions() {
  local kind="${1:-}"
  local url="$SERVER_URL/api/contributions"
  [ -n "$kind" ] && url="$url?kind=$kind"
  curl -sf "$url" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0"
}

get_latest_summary() {
  local kind="${1:-}"
  local url="$SERVER_URL/api/contributions"
  [ -n "$kind" ] && url="$url?kind=$kind"
  curl -sf "$url" 2>/dev/null | python3 -c "
import sys,json
data = json.load(sys.stdin)
if data: print(data[-1]['summary'][:200])
else: print('')
" 2>/dev/null || echo ""
}

has_done_from() {
  local role="$1"
  curl -sf "$SERVER_URL/api/contributions?kind=discussion" 2>/dev/null | python3 -c "
import sys,json
data = json.load(sys.stdin)
found = any(c.get('agent',{}).get('role')=='"$role"' and '[DONE]' in c.get('summary','') for c in data)
print('1' if found else '0')
" 2>/dev/null || echo "0"
}

cleanup() {
  kill $SSE_REVIEWER_PID $SSE_CODER_PID 2>/dev/null || true
  # Don't kill bun — server might be needed after test
  for s in grove-e2e-coder grove-e2e-reviewer; do
    acpx codex sessions close "$s" 2>/dev/null || true
  done
}
trap cleanup EXIT

echo "=== E2E: Coder-Reviewer Loop (Nexus stores) ==="
echo "Nexus: $NEXUS_URL"
echo ""

# --- Clean slate ---
echo "[setup] Cleaning..."
killall bun 2>/dev/null || true
sleep 2
sqlite3 "$GROVE_DIR/grove.db" "DELETE FROM session_contributions; DELETE FROM sessions;" 2>/dev/null
rm -rf "$GROVE_DIR/workspaces" "$GROVE_DIR/agent-logs" 2>/dev/null
mkdir -p "$GROVE_DIR/workspaces" "$GROVE_DIR/agent-logs"

for s in grove-e2e-coder grove-e2e-reviewer; do
  acpx codex sessions close "$s" 2>/dev/null || true
done

# Provision agents in Nexus
for role in coder reviewer; do
  curl -sf -X POST "$NEXUS_URL/api/v2/agents/register" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $NEXUS_API_KEY" \
    -d "{\"agent_id\":\"$role\",\"name\":\"$role\",\"capabilities\":[\"$role\"]}" > /dev/null 2>&1 || true
done

# Start server (reads from Nexus)
cd /tmp/grove-e2e
GROVE_DIR="$GROVE_DIR" GROVE_NEXUS_URL="$NEXUS_URL" NEXUS_API_KEY="$NEXUS_API_KEY" \
  bun "$GROVE_SRC/src/server/serve.ts" &>/dev/null &
sleep 4

# Verify server uses Nexus
assert "server is up" 'curl -sf "$SERVER_URL/api/contributions" >/dev/null 2>&1'

# Record initial contribution count (Nexus may have old data)
INITIAL_WORK=$(count_contributions work)
INITIAL_REVIEW=$(count_contributions review)
INITIAL_DONE=$(count_contributions discussion)

# Create session
SESSION_ID=$(curl -sf -X POST "$SERVER_URL/api/sessions" \
  -H "Content-Type: application/json" \
  -d '{"goal":"Create utils/math.ts with fibonacci and isPrime"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['sessionId'])")
echo "[setup] Session: $SESSION_ID"

# --- Create workspaces ---
cd /tmp/grove-e2e
git worktree prune 2>/dev/null
git branch -D grove/e2e/coder grove/e2e/reviewer 2>/dev/null || true
git worktree add .grove/workspaces/coder -b grove/e2e/coder HEAD 2>/dev/null
git worktree add .grove/workspaces/reviewer -b grove/e2e/reviewer HEAD 2>/dev/null

for role in coder reviewer; do
  cat > .grove/workspaces/$role/.mcp.json << EOF
{"mcpServers":{"grove":{"command":"bun","args":["run","$MCP_SERVE"],"env":{"GROVE_DIR":"$GROVE_DIR","GROVE_AGENT_ROLE":"$role","GROVE_NEXUS_URL":"$NEXUS_URL","NEXUS_API_KEY":"$NEXUS_API_KEY"}}}}
EOF
  cat > .grove/workspaces/$role/CODEX.md << EOF
# Grove Agent: $role
## MCP Tools
- grove_submit_work — REQUIRED after code changes. grove_submit_work({ summary: "...", artifacts: {...}, agent: { role: "$role" } })
- grove_submit_review — REQUIRED after reviews. grove_submit_review({ targetCid: "...", summary: "...", scores: {...}, agent: { role: "$role" } })
- grove_done — ONLY call when the ENTIRE task is complete (reviewer approved). Do NOT call after each round.
EOF
done

codex mcp remove grove-e2e-coder 2>/dev/null || true
codex mcp remove grove-e2e-reviewer 2>/dev/null || true
codex mcp add grove-e2e-coder --env "GROVE_DIR=$GROVE_DIR" --env "GROVE_AGENT_ROLE=coder" --env "GROVE_NEXUS_URL=$NEXUS_URL" --env "NEXUS_API_KEY=$NEXUS_API_KEY" -- bun run "$MCP_SERVE" 2>/dev/null
codex mcp add grove-e2e-reviewer --env "GROVE_DIR=$GROVE_DIR" --env "GROVE_AGENT_ROLE=reviewer" --env "GROVE_NEXUS_URL=$NEXUS_URL" --env "NEXUS_API_KEY=$NEXUS_API_KEY" -- bun run "$MCP_SERVE" 2>/dev/null

cd .grove/workspaces/coder
acpx --approve-all codex sessions new --name grove-e2e-coder >/dev/null 2>&1
acpx --approve-all codex set-mode full-access -s grove-e2e-coder >/dev/null 2>&1
cd /tmp/grove-e2e/.grove/workspaces/reviewer
acpx --approve-all codex sessions new --name grove-e2e-reviewer >/dev/null 2>&1
acpx --approve-all codex set-mode full-access -s grove-e2e-reviewer >/dev/null 2>&1

curl -s -N -H "Authorization: Bearer $NEXUS_API_KEY" \
  "$NEXUS_URL/api/v2/ipc/stream/reviewer" > /tmp/sse-reviewer-e2e.txt 2>&1 &
SSE_REVIEWER_PID=$!
curl -s -N -H "Authorization: Bearer $NEXUS_API_KEY" \
  "$NEXUS_URL/api/v2/ipc/stream/coder" > /tmp/sse-coder-e2e.txt 2>&1 &
SSE_CODER_PID=$!
sleep 3

echo "[setup] Done"
echo ""

# === ROUND 1: Coder implements ===
echo "[round 1] Coder implementing..."
cd /tmp/grove-e2e/.grove/workspaces/coder
acpx --approve-all codex -s grove-e2e-coder '<system-reminder>
You MUST call grove_submit_work after work. Do NOT call grove_done yet — wait for reviewer approval.
</system-reminder>
Create utils/math.ts with fibonacci(n) and isPrime(n). Use Number.isSafeInteger validation. Add JSDoc. Call grove_submit_work when done writing code. Do NOT call grove_done.' \
  &>"$GROVE_DIR/agent-logs/r1-coder.log" &

for i in $(seq 1 30); do
  sleep 5
  [ "$(count_contributions work)" -gt "$INITIAL_WORK" ] && break
done

echo "[round 1] Assertions:"
assert "coder contributed work" '[ "$(count_contributions work)" -gt "$INITIAL_WORK" ]'
assert "coder did NOT call grove_done" '[ "$(has_done_from coder)" -eq 0 ]'
assert "utils/math.ts exists" '[ -f /tmp/grove-e2e/.grove/workspaces/coder/utils/math.ts ]'
echo ""

# === IPC: coder → reviewer via Nexus ===
echo "[ipc] Routing coder → reviewer via Nexus..."
SUMMARY=$(get_latest_summary work)
IPC_RESULT=$(curl -sf -X POST "$NEXUS_URL/api/v2/ipc/send" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $NEXUS_API_KEY" \
  -d "{\"sender\":\"coder\",\"recipient\":\"reviewer\",\"type\":\"event\",\"payload\":{\"summary\":\"$(echo "$SUMMARY" | head -c 200)\",\"kind\":\"work\"}}")
MSG_ID=$(echo "$IPC_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message_id',''))" 2>/dev/null)

sleep 2
assert "Nexus IPC send succeeded" '[ -n "$MSG_ID" ]'
assert "SSE delivered to reviewer" 'grep -q "message_delivered.*$MSG_ID" /tmp/sse-reviewer-e2e.txt 2>/dev/null'

rsync -a --exclude='.git' --exclude='.mcp.json' --exclude='CODEX.md' \
  /tmp/grove-e2e/.grove/workspaces/coder/ /tmp/grove-e2e/.grove/workspaces/reviewer/
echo ""

# === ROUND 2: Reviewer reviews ===
echo "[round 2] Reviewer reviewing..."
cd /tmp/grove-e2e/.grove/workspaces/reviewer
acpx --approve-all codex -s grove-e2e-reviewer "<system-reminder>
Call grove_submit_review with targetCid and scores. Do NOT call grove_done yet.
</system-reminder>
[IPC from coder] New work: $SUMMARY
Review utils/math.ts. Call grove_submit_review with your review and scores. Do NOT call grove_done." \
  &>"$GROVE_DIR/agent-logs/r2-reviewer.log" &

for i in $(seq 1 30); do
  sleep 5
  [ "$(count_contributions review)" -gt "$INITIAL_REVIEW" ] && break
done

echo "[round 2] Assertions:"
assert "reviewer contributed review" '[ "$(count_contributions review)" -gt "$INITIAL_REVIEW" ]'
assert "reviewer did NOT call grove_done" '[ "$(has_done_from reviewer)" -eq 0 ]'
echo ""

# === IPC: reviewer → coder via Nexus ===
echo "[ipc] Routing reviewer → coder via Nexus..."
REVIEW=$(get_latest_summary review)
IPC2=$(curl -sf -X POST "$NEXUS_URL/api/v2/ipc/send" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $NEXUS_API_KEY" \
  -d "{\"sender\":\"reviewer\",\"recipient\":\"coder\",\"type\":\"event\",\"payload\":{\"summary\":\"$(echo "$REVIEW" | head -c 200)\",\"kind\":\"review\"}}")
MSG_ID2=$(echo "$IPC2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message_id',''))" 2>/dev/null)

sleep 2
assert "Nexus IPC reviewer→coder succeeded" '[ -n "$MSG_ID2" ]'
assert "SSE delivered to coder" 'grep -q "message_delivered.*$MSG_ID2" /tmp/sse-coder-e2e.txt 2>/dev/null'

rsync -a --exclude='.git' --exclude='.mcp.json' --exclude='CODEX.md' \
  /tmp/grove-e2e/.grove/workspaces/reviewer/ /tmp/grove-e2e/.grove/workspaces/coder/
echo ""

# === ROUND 3: Coder fixes ===
echo "[round 3] Coder fixing..."
WORK_BEFORE=$(count_contributions work)
cd /tmp/grove-e2e/.grove/workspaces/coder
acpx --approve-all codex -s grove-e2e-coder "<system-reminder>
Call grove_submit_work after fixing. Do NOT call grove_done.
</system-reminder>
[IPC from reviewer] $(echo "$REVIEW" | head -c 200)
Fix the issues. Call grove_submit_work. Do NOT call grove_done." \
  &>"$GROVE_DIR/agent-logs/r3-coder.log" &

for i in $(seq 1 24); do
  sleep 5
  [ "$(count_contributions work)" -gt "$WORK_BEFORE" ] && break
done

echo "[round 3] Assertions:"
assert "coder contributed fix" '[ "$(count_contributions work)" -gt "$WORK_BEFORE" ]'
echo ""

# === IPC: coder fix → reviewer for final approval ===
echo "[ipc] Routing coder fix → reviewer..."
FIX=$(get_latest_summary work)
IPC3=$(curl -sf -X POST "$NEXUS_URL/api/v2/ipc/send" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $NEXUS_API_KEY" \
  -d "{\"sender\":\"coder\",\"recipient\":\"reviewer\",\"type\":\"event\",\"payload\":{\"summary\":\"$(echo "$FIX" | head -c 200)\",\"kind\":\"work\"}}")
MSG_ID3=$(echo "$IPC3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message_id',''))" 2>/dev/null)
assert "Nexus IPC coder fix→reviewer succeeded" '[ -n "$MSG_ID3" ]'

rsync -a --exclude='.git' --exclude='.mcp.json' --exclude='CODEX.md' \
  /tmp/grove-e2e/.grove/workspaces/coder/ /tmp/grove-e2e/.grove/workspaces/reviewer/
echo ""

# === ROUND 4: Reviewer approves + grove_done ===
echo "[round 4] Reviewer final review..."
REVIEW_BEFORE=$(count_contributions review)
cd /tmp/grove-e2e/.grove/workspaces/reviewer
acpx --approve-all codex -s grove-e2e-reviewer "<system-reminder>
If the fix is correct, call grove_submit_review with your approval and scores, then call grove_done.
</system-reminder>
[IPC from coder] Fix: $FIX
Re-review utils/math.ts. If correct, approve and call grove_done." \
  &>"$GROVE_DIR/agent-logs/r4-reviewer.log" &

for i in $(seq 1 30); do
  sleep 5
  [ "$(count_contributions review)" -gt "$REVIEW_BEFORE" ] && break
done
sleep 10  # Wait for grove_done

echo "[round 4] Assertions:"
assert "reviewer contributed final review" '[ "$(count_contributions review)" -gt "$REVIEW_BEFORE" ]'
assert "reviewer called grove_done (only now)" '[ "$(has_done_from reviewer)" -gt 0 ]'
echo ""

# === ROUND 5: New task after done ===
echo "[round 5] Sending new task to coder..."
WORK_BEFORE=$(count_contributions work)
cd /tmp/grove-e2e/.grove/workspaces/coder
acpx --approve-all codex -s grove-e2e-coder '<system-reminder>
Call grove_submit_work after work.
</system-reminder>
[New task] Add gcd(a,b) function to utils/math.ts. Call grove_submit_work when done.' \
  &>"$GROVE_DIR/agent-logs/r5-coder.log" &

for i in $(seq 1 24); do
  sleep 5
  [ "$(count_contributions work)" -gt "$WORK_BEFORE" ] && break
done

echo "[round 5] Assertions:"
assert "coder contributed new work" '[ "$(count_contributions work)" -gt "$WORK_BEFORE" ]'
assert "gcd function exists" 'grep -q "function gcd" /tmp/grove-e2e/.grove/workspaces/coder/utils/math.ts 2>/dev/null'
echo ""

# === Verify data in Nexus VFS ===
echo "[nexus] Verifying data in Nexus VFS..."
NEXUS_FILES=$(curl -sf -X POST "$NEXUS_URL/api/nfs/sys_readdir" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $NEXUS_API_KEY" \
  -d '{"jsonrpc":"2.0","method":"sys_readdir","params":{"path":"/zones/default/contributions/"},"id":1}' | python3 -c "
import sys,json
d = json.load(sys.stdin)
files = [f for f in d.get('result',{}).get('files',[]) if 'blake3' in f]
print(len(files))
" 2>/dev/null)
assert "contributions stored in Nexus VFS" '[ "$NEXUS_FILES" -gt 3 ]'
echo ""

# === Final summary ===
echo "=========================================="
echo "=== CONTRIBUTION HISTORY (from server) ==="
curl -sf "$SERVER_URL/api/contributions" | python3 -c "
import sys,json
for i, c in enumerate(json.load(sys.stdin)):
  role = c.get('agent',{}).get('role','?')
  print(f'  {i+1}. [{role}] {c[\"kind\"]}: {c[\"summary\"][:75]}')
"
echo ""

echo "=== NEXUS IPC ==="
echo "Reviewer inbox: $(curl -sf "$NEXUS_URL/api/v2/ipc/inbox/reviewer/count" -H "Authorization: Bearer $NEXUS_API_KEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['count'])" 2>/dev/null)"
echo "Coder inbox: $(curl -sf "$NEXUS_URL/api/v2/ipc/inbox/coder/count" -H "Authorization: Bearer $NEXUS_API_KEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['count'])" 2>/dev/null)"
echo "Reviewer SSE: $(grep -c 'message_delivered' /tmp/sse-reviewer-e2e.txt 2>/dev/null || echo 0)"
echo "Coder SSE: $(grep -c 'message_delivered' /tmp/sse-coder-e2e.txt 2>/dev/null || echo 0)"

echo ""
echo "=== NEXUS VFS ==="
echo "Contribution files: $NEXUS_FILES"

echo ""
echo "=========================================="
echo "PASSED: $PASS"
echo "FAILED: $FAIL"
echo "=========================================="

[ "$FAIL" -eq 0 ] && exit 0 || exit 1

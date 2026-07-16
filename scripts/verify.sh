#!/usr/bin/env bash
# Verification checklist executed end-to-end through the REST API with curl against a
# freshly seeded database. Exits non-zero on any failure. The full test suites run
# separately: `npm test` and `npm run test:e2e`.
set -u
cd "$(dirname "$0")/.."

PORT="${VERIFY_PORT:-3200}"
BASE="http://127.0.0.1:$PORT/api"
DB="data/verify.db"
PASS=0; FAIL=0
STATUS=""; BODY=""

req() { # method path [json-body] -> $STATUS, $BODY
  local method=$1 path=$2 data=${3:-}
  local out
  if [ -n "$data" ]; then
    out=$(curl -s -X "$method" "$BASE$path" -H 'content-type: application/json' -d "$data" -w $'\n%{http_code}')
  else
    out=$(curl -s -X "$method" "$BASE$path" -w $'\n%{http_code}')
  fi
  STATUS=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
  echo "    $method $path${data:+ $data} -> $STATUS"
}

field() { # JS expression evaluated against $BODY as j, e.g. '.state' or '.steps.length'
  printf '%s' "$BODY" | node -e '
    let d = "";
    process.stdin.on("data", (c) => d += c).on("end", () => {
      const j = JSON.parse(d);
      const v = Function("j", "return j" + process.argv[1])(j);
      console.log(typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    });' "$1"
}

assert_eq() { # actual expected description
  if [ "$1" = "$2" ]; then
    echo "  PASS: $3"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $3 — expected '$2', got '$1'"
    FAIL=$((FAIL + 1))
  fi
}

invariant_ok() { # description
  req GET /ledger/invariant
  assert_eq "$(field '.ok')" "true" "ledger invariant holds — $1"
}

echo "== 1. Fresh start: DB deleted, app starts, seed data loads =================="
rm -f "$DB" "$DB-wal" "$DB-shm"
DB_PATH="$DB" PORT="$PORT" node server.js >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
up=false
for _ in $(seq 1 60); do
  if curl -sf "$BASE/ledger/invariant" >/dev/null 2>&1; then up=true; break; fi
  sleep 0.25
done
assert_eq "$up" "true" "server started on port $PORT"
req GET /users
assert_eq "$(field '.agents[0].name')" "Realtor Assistant Agent" "seeded agent present"
assert_eq "$(field '.agents[0].balance_cents')" "5000000" "agent balance \$50,000"
assert_eq "$(field '.smbs.length >= 6')" "true" "at least 6 SMBs seeded"
assert_eq "$(field '.smbs.every((s) => s.vetted)')" "true" "all SMBs auto-vetted"
invariant_ok "after seeding"

echo "== 2. Search 'lawyer Costa Rica company hotel' returns Bufete Herrera ranked appropriately =="
req GET "/offers?q=lawyer+Costa+Rica+company+hotel"
assert_eq "$(field '.some((o) => o.smb.name === "Bufete Herrera & Asociados")')" "true" "Bufete Herrera's offer found"
assert_eq "$(field '[0].smb.name')" "LexCorp Legal Solutions" "pre-rating rank: LexCorp first (rating tie 2=2, cheaper)"
assert_eq "$(field '[1].smb.name')" "Bufete Herrera & Asociados" "pre-rating rank: Bufete second"
OFFER_ID=$(field '.find((o) => o.smb.name === "Bufete Herrera & Asociados").id')
BUFETE_ID=$(field '.find((o) => o.smb.name === "Bufete Herrera & Asociados").smb.id')

echo "== 3. Create engagement -> agreed; steps locked (modification must 4xx) ======"
req POST /engagements "{\"offer_id\": $OFFER_ID, \"agent_id\": 1}"
EID=$(field '.id')
STEP1=$(field '.steps[0].id')
assert_eq "$(field '.state')" "draft" "engagement created as draft"
assert_eq "$(field '.steps.length')" "4" "4 steps snapshotted"
req POST "/engagements/$EID/agree"
assert_eq "$(field '.state')" "agreed" "state agreed after handshake"
req PATCH "/engagements/$EID/steps/$STEP1" '{"title": "sneaky edit"}'
assert_eq "$STATUS" "409" "step modification after agreement rejected with 4xx"

echo "== 4. Fund 20% (\$1,000) -> funded; agent -\$1,000; escrow \$1,000 ============"
req POST "/engagements/$EID/fund"
assert_eq "$(field '.state')" "funded" "state funded"
assert_eq "$(field '.escrow_balance_cents')" "100000" "escrow holds \$1,000"
req GET /agents/1
assert_eq "$(field '.balance_cents')" "4900000" "agent balance decreased to \$49,000"
invariant_ok "after funding"

echo "== 5. Submit before completing steps -> 4xx ================================="
req POST "/engagements/$EID/submit"
assert_eq "$STATUS" "409" "premature submit rejected with 4xx"

echo "== 6. SMB completes all 4 steps with proofs -> in_progress -> submitted ======"
req GET "/engagements/$EID"
STEP_IDS=$(field '.steps.map((s) => s.id).join(" ")')
n=1
for sid in $STEP_IDS; do
  req POST "/engagements/$EID/steps/$sid/complete" "{\"proof_text\": \"Proof for step $n: filing receipt CR-$((1000 + n))\"}"
  n=$((n + 1))
done
assert_eq "$(field '.state')" "in_progress" "state in_progress while steps were being completed"
assert_eq "$(field '.steps_done')" "4" "all 4 steps done with proofs"
req POST "/engagements/$EID/submit"
assert_eq "$(field '.state')" "submitted" "state submitted"

echo "== 7. Approve -> remaining \$4,000 auto-drawn, SMB receives \$5,000, escrow 0; double release impossible =="
req POST "/engagements/$EID/approve"
assert_eq "$(field '.state')" "completed" "state completed"
assert_eq "$(field '.escrow_balance_cents')" "0" "escrow zeroed"
req GET /agents/1
assert_eq "$(field '.balance_cents')" "4500000" "agent balance \$45,000 (remaining \$4,000 drawn)"
req GET "/smbs/$BUFETE_ID"
assert_eq "$(field '.balance_cents')" "500000" "SMB received \$5,000 total"
req POST "/engagements/$EID/approve"
assert_eq "$STATUS" "409" "second approve/release attempt fails"
req GET "/smbs/$BUFETE_ID"
assert_eq "$(field '.balance_cents')" "500000" "no double payout"
invariant_ok "after settlement"

echo "== 8. Rate good -> aggregate updates and search reorders ====================="
req POST "/engagements/$EID/rate" '{"value": "good"}'
assert_eq "$STATUS" "201" "rating recorded"
req GET "/smbs/$BUFETE_ID"
assert_eq "$(field '.rating.good')" "4" "aggregate: 4 good"
assert_eq "$(field '.rating.score')" "3" "aggregate score now 3"
req GET "/offers?q=lawyer+Costa+Rica+company+hotel"
assert_eq "$(field '[0].smb.name')" "Bufete Herrera & Asociados" "Bufete now ranked first"

echo "== 9. Dispute path with second SMB: reject -> disputed; arbiter split -> resolved; balances correct =="
req GET "/offers?q=company+formation+costa+rica"
OFFER2=$(field '.find((o) => o.smb.name === "LexCorp Legal Solutions").id')
LEX_ID=$(field '.find((o) => o.smb.name === "LexCorp Legal Solutions").smb.id')
req POST /engagements "{\"offer_id\": $OFFER2, \"agent_id\": 1}"
EID2=$(field '.id')
req POST "/engagements/$EID2/agree"
req POST "/engagements/$EID2/fund"
assert_eq "$(field '.escrow_balance_cents')" "135000" "escrow holds \$1,350 (30% of \$4,500)"
req GET "/engagements/$EID2"
for sid in $(field '.steps.map((s) => s.id).join(" ")'); do
  req POST "/engagements/$EID2/steps/$sid/complete" '{"proof_text": "delivered"}'
done
req POST "/engagements/$EID2/submit"
req POST "/engagements/$EID2/reject" '{"reason": "Corporate books were never delivered."}'
assert_eq "$(field '.state')" "disputed" "state disputed after reject"
req POST "/engagements/$EID2/resolve" '{"ruling": "split"}'
assert_eq "$(field '.state')" "resolved" "state resolved after arbiter ruling"
assert_eq "$(field '.resolution')" "split" "ruling recorded as split"
req GET /agents/1
assert_eq "$(field '.balance_cents')" "4432500" "agent refunded \$675 (\$44,325 total)"
req GET "/smbs/$LEX_ID"
assert_eq "$(field '.balance_cents')" "67500" "LexCorp received \$675"
req POST "/engagements/$EID2/resolve" '{"ruling": "split"}'
assert_eq "$STATUS" "409" "double resolution rejected"

echo "== 10. Ledger invariant after every scenario ================================="
invariant_ok "after all scenarios"
req GET /ledger
assert_eq "$(field '.invariant.total_balances_cents')" "5000000" "total balances still exactly the \$50,000 minted"

echo ""
echo "================================================================="
echo "RESULT: $PASS passed, $FAIL failed"
if [ "$FAIL" = "0" ]; then
  echo "VERIFICATION: ALL CHECKS PASSED"
  exit 0
else
  echo "VERIFICATION: FAILURES PRESENT"
  exit 1
fi

#!/usr/bin/env bash
# Smoke-test the Chatwoot webhook route against a running gateway with mocked,
# Chatwoot-shaped payloads. Never contacts a real Chatwoot instance.
#
# Usage:
#   ./scripts/smoke-webhook.sh [--url https://127.0.0.1:18789] [--secret <s>] [--mode chatwoot|custom]
#
# Mode "custom" (default) signs the raw body into `x-openclaw-signature`.
# Mode "chatwoot" uses the native X-Chatwoot-Timestamp / X-Chatwoot-Signature
# scheme (sha256=HMAC(secret, "{ts}.{raw}")).
set -euo pipefail

URL="${SMOKE_URL:-http://127.0.0.1:18789}"
SECRET="${SMOKE_SECRET:-smoke-secret}"
MODE="${SMOKE_MODE:-custom}"
PATH="/chatwoot/webhook"
readonly EP="$URL$PATH"

require_node() {
  command -v node >/dev/null 2>&1 || { echo "node is required to compute HMAC signatures" >&2; exit 2; }
}

sign_custom() {
  node -e 'const c=require("crypto");process.stdout.write(c.createHmac("sha256",process.env.S).update(process.argv[1],"utf8").digest("hex"))' "$1"
}

sign_chatwoot() {
  node -e 'const c=require("crypto");const ts=Math.floor(Date.now()/1000);const s=c.createHmac("sha256",process.env.S).update(`${ts}.${process.argv[1]}`,"utf8").digest("hex");process.stdout.write(`${ts} sha256=${s}`)' "$1"
}

post() { # <body-json> [expected-action] [expected-reason]
  local body="$1" expected="${2:-}"
  local ts="" sig hdr
  if [ "$MODE" = "chatwoot" ]; then
    read -r ts sig < <(sign_chatwoot "$body")
    hdr=(-H "x-chatwoot-timestamp: $ts" -H "x-chatwoot-signature: $sig")
  else
    hdr=(-H "x-openclaw-signature: $(sign_custom "$body")")
  fi
  local out
  out=$(curl -s -m 90 -X POST "$EP" -H 'content-type: application/json' "${hdr[@]}" --data "$body") || {
    echo "FAIL: curl error for payload: $body" >&2; return 1; }
  echo "  -> $out"
  if [ -n "$expected" ]; then
    echo "$out" | grep -q "\"action\":\"$expected\"" || {
      echo "FAIL: expected action=$expected" >&2; return 1; }
  fi
}

smoke() {
  require_node

  echo "== unsigned request must be rejected (401) =="
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$EP" -H 'content-type: application/json' --data '{}')
  [ "$code" = "401" ] && echo "  -> 401 OK" || { echo "FAIL: expected 401, got $code" >&2; return 1; }

  local customer
  customer='{"event":"message_created","id":9001,"content":"Hello from a mocked customer","message_type":"incoming","private":false,"content_type":"text","conversation_id":55,"conversation":{"id":55,"status":"open"},"account":{"id":1},"sender":{"id":33,"name":"Mock Customer","type":"contact"}}'

  echo "== signed message_created is dispatched =="
  post "$customer" dispatched

  echo "== replaying the same message id is a duplicate =="
  post "$customer" duplicate

  local edited
  edited='{"event":"message_updated","id":9002,"content":"edited hello","message_type":"incoming","private":false,"content_type":"text","conversation_id":56,"conversation":{"id":56,"status":"open"},"account":{"id":1},"sender":{"id":33,"name":"Mock Customer","type":"contact"}}'
  echo "== message_updated is handled like message_created =="
  post "$edited" dispatched

  local conv
  conv='{"event":"conversation_updated","id":55,"status":"resolved","team_id":1,"account":{"id":1}}'
  echo "== conversation event with no active handoff is ignored =="
  post "$conv" ignored
}

smoke
echo "smoke-webhook: all checks passed ($MODE mode on $EP)"
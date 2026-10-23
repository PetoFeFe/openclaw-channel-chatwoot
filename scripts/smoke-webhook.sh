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
#
# Env:
#   SMOKE_URL              gateway base URL              (default http://127.0.0.1:18789)
#   SMOKE_SECRET           webhook shared secret         (default smoke-secret)
#   SMOKE_MODE             chatwoot | custom             (default custom)
#   SMOKE_ACCOUNT_ID       Chatwoot account id to use    (default 3)
#   SMOKE_CONVERSATION_ID  conversation id for dispatch  (default 55; use a real
#                          conversation for a true end-to-end delivery)
set -euo pipefail

URL="${SMOKE_URL:-http://127.0.0.1:18789}"
SECRET="${SMOKE_SECRET:-smoke-secret}"
# The node signer snippets read the secret from process.env.S.
export S="$SECRET"
MODE="${SMOKE_MODE:-custom}"
ACCOUNT_ID="${SMOKE_ACCOUNT_ID:-3}"
CONVERSATION_ID="${SMOKE_CONVERSATION_ID:-55}"
WRONG_ACCOUNT_ID=$((ACCOUNT_ID + 1000))
WEBHOOK_PATH="/chatwoot/webhook"
readonly EP="$URL$WEBHOOK_PATH"

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
    # Command substitution (not process substitution): `< <(...)` can stall in
    # minimal container shells where the subshell's stdout pipe is not reaped.
    local sigline
    sigline=$(sign_chatwoot "$body")
    ts="${sigline%% *}"
    sig="${sigline#* }"
    hdr=(-H "x-chatwoot-timestamp: $ts" -H "x-chatwoot-signature: $sig")
  else
    hdr=(-H "x-openclaw-signature: $(sign_custom "$body")")
  fi
  local out
  out=$(curl -s -m 180 -X POST "$EP" -H 'content-type: application/json' "${hdr[@]}" --data "$body") || {
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
  customer="{\"event\":\"message_created\",\"id\":9001,\"content\":\"Hello from a mocked customer\",\"message_type\":\"incoming\",\"private\":false,\"content_type\":\"text\",\"conversation_id\":${CONVERSATION_ID},\"conversation\":{\"id\":${CONVERSATION_ID},\"status\":\"open\"},\"account\":{\"id\":${ACCOUNT_ID}},\"sender\":{\"id\":33,\"name\":\"Mock Customer\",\"type\":\"contact\"}}"

  echo "== signed message_created is dispatched =="
  post "$customer" dispatched

  echo "== replaying the same message id is a duplicate =="
  post "$customer" duplicate

  local edited
  edited="{\"event\":\"message_updated\",\"id\":9002,\"content\":\"edited hello\",\"message_type\":\"incoming\",\"private\":false,\"content_type\":\"text\",\"conversation_id\":${CONVERSATION_ID},\"conversation\":{\"id\":${CONVERSATION_ID},\"status\":\"open\"},\"account\":{\"id\":${ACCOUNT_ID}},\"sender\":{\"id\":33,\"name\":\"Mock Customer\",\"type\":\"contact\"}}"
  echo "== message_updated is handled like message_created =="
  post "$edited" dispatched

  local conv
  conv="{\"event\":\"conversation_updated\",\"id\":${CONVERSATION_ID},\"status\":\"resolved\",\"team_id\":1,\"account\":{\"id\":${ACCOUNT_ID}}}"
  echo "== conversation event is ignored =="
  post "$conv" ignored

  local foreign
  foreign="{\"event\":\"message_created\",\"id\":9003,\"content\":\"foreign account\",\"message_type\":\"incoming\",\"private\":false,\"content_type\":\"text\",\"conversation_id\":${CONVERSATION_ID},\"conversation\":{\"id\":${CONVERSATION_ID},\"status\":\"open\"},\"account\":{\"id\":${WRONG_ACCOUNT_ID}},\"sender\":{\"id\":33,\"name\":\"Mock Customer\",\"type\":\"contact\"}}"
  echo "== message from a different account is ignored =="
  post "$foreign" ignored
}

smoke
echo "smoke-webhook: all checks passed ($MODE mode on $EP)"
#!/usr/bin/env bash
# ops/scripts/smoke.sh
# post-deploy: login · room · chat · upload
# Usage: ./ops/scripts/smoke.sh <env>   (env matches infra/envs/<env>)
set -euo pipefail

ENV="${1:?usage: smoke.sh <dev|staging|prod>}"
API="https://api${ENV:+.$ENV}.classroom.app"
[ "$ENV" = "prod" ] && API="https://api.classroom.app"

SMOKE_EMAIL="${SMOKE_EMAIL:-smoke-test@classroom.app}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:?set SMOKE_PASSWORD}"

fail() { echo "SMOKE FAILED: $1" >&2; exit 1; }

echo "== 1/4 login =="
TOKEN=$(curl -sf -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"$SMOKE_PASSWORD\"}" \
  | jq -r '.accessToken') || fail "login request failed"
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || fail "no access token returned"

echo "== 2/4 join a room (readiness of mediasoup/signaling path) =="
ROOM_ID=$(curl -sf "$API/courses/mine" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.[0].modules[0].lessons[] | select(.type=="live") | .liveRoomId' | head -n1)
[ -n "$ROOM_ID" ] && [ "$ROOM_ID" != "null" ] || fail "no live room found for smoke-test tenant"
curl -sf "$API/rooms/$ROOM_ID/node" -H "Authorization: Bearer $TOKEN" > /dev/null \
  || fail "room-to-node resolution failed"

echo "== 3/4 send a chat message on the public channel =="
DEDUPE_KEY="smoke-$(date +%s)"
curl -sf -X POST "$API/messaging/channels/public/messages" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"body\":\"smoke test $(date -u +%FT%TZ)\",\"dedupeKey\":\"$DEDUPE_KEY\"}" > /dev/null \
  || fail "chat send failed"

echo "== 4/4 presign + upload a tiny file =="
PRESIGN=$(curl -sf -X POST "$API/media/presign" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"fileName":"smoke.txt","mimeType":"text/plain","sizeBytes":11}') \
  || fail "presign request failed"
UPLOAD_URL=$(echo "$PRESIGN" | jq -r '.uploadUrl')
ASSET_ID=$(echo "$PRESIGN" | jq -r '.assetId')
echo -n "smoke test" | curl -sf -X PUT "$UPLOAD_URL" -H 'Content-Type: text/plain' --data-binary @- \
  || fail "direct-to-S3 upload failed"
curl -sf -X POST "$API/media/$ASSET_ID/complete" -H "Authorization: Bearer $TOKEN" > /dev/null \
  || fail "upload-complete callback failed"

echo "SMOKE OK: login, room resolution, chat send, upload all succeeded against $API"
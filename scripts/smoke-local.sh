#!/usr/bin/env bash
# Cold-clone local smoke: matches README "One-sitting demo".
# Asserts GET /healthz and NTRIP mount MOCK (ICY/200 + body bytes) via the proxy.
#
# Usage (from repo root):
#   ./scripts/smoke-local.sh
#
# Env overrides (optional):
#   API=http://127.0.0.1:8080
#   PROXY_NTRIP=http://127.0.0.1:2101
#   SKIP_COMPOSE=1   - assume stack already up (CI can still use the script as-is)
#   NTRIP_MAX_TIME=3 - curl --max-time for streaming NTRIP (exit 28 = timeout is OK)
#   DOCKER="docker"  - or "sudo docker" if the user is not in the docker group
#
# Requires: docker compose, curl, jq
# NTRIP assert uses curl --http0.9 (ICY 200 is not modern HTTP).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API="${API:-http://127.0.0.1:8080}"
PROXY_NTRIP="${PROXY_NTRIP:-http://127.0.0.1:2101}"
NTRIP_MAX_TIME="${NTRIP_MAX_TIME:-3}"
FIXTURE_ORG="${FIXTURE_ORG:-00000000-0000-4000-8000-000000000001}"
DOCKER="${DOCKER:-docker}"
# DOCKER may be a multi-word wrapper (e.g. "sudo docker")
# shellcheck disable=SC2206
DOCKER_CMD=($DOCKER)
COMPOSE=("${DOCKER_CMD[@]}" compose --profile mock-caster)

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "smoke-local: missing required command: $1" >&2
    exit 1
  }
}
need curl
need jq
if ! "${DOCKER_CMD[@]}" compose version >/dev/null 2>&1; then
  echo "smoke-local: cannot run docker compose (DOCKER=$DOCKER)" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "smoke-local: copying .env.example -> .env (local-dev placeholders only)"
  cp .env.example .env
fi

if [[ "${SKIP_COMPOSE:-}" != "1" ]]; then
  echo "smoke-local: docker compose --profile mock-caster up -d --build --wait"
  "${COMPOSE[@]}" up -d --build --wait
fi

echo "smoke-local: wait for API healthz"
deadline=$((SECONDS + 120))
until curl -fsS "$API/healthz" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "smoke-local: timed out waiting for $API/healthz" >&2
    "${COMPOSE[@]}" ps >&2 || true
    exit 1
  fi
  sleep 2
done
HEALTH="$(curl -fsS "$API/healthz")"
echo "$HEALTH" | jq -e '.ok == true' >/dev/null
echo "smoke-local: healthz OK"

echo "smoke-local: wait for proxy :2101"
deadline=$((SECONDS + 60))
proxy_up() {
  # bash /dev/tcp - no HTTP semantics needed for NTRIP listen check
  (echo -n >/dev/tcp/127.0.0.1/2101) >/dev/null 2>&1
}
until proxy_up; do
  if (( SECONDS >= deadline )); then
    echo "smoke-local: timed out waiting for proxy on 127.0.0.1:2101" >&2
    "${COMPOSE[@]}" ps >&2 || true
    exit 1
  fi
  sleep 1
done

echo "smoke-local: seed fixture upstream -> mock-caster:2102/MOCK (README path)"
UP="$(curl -fsS -X POST "$API/v0/fixture/upstream-secret" \
  -H 'content-type: application/json' \
  -d '{"display_name":"mock-caster","host":"mock-caster","port":2102,"mountpoint":"MOCK","username":"mock","password":"mock"}')"
UPSTREAM_ID="$(echo "$UP" | jq -r .upstream_id)"
if [[ -z "$UPSTREAM_ID" || "$UPSTREAM_ID" == "null" ]]; then
  echo "smoke-local: fixture upstream-secret failed: $UP" >&2
  exit 1
fi
echo "smoke-local: upstream_id=$UPSTREAM_ID"

PROFILE="$(curl -fsS -X POST "$API/v0/orgs/$FIXTURE_ORG/profiles" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"demo-mock-smoke\",\"candidates\":[{\"priority\":1,\"upstream_endpoint_id\":\"$UPSTREAM_ID\"}]}")"
PROFILE_ID="$(echo "$PROFILE" | jq -r .id)"
if [[ -z "$PROFILE_ID" || "$PROFILE_ID" == "null" ]]; then
  echo "smoke-local: profile create failed: $PROFILE" >&2
  exit 1
fi

DEV="$(curl -fsS -X POST "$API/v0/orgs/$FIXTURE_ORG/devices" \
  -H 'content-type: application/json' \
  -d "{\"label\":\"demo-rover-smoke\",\"profile_id\":\"$PROFILE_ID\"}")"
PSEUDO_USER="$(echo "$DEV" | jq -r .pseudo_username)"
PSEUDO_PASS="$(echo "$DEV" | jq -r .pseudo_password)"
if [[ -z "$PSEUDO_USER" || "$PSEUDO_USER" == "null" || -z "$PSEUDO_PASS" || "$PSEUDO_PASS" == "null" ]]; then
  echo "smoke-local: device provision failed: $DEV" >&2
  exit 1
fi
echo "smoke-local: device pseudo_username=$PSEUDO_USER"

# Brief settle so proxy/store see the new device (shared JSON volume).
sleep 1

echo "smoke-local: NTRIP GET $PROXY_NTRIP/MOCK (expect ICY/200 + body; curl timeout OK)"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

set +e
# ICY 200 is not modern HTTP; curl needs --http0.9. Status line lands in the body dump.
curl -sS -N --http0.9 -u "${PSEUDO_USER}:${PSEUDO_PASS}" \
  --max-time "$NTRIP_MAX_TIME" \
  -o "$OUT" \
  "${PROXY_NTRIP}/MOCK"
CURL_EC=$?
set -e

# 0 = connection closed cleanly; 28 = operation timeout (expected for infinite stream)
if [[ "$CURL_EC" -ne 0 && "$CURL_EC" -ne 28 ]]; then
  echo "smoke-local: curl failed with exit $CURL_EC" >&2
  head -c 512 "$OUT" >&2 || true
  exit 1
fi

BYTES="$(wc -c < "$OUT" | tr -d ' ')"
HEAD_TXT="$(head -c 256 "$OUT" | tr -d '\0' || true)"
echo "smoke-local: bytes=$BYTES curl_exit=$CURL_EC"

if ! printf '%s' "$HEAD_TXT" | grep -qiE '(ICY|HTTP/[0-9.]+) 200'; then
  echo "smoke-local: expected ICY/HTTP 200 in response prefix" >&2
  printf '%s\n' "$HEAD_TXT" >&2
  exit 1
fi
# Need status framing plus at least one mock RTCM-ish chunk (24 bytes).
if [[ "$BYTES" -lt 40 ]]; then
  echo "smoke-local: expected body bytes from MOCK stream, got $BYTES" >&2
  exit 1
fi

echo "smoke-local: PASS (healthz + NTRIP MOCK ICY/200 with ${BYTES} bytes)"

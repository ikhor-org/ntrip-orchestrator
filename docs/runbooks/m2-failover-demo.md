# M2 failover demo runbook

**Goal:** Show primary mock upstream fail → secondary takes over, with hysteresis config and audit.

## Prerequisites

```bash
cp .env.example .env
# set VAULT_KEK (32-byte hex)
export $(grep -v '^#' .env | xargs)
rm -f "$GROKBOT_STORE_PATH"
npm run build
```

Terminal A — API:

```bash
ALLOW_FIXTURE_ORGS=true VAULT_KEK=$VAULT_KEK GROKBOT_STORE_PATH=/tmp/grokbot-m2-store.json \
  npm run dev:api
```

Terminal B — proxy:

```bash
ALLOW_FIXTURE_ORGS=true VAULT_KEK=$VAULT_KEK GROKBOT_STORE_PATH=/tmp/grokbot-m2-store.json \
  npm run dev:proxy
```

## Steps

### 1. Seed primary + secondary upstream secrets

```bash
PRIMARY=$(curl -s -X POST localhost:8080/v0/fixture/upstream-secret \
  -H 'content-type: application/json' \
  -d '{"display_name":"primary","host":"127.0.0.1","port":9101,"mountpoint":"P","username":"p","password":"primary-pass"}')
echo "$PRIMARY"
PRIMARY_ID=$(echo "$PRIMARY" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).upstream_id))")

SECONDARY=$(curl -s -X POST localhost:8080/v0/fixture/upstream-secret \
  -H 'content-type: application/json' \
  -d '{"display_name":"secondary","host":"127.0.0.1","port":9102,"mountpoint":"S","username":"s","password":"secondary-pass"}')
echo "$SECONDARY"
SECONDARY_ID=$(echo "$SECONDARY" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).upstream_id))")
```

### 2. Create profile policy (primary then secondary)

```bash
FIXTURE_ORG=00000000-0000-4000-8000-000000000001
PROFILE=$(curl -s -X POST localhost:8080/v0/orgs/$FIXTURE_ORG/profiles \
  -H 'content-type: application/json' \
  -d "{\"name\":\"demo-failover\",\"candidates\":[
      {\"priority\":1,\"upstream_endpoint_id\":\"$PRIMARY_ID\"},
      {\"priority\":2,\"upstream_endpoint_id\":\"$SECONDARY_ID\"}
    ],\"failover\":{\"unhealthy_after_ms\":0,\"max_switches_per_hour\":10,\"on_exhaust\":\"reject\"}}")
echo "$PROFILE"
PROFILE_ID=$(echo "$PROFILE" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
```

`unhealthy_after_ms: 0` makes demos snappy; production-like default is `30000` (architecture §5.4).

### 3. Provision device on that profile

```bash
DEV=$(curl -s -X POST localhost:8080/v0/orgs/$FIXTURE_ORG/devices \
  -H 'content-type: application/json' \
  -d "{\"label\":\"failover-rover\",\"profile_id\":\"$PROFILE_ID\"}")
echo "$DEV"
# Save pseudo_username / pseudo_password
```

### 4. Mark primary unreachable (simulates health breach)

```bash
curl -s -X POST localhost:8080/v0/fixture/upstream-health \
  -H 'content-type: application/json' \
  -d "{\"upstream_id\":\"$PRIMARY_ID\",\"status\":\"unreachable\",\"reachable\":false,\"last_error\":\"demo_down\"}"
```

### 5. Connect NTRIP client with pseudo-cred

Use any NTRIP client → `localhost:2101`, mount `P` or `S`, user/pass from step 3.

**Automated equivalent:** `npm test` runs `packages/proxy` failover tests that mock primary connect failure and assert secondary RTCM + `session.failover` audit.

### 6. Inspect

```bash
curl -s localhost:8080/v0/orgs/$FIXTURE_ORG/audit?event_type=session.failover
curl -s localhost:8080/v0/orgs/$FIXTURE_ORG/health
curl -s localhost:8080/v0/upstreams/$SECONDARY_ID/health
curl -s "localhost:8080/v0/orgs/$FIXTURE_ORG/usage/export"
```

Expect: session on secondary; audit `session.failover` or `session.started` with secondary upstream; metering **without** lat/lon.

## Hysteresis note

With `unhealthy_after_ms: 30000`, mid-session failover waits 30s of continuous unhealthy before switching, and `max_switches_per_hour` caps flapping (default 10).

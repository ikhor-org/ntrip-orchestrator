# Runbook — customer / sandbox NTRIP caster (ops path)

| Field | Value |
| --- | --- |
| **Audience** | Ops |
| **Date** | 23 Sep 2026 (Europe/Oslo) |
| **Goal** | Plug a **real** or operator-owned **sandbox** NTRIP caster into an activated pilot org via the ops vault — **no fixtures**, no commercial network API adapters |
| **Adapter** | `ntrip_basic` only (host / port / mount + vaulted user/pass) |

This is the **production-shaped** upstream path. Local mock-caster / fixture demos remain for CI; they are not required here.

**Related**

- Hetzner bring-up + SSH tunnel: [`hetzner-deploy.md`](hetzner-deploy.md) §9
- Fixture-only failover lab: [`m2-failover-demo.md`](m2-failover-demo.md)
- Credential rotation: [`credential-rotate-revoke.md`](credential-rotate-revoke.md)
- Screening / activate: [`screening-workflow.md`](screening-workflow.md)

---

## Constraints (do not skip)

- `ALLOW_FIXTURE_ORGS=false` on the host (prod compose enforces this).
- Never commit or paste real caster passwords, `$OPS_API_KEY`, or device pseudo-passwords into chat, tickets, or the repo.
- Use **placeholders** in docs and tickets: `$OPS_API_KEY`, `$NTRIP_HOST`, `$NTRIP_PORT`, `$NTRIP_MOUNT`, `$NTRIP_USER`, `$NTRIP_PASS`, `$NTRIP_HOST_2`, …
- Hetzner / prod smoke keeps `API_BIND=127.0.0.1` and `PROXY_BIND=127.0.0.1` — validate over an **SSH tunnel**, not public 8080/2101.
- No Point One / GEODNET / other commercial API adapter stubs in this path — customer supplies a standard NTRIP caster seat.
- Civil / screened pilots only; CPOS packaging stays off.

---

## Prerequisites

1. Stack up (local compose or Hetzner) with `VAULT_KEK` and `OPS_API_KEY` set in `.env` (never committed).
2. SSH local forwards if the API/proxy bind loopback only:

```bash
# Laptop → VPS loopback (replace USER@HOST)
ssh -N \
  -L 8080:127.0.0.1:8080 \
  -L 2101:127.0.0.1:2101 \
  USER@HOST
```

3. Shell env on the laptop (or on the VPS via `127.0.0.1`):

```bash
export API=http://127.0.0.1:8080
# Load from server .env — do not echo into logs/chat:
# export OPS_API_KEY=...
#
# Customer/sandbox caster (runtime only):
# export NTRIP_HOST=caster.example.invalid
# export NTRIP_PORT=2101
# export NTRIP_MOUNT=MOUNT
# export NTRIP_USER=seat-user
# export NTRIP_PASS=seat-pass
```

Optional second endpoint for failover (different host/port/mount or a deliberate dead primary):

```bash
# export NTRIP_HOST_2=...
# export NTRIP_PORT_2=2101
# export NTRIP_MOUNT_2=MOUNT2
# export NTRIP_USER_2=...
# export NTRIP_PASS_2=...
```

**Reachability note:** the **proxy** process must be able to dial `$NTRIP_HOST:$NTRIP_PORT`. On Docker, that means a hostname the compose network or host DNS can resolve (public caster, VPN, or compose service). Loopback `127.0.0.1` on the VPS host is **not** reachable from a bridge-networked proxy container unless you use host networking / `host.docker.internal` / a sidecar. Prefer a caster the proxy can route to.

---

## 1. Ensure an activated pilot org

Skip if you already have `$ORG_ID` active + `screening_status=cleared`.

```bash
ORG_ID=$(curl -fsS -X POST "$API/v0/ops/pilot-orgs" \
  -H "content-type: application/json" \
  -H "X-Ops-Key: $OPS_API_KEY" \
  -d '{
    "name": "Pilot Customer Caster",
    "country": "NO",
    "icp_segment": "A",
    "end_use_representation": "Civil construction machine-control"
  }' | jq -r .id)

curl -fsS -X POST "$API/v0/orgs/$ORG_ID/screening" \
  -H "content-type: application/json" \
  -H "X-Ops-Key: $OPS_API_KEY" \
  -d '{
    "result": "cleared",
    "screening_reference": "SCR-PLACEHOLDER",
    "prohibited_use_attested": true,
    "sanctions_cleared": true,
    "upstream_tos_acknowledged": true
  }' | jq .

curl -fsS -X POST "$API/v0/orgs/$ORG_ID/activate" \
  -H "X-Ops-Key: $OPS_API_KEY" | jq .
```

Confirm fixtures stay closed:

```bash
curl -sS -X POST "$API/v0/fixture/upstream-secret" \
  -H "content-type: application/json" \
  -d '{"host":"x","username":"u","password":"p"}' | jq .
# Expect: 403 fixture_org_only
```

---

## 2. Vault primary (+ optional secondary) via ops

`POST /v0/ops/orgs/:orgId/upstreams` — requires `X-Ops-Key`. Response includes `upstream_id` / `secret_id` / `last4` / host / port / mount — **never** plaintext password.

```bash
PRIMARY=$(curl -fsS -X POST "$API/v0/ops/orgs/$ORG_ID/upstreams" \
  -H "content-type: application/json" \
  -H "X-Ops-Key: $OPS_API_KEY" \
  -d "{
    \"display_name\": \"customer-primary\",
    \"host\": \"$NTRIP_HOST\",
    \"port\": ${NTRIP_PORT:-2101},
    \"mountpoint\": \"$NTRIP_MOUNT\",
    \"username\": \"$NTRIP_USER\",
    \"password\": \"$NTRIP_PASS\"
  }")
echo "$PRIMARY" | jq .
PRIMARY_ID=$(echo "$PRIMARY" | jq -r .upstream_id)
```

Optional secondary (same org):

```bash
SECONDARY=$(curl -fsS -X POST "$API/v0/ops/orgs/$ORG_ID/upstreams" \
  -H "content-type: application/json" \
  -H "X-Ops-Key: $OPS_API_KEY" \
  -d "{
    \"display_name\": \"customer-secondary\",
    \"host\": \"$NTRIP_HOST_2\",
    \"port\": ${NTRIP_PORT_2:-2101},
    \"mountpoint\": \"$NTRIP_MOUNT_2\",
    \"username\": \"$NTRIP_USER_2\",
    \"password\": \"$NTRIP_PASS_2\"
  }")
echo "$SECONDARY" | jq .
SECONDARY_ID=$(echo "$SECONDARY" | jq -r .upstream_id)
```

List (metadata only):

```bash
curl -fsS "$API/v0/orgs/$ORG_ID/upstreams" | jq .
```

---

## 3. Profile candidates + failover policy

Priorities are ascending (1 = preferred). Proxy already fails over on **connect failure** to the next candidate — no fixture health POST required.

```bash
# Single primary
PROFILE_ID=$(curl -fsS -X POST "$API/v0/orgs/$ORG_ID/profiles" \
  -H "content-type: application/json" \
  -d "{
    \"name\": \"customer-ntrip\",
    \"candidates\": [
      { \"priority\": 1, \"upstream_endpoint_id\": \"$PRIMARY_ID\" }
    ],
    \"failover\": {
      \"unhealthy_after_ms\": 30000,
      \"max_switches_per_hour\": 10,
      \"on_exhaust\": \"reject\"
    }
  }" | jq -r .id)

# Dual-endpoint (primary then secondary) — set SECONDARY_ID first
# PROFILE_ID=$(curl -fsS -X POST "$API/v0/orgs/$ORG_ID/profiles" \
#   -H "content-type: application/json" \
#   -d "{
#     \"name\": \"customer-ntrip-failover\",
#     \"candidates\": [
#       { \"priority\": 1, \"upstream_endpoint_id\": \"$PRIMARY_ID\" },
#       { \"priority\": 2, \"upstream_endpoint_id\": \"$SECONDARY_ID\" }
#     ],
#     \"failover\": {
#       \"unhealthy_after_ms\": 0,
#       \"max_switches_per_hour\": 10,
#       \"on_exhaust\": \"reject\"
#     }
#   }" | jq -r .id)
```

`unhealthy_after_ms: 0` is fine for a snappy ops validation; production-like default is `30000` (architecture §5.4).

---

## 4. Bind a device

```bash
DEV=$(curl -fsS -X POST "$API/v0/orgs/$ORG_ID/devices" \
  -H "content-type: application/json" \
  -H "X-Ops-Key: $OPS_API_KEY" \
  -d "{\"label\": \"customer-rover\", \"profile_id\": \"$PROFILE_ID\"}")
echo "$DEV" | jq 'del(.pseudo_password)'
PSEUDO_USER=$(echo "$DEV" | jq -r .pseudo_username)
PSEUDO_PASS=$(echo "$DEV" | jq -r .pseudo_password)
# Store PSEUDO_PASS out-of-band; do not commit or paste into tickets.
```

---

## 5. NTRIP validate over the tunnel

Mount must match what the proxy will request (vault `mountpoint` / profile override). Streaming responses may exit curl with 28 after `--max-time` — that is OK if status is ICY/200 and body has bytes.

```bash
curl -v -N --http0.9 -u "$PSEUDO_USER:$PSEUDO_PASS" \
  --max-time 5 "http://127.0.0.1:2101/$NTRIP_MOUNT" | xxd | head
```

Inspect:

```bash
curl -fsS "$API/v0/orgs/$ORG_ID/health" | jq .
curl -fsS "$API/v0/upstreams/$PRIMARY_ID/health" | jq .
curl -fsS "$API/v0/orgs/$ORG_ID/audit?event_type=session.started" | jq .
```

Expect: session on primary; metering/audit **without** lat/lon.

---

## 6. Dual-endpoint failover (ops-side, connect-fail)

**Prefer this over fixture health marks.** The proxy tries candidates in priority order; a connect failure on primary promotes secondary and emits `session.failover` (covered by `packages/proxy` unit tests).

### Recommended validation pattern

1. Vault **primary** to a host/port that will **fail to connect** from the proxy (e.g. `127.0.0.1` + unused high port on a bridge-networked proxy, or a firewalled address you control).
2. Vault **secondary** to the real/sandbox caster (`$NTRIP_HOST_2` …).
3. Profile candidates: priority 1 = primary id, priority 2 = secondary id; `unhealthy_after_ms: 0` for a quick check.
4. Connect with device pseudo-creds (step 5).
5. Confirm stream from secondary + audit:

```bash
curl -fsS "$API/v0/orgs/$ORG_ID/audit?event_type=session.failover" | jq .
curl -fsS "$API/v0/orgs/$ORG_ID/health" | jq .
curl -fsS "$API/v0/upstreams/$SECONDARY_ID/health" | jq .
```

Expect: RTCM/ICY stream via secondary; `session.failover` and/or `session.started` with secondary `upstream_id`.

### Alternate (two live casters)

Use two reachable seats and take the primary offline at the **provider** (revoke seat, firewall, stop sandbox process). Mid-session failover still respects `unhealthy_after_ms` / `max_switches_per_hour`.

### Not required for ops validation

- `POST /v0/fixture/upstream-health` — fixture-gated; stays **403** when `ALLOW_FIXTURE_ORGS=false`.
- No ops health-mark route in this milestone — connect-fail failover is enough.

Automated coverage: `npm test` → `packages/proxy` failover tests (`connect fails on primary then succeeds on secondary with failover audit`).

---

## 7. Rotate / revoke

1. Rotate password/token at the **customer caster**.
2. Re-vault: call `POST /v0/ops/orgs/$ORG_ID/upstreams` again with the new seat (creates a new upstream+secret), then **PATCH/replace** the profile candidates to point at the new `upstream_id` (or follow the vault steps in [`credential-rotate-revoke.md`](credential-rotate-revoke.md)).
3. Confirm a fresh NTRIP session; audit shows `vault.secret.created` without plaintext.
4. Device pseudo-cred rotation: provision a replacement device and update the field client — see the same credential runbook.

---

## Success criteria

| Check | Pass |
| --- | --- |
| Ops vault | `201` with `upstream_id` / `secret_id` / `last4`; no password in body |
| Fixtures | `/v0/fixture/*` → `403` with `ALLOW_FIXTURE_ORGS=false` |
| Device | Bound to profile whose candidates reference ops-vaulted upstream id(s) |
| Stream | NTRIP client over SSH tunnel gets ICY/200 + body bytes from customer/sandbox caster |
| Dual failover | With two ops upstreams, connect-fail on primary → secondary stream + failover/started audit |
| Secrets | No real secrets in repo, docs, or chat — placeholders only |

---

## Out of scope (this path)

- Point One / GEODNET / SmartNet / Skylark commercial API adapters
- CPOS packaging or enabling `CPOS_ADAPTER_ENABLED`
- Opening public ufw 8080/2101 for smoke
- Fixture org demos (`m2-failover-demo.md` remains the local fixture lab)

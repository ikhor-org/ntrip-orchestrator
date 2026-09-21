# grokbot

Software-only **GNSS RTK OEM/fleet correction orchestration** plane.

Credential vault, multi-network NTRIP routing/failover, device provisioning, health/SLA, audit, and metering hooks — for OEMs, UAS fleets, autonomy stacks, and telematics/SIs. Upstream networks are feeds, not the SKU. Not another end-user survey CORS seat.

| Field | Value |
| --- | --- |
| **Milestone** | **M2** — failover + ops visibility |
| **Date** | 21 Sep 2026 (Europe/Oslo) |
| **Status** | Profile policy, health-triggered failover with hysteresis, health/audit/usage APIs, provisional load test (50 concurrent mocked sessions). Live orgs still gated. |
| **Load test target** | **50 concurrent mocked sessions** — **provisional** (architecture O8 OPEN) |

---

## Stack

**TypeScript (Node 20+) monorepo** — `packages/core`, `packages/api`, `packages/proxy`, `packages/adapters`.

- **Datastore:** PostgreSQL schema in `migrations/` (source of truth). Runtime uses in-memory store + optional JSON file (`GROKBOT_STORE_PATH`) so api + proxy share state locally.
- **Vault:** AES-256-GCM; KEK from `VAULT_KEK` / `VAULT_MASTER_KEY` (32-byte hex or base64).
- **Pseudo-creds:** scrypt password hashes.
- **Policy:** ordered primary/secondary candidates; `unhealthy_after_ms` + `max_switches_per_hour` hysteresis.

---

## M0 → M1 → M2

| | M0 | M1 | M2 (this branch) |
| --- | --- | --- | --- |
| Vault | Ciphertext columns | **Real** AES-256-GCM | same |
| Devices | 501 | **Real** fixture provision | same + profile_id |
| Proxy | Auth stub | **Real** NTRIP relay | **Failover** via profile policy |
| Policy | — | implicit single upstream | **Primary/secondary + hysteresis** |
| Health API | basic org | basic | **upstreams + devices + sessions** |
| Audit | writers | list | **Filtered query** (org/device/time/event_type) |
| Usage | writers | list | **Export + signed webhook** |
| Load test | — | — | **50 concurrent** (provisional) |
| Docs | checklist | M1 runbook | **ToS draft + screening runbook started** |
| Live `POST /v0/orgs` | 403 | 403 | **Still 403 `screening_required`** |

**Merge order:** PR #1 `m0-skeleton` → `main`, then PR #2 `m1-generic-ntrip` → `m0-skeleton`, then this PR → `m1-generic-ntrip`.

---

## Non-goals (standing)

See `docs/architecture.md` §3. In short: no CPOS displacement; no spoof/jam; no mil packaging; no CORS/base stations; no fund custody; **no live orgs until screening**; **CPOS post-counsel**; **no track histories** — GGA/last-position for live session health only; metering = connect / bytes / device-days only.

ToS draft + screening runbook: `docs/tos-draft.md`, `docs/runbooks/screening-workflow.md` — **do not unlock live orgs**.

---

## Build / test

```bash
npm install
npm run build
npm run lint
npm test
# optional: load test only
npm run loadtest
```

---

## M2 runbook — demo failover

Concrete steps: **`docs/runbooks/m2-failover-demo.md`**.

Short version:

1. Start API + proxy with shared `GROKBOT_STORE_PATH` and `VAULT_KEK`.
2. Seed **two** fixture upstream secrets (primary + secondary).
3. `POST /v0/orgs/{fixture}/profiles` with candidates priority 1 then 2; set `failover.unhealthy_after_ms` (0 for snappy demo; 30000 default).
4. Provision device with that `profile_id`.
5. `POST /v0/fixture/upstream-health` mark primary `unreachable` **or** kill primary mock caster.
6. Connect NTRIP with pseudo-cred → secondary serves RTCM; check `GET .../audit?event_type=session.failover`.

Automated: `packages/proxy` failover tests mock primary connect failure → secondary RTCM + audit.

---

## Key M2 endpoints

```http
POST   /v0/orgs/{org_id}/profiles
GET    /v0/orgs/{org_id}/profiles
GET    /v0/profiles/{profile_id}
PUT    /v0/profiles/{profile_id}

GET    /v0/orgs/{org_id}/health
GET    /v0/upstreams/{upstream_id}/health
GET    /v0/devices/{device_id}/health
GET    /v0/orgs/{org_id}/sessions?status=active

GET    /v0/orgs/{org_id}/audit?from=&to=&event_type=&device_id=&cursor=
GET    /v0/orgs/{org_id}/usage/events?from=&to=&cursor=
GET    /v0/orgs/{org_id}/usage/export?from=&to=&webhook_id=
POST   /v0/orgs/{org_id}/usage/webhooks
```

OpenAPI: `docs/openapi/openapi.yaml`.

---

## Local env

```bash
cp .env.example .env
# Generate KEK:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
export $(grep -v '^#' .env | xargs)
rm -f "$GROKBOT_STORE_PATH"

ALLOW_FIXTURE_ORGS=true VAULT_KEK=$VAULT_KEK GROKBOT_STORE_PATH=/tmp/grokbot-m2-store.json npm run dev:api
ALLOW_FIXTURE_ORGS=true VAULT_KEK=$VAULT_KEK GROKBOT_STORE_PATH=/tmp/grokbot-m2-store.json npm run dev:proxy
```

PG migrations:

```bash
psql "$DATABASE_URL" -f migrations/001_initial.sql
psql "$DATABASE_URL" -f migrations/002_m1_sessions.sql
psql "$DATABASE_URL" -f migrations/003_m2_profiles_usage.sql
```

---

## Real vs still stub / gated

| Component | Status |
| --- | --- |
| Vault AES-256-GCM | **Real** |
| Device pseudo-cred (fixture) | **Real** |
| Generic NTRIP adapter | **Real** |
| Profile policy primary/secondary | **Real** |
| Failover + hysteresis | **Real** |
| Health / audit query / usage export | **Real** |
| Load test 50 concurrent (provisional) | **Real** (automated) |
| ToS draft + screening runbook | **Started** (docs only) |
| Point One / GEODNET / Skylark / SmartNet | **Stub** |
| CPOS | **Disabled** |
| Live org POST | **403 screening_required** |

---

*M2 failover + ops visibility. Stack on M1 (`m1-generic-ntrip`). Keep screening + CPOS gates closed.*

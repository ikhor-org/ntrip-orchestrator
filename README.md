# grokbot

Software-only **GNSS RTK OEM/fleet correction orchestration** plane.

Credential vault, multi-network NTRIP routing/failover, device provisioning, health/SLA, audit, and metering hooks — for OEMs, UAS fleets, autonomy stacks, and telematics/SIs. Upstream networks are feeds, not the SKU. Not another end-user survey CORS seat.

| Field | Value |
| --- | --- |
| **Milestone** | **M1** — vertical slice (generic NTRIP) |
| **Date** | 21 Sep 2026 (Europe/Oslo) |
| **Status** | Vault + fixture device provision + NTRIP proxy relay (mocked upstream OK in tests). Live orgs still gated. |

---

## Stack

**TypeScript (Node 20+) monorepo** — `packages/core`, `packages/api`, `packages/proxy`, `packages/adapters`.

- **Datastore:** PostgreSQL schema in `migrations/` (source of truth). M1 runtime uses an in-memory store with optional JSON file (`GROKBOT_STORE_PATH`) so api + proxy share state locally.
- **Vault:** AES-256-GCM; KEK from `VAULT_KEK` / `VAULT_MASTER_KEY` (32-byte hex or base64).
- **Pseudo-creds:** scrypt password hashes (Node built-in; architecture allows argon2id/scrypt/bcrypt).

---

## M0 vs M1

| | M0 | M1 (this branch) |
| --- | --- | --- |
| Vault | Ciphertext columns only | **Real** AES-256-GCM encrypt/decrypt |
| Devices | 501 stub | **Real** fixture-org provision (hash only) |
| Proxy | Auth stub, no upstream | **Real** pseudo-auth → vault → generic NTRIP relay |
| Adapters | stubs | **Real:** `ntrip_basic`. **Stub:** Point One, GEODNET, Skylark, SmartNet. **Disabled:** CPOS |
| Audit / metering | schema only | **Writers** (session started/ended/auth_fail; connect/bytes/device-days; **no lat/lon**) |
| Live `POST /v0/orgs` | 403 | **Still 403 `screening_required`** |

---

## Non-goals (standing)

See `docs/architecture.md` §3. In short: no CPOS displacement; no spoof/jam; no mil packaging; no CORS/base stations; no fund custody; **no live orgs until screening**; **CPOS post-counsel**; **no track histories** — GGA/last-position for live session health only (overwrite/drop on end); metering = connect / bytes / device-days only.

---

## M1 runbook

### 1. Env

```bash
cp .env.example .env
# Generate a fresh KEK:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Put it in VAULT_KEK=...
export $(grep -v '^#' .env | xargs)
rm -f "$GROKBOT_STORE_PATH"
```

### 2. Build / test

```bash
npm install
npm run build
npm run lint
npm test
```

### 3. Run API + proxy (separate terminals)

```bash
ALLOW_FIXTURE_ORGS=true VAULT_KEK=$VAULT_KEK GROKBOT_STORE_PATH=/tmp/grokbot-m1-store.json \
  npm run dev:api     # :8080

ALLOW_FIXTURE_ORGS=true VAULT_KEK=$VAULT_KEK GROKBOT_STORE_PATH=/tmp/grokbot-m1-store.json \
  npm run dev:proxy   # :2101
```

### 4. Seed fixture upstream secret

```bash
curl -s -X POST localhost:8080/v0/fixture/upstream-secret \
  -H 'content-type: application/json' \
  -d '{
    "host":"127.0.0.1",
    "port":2101,
    "mountpoint":"TEST",
    "username":"upstream-user",
    "password":"upstream-pass-not-for-prod"
  }'
# Returns metadata only (last4) — never plaintext password.
```

Point `host`/`port`/`mountpoint` at a real public/test caster when available, or keep a local mock caster. Happy-path tests mock the upstream TCP.

### 5. Provision a fixture device

```bash
FIXTURE_ORG=00000000-0000-4000-8000-000000000001
curl -s -X POST localhost:8080/v0/orgs/$FIXTURE_ORG/devices \
  -H 'content-type: application/json' \
  -d '{"label":"rover-1"}'
# Save pseudo_username / pseudo_password — returned once.
```

### 6. Connect via NTRIP (pseudo-cred)

```bash
# Example with curl-style Basic Auth over raw TCP is awkward; use an NTRIP client:
# host=localhost port=2101 user=$pseudo_username pass=$pseudo_password mount=TEST
```

### 7. Expected gates

```bash
curl -s -X POST localhost:8080/v0/orgs -H 'content-type: application/json' \
  -d '{"name":"Live Corp"}'
# → 403 {"error":"screening_required",...}
```

### 8. Inspect audit / metering / health

```bash
curl -s localhost:8080/v0/orgs/$FIXTURE_ORG/audit
curl -s localhost:8080/v0/orgs/$FIXTURE_ORG/usage/events
curl -s localhost:8080/v0/orgs/$FIXTURE_ORG/health
```

Metering payloads must never contain lat/lon/GGA/track fields.

Apply PG migrations when you have Postgres:

```bash
psql "$DATABASE_URL" -f migrations/001_initial.sql
psql "$DATABASE_URL" -f migrations/002_m1_sessions.sql
```

---

## Layout

```
grokbot/
  packages/
    core/       # vault, passwords, store, metering helpers
    api/        # control plane
    proxy/      # NTRIP proxy + relay
    adapters/   # ntrip_basic (real) + vendor stubs; cpos disabled
  migrations/
  docs/openapi/openapi.yaml
```

---

## Real vs still stub

| Component | Status |
| --- | --- |
| Vault AES-256-GCM | **Real** |
| Device pseudo-cred (fixture org) | **Real** (scrypt hash) |
| Generic NTRIP Basic Auth adapter | **Real** (mockable TCP for tests) |
| Proxy auth + relay | **Real** |
| Session audit + health samples | **Real** (ephemeral last position dropped on end) |
| Metering writers | **Real** (no location fields) |
| Point One / GEODNET / Skylark / SmartNet | **Stub** (`not_implemented`) |
| CPOS | **Disabled** / not in routing registry |
| Live org POST | **403 screening_required** |
| Failover policy engine | Deferred to M2 |

---

*M1 vertical slice. Stack on / merge after M0 PR #1 (`m0-skeleton` → `main`). Keep screening + CPOS gates closed.*

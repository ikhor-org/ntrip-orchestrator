# grokbot

Software-only **GNSS RTK OEM/fleet correction orchestration** plane.

Credential vault, multi-network NTRIP routing/failover, device provisioning, health/SLA, audit, and metering hooks — for OEMs, UAS fleets, autonomy stacks, and telematics/SIs. Upstream networks are feeds, not the SKU. Not another end-user survey CORS seat.

| Field | Value |
| --- | --- |
| **Milestone** | **M0** — design freeze & skeleton (this branch) |
| **Date** | 21 Sep 2026 (Europe/Oslo) |
| **Status** | Skeleton only — no live tenants, no real vault crypto, no upstream relay |

---

## Stack choice

**TypeScript (Node 20+) monorepo** — `packages/api`, `packages/proxy`, `packages/adapters`.

**Why:** Architecture §9 allows Go-everywhere *or* TypeScript for the control API (OpenAPI speed) with a preference for **one language until M2**. TypeScript gets a clean npm-workspaces monorepo, OpenAPI stub, and shared adapter types fastest for M0; the proxy remains a thin TCP listen/auth stub that can move to Go/Rust later if needed without blocking the control-plane skeleton.

Datastore target remains **PostgreSQL** (`migrations/`). No production KEK in M0.

---

## M0 vs M1

| | M0 (this repo state) | M1 (next) |
| --- | --- | --- |
| Docs | Architecture, decision record, threat/screening checklist, OpenAPI stub | Same + vertical-slice notes |
| Control API | Health, org GET/POST stubs; **live POST → 403 `screening_required`** | Device pseudo-cred provision (fixture org) |
| Proxy | Listen + Basic Auth stub; **no real upstream** | Relay via generic NTRIP Basic Auth to test caster |
| Vault | Ciphertext columns in SQL only | Encrypt/decrypt path |
| Adapters | Interface + stubs; **CPOS present but disabled / not registered** | **Real:** `ntrip_basic`. Still stub: Point One, GEODNET, Skylark, SmartNet, CPOS |
| Metering / audit | Schema + OpenAPI shapes (no lat/lon) | Writers to PG |

---

## Non-goals (standing)

See `docs/architecture.md` §3 and `docs/decision-record.md`. In short:

1. No Kartverket CPOS displacement  
2. No GNSS spoof/jam products or tradecraft  
3. No military guidance / anti-spoof packaging  
4. No building CORS / base stations as v0  
5. No fund custody / banking-licence path  
6. **No live customer/org provisioning** until ToS + screening  
7. **CPOS adapter post-counsel only** (stub disabled)  
8. **No track histories** — GGA/last-position for session health only; metering = connect / bytes / device-days (no lat/lon)  
9. No hardware / hosting-as-idea product framing  

---

## Fixture-org only

- Seeded fixture org id: `00000000-0000-4000-8000-000000000001`  
- Extra fixture create: `ALLOW_FIXTURE_ORGS=true` (non-prod) + header `X-Allow-Fixture-Orgs: true` + body `{ "name": "...", "fixture": true }`  
- Any **live** `POST /v0/orgs` → **403** `{ "error": "screening_required", ... }`  

Proxy fixture Basic Auth (local only, not for prod): user `fixture-device` / pass `fixture-pass-not-for-prod`.

---

## Layout

```
grokbot/
  README.md
  docs/
    architecture.md
    decision-record.md
    deep-dive-summary.md
    threat-screening-checklist.md
    openapi/openapi.yaml
  packages/
    api/        # control plane HTTP skeleton
    proxy/      # NTRIP proxy skeleton (listen + auth stub)
    adapters/   # ntrip_basic + vendor stubs; cpos disabled
  migrations/   # initial PG schema stubs
```

---

## Build / run / lint

```bash
npm install
npm run build      # or: make build
npm run lint       # or: make lint
npm test           # or: make test
npm run typecheck

# Run (separate terminals)
ALLOW_FIXTURE_ORGS=true npm run dev:api     # :8080
npm run dev:proxy                           # :2101
```

Quick checks:

```bash
curl -s localhost:8080/healthz
curl -s -X POST localhost:8080/v0/orgs -H 'content-type: application/json' \
  -d '{"name":"Live Corp"}'   # expect 403 screening_required
```

Apply migrations (when you have Postgres): `psql "$DATABASE_URL" -f migrations/001_initial.sql`

---

## Docs

- [`docs/architecture.md`](docs/architecture.md) — v0 architecture (copied from Builder workspace)  
- [`docs/decision-record.md`](docs/decision-record.md) — locked product wedge  
- [`docs/deep-dive-summary.md`](docs/deep-dive-summary.md) — summary of Scout deep-dive (full brief not vendored)  
- [`docs/threat-screening-checklist.md`](docs/threat-screening-checklist.md) — M0 draft for Ops/counsel  
- [`docs/openapi/openapi.yaml`](docs/openapi/openapi.yaml) — control API stub  

---

*M0 skeleton. Implement M1 vertical slice next; keep screening + CPOS gates closed.*

# Screening workflow — runbook (started)

| Field | Value |
| --- | --- |
| **Status** | **Ops-curated pilots** — ToS still draft until counsel signs |
| **Unlocks live orgs?** | **Pilots only** via ops path — no self-serve; not a production ToS unlock |
| **Date** | 21 Sep 2026 (Europe/Oslo) |

## Goal

Before any `Org.status = active`, require `screening_status = cleared` (architecture §10.3). Fixture orgs (`fixture_exempt`) are non-prod only.

## Current engineering gate

```http
POST /v0/orgs   # live (no fixture flag) → 403 screening_required
```

Self-serve `POST /v0/orgs` remains `403 screening_required`. Pilots use the ops intake path below.

## Draft workflow steps

1. **Intake** — collect legal entity name, country, ICP segment (A/B/C), intended end use, whether customer brings own upstream seats.
2. **Sanctions / export-control screen** — EU/NO applicable lists; record `screening_reference`.
3. **End-use attestation** — record prohibited-use + upstream-ToS acknowledgments against the **draft** ToS representations (customer signs published ToS when counsel finalizes it).
4. **Decision** — `cleared` | `rejected` | `pending` (more info).
5. **Activation** — ops calls `POST /v0/orgs/{id}/activate` only when `screening_status=cleared` **and** attestation flags (`prohibited_use_attested`, `sanctions_cleared`, `upstream_tos_acknowledged`) are still true.
6. **API keys** — ops/admin issues role-scoped keys (`admin` / `operator` / `read`).
7. **Ongoing** — right to suspend; audit retained.
6. **Ongoing** — right to suspend on credible misuse; retain audit for review.

## Roles (draft)

| Role | Responsibility |
| --- | --- |
| Ops / sales | Intake + attestation collection |
| Counsel | ToS finalization; CPOS proxying opinion (separate) |
| Builder | Keep live POST gated until M3 flag + cleared status |

## Checklist before claiming production ToS / open signup

- [ ] ToS published (counsel-signed — **still draft today**)
- [ ] Screening form + record store
- [x] `Org.status` transition API enforces `cleared` + attestation re-check
- [ ] Suspend / revoke runbook tested
- [x] Audit events for `org.screening_*`

Until counsel signs: pilots remain **ops-curated**; do not advertise production Terms.

## Explicit non-goals here

- Enabling CPOS adapter (post-counsel only)
- Accepting live customer traffic under this draft


## M3 ops API (ICP A preferred)

Prefer Nordic construction machine-control SI/OEM (ICP A).

```http
POST /v0/ops/pilot-orgs          # X-Ops-Key; creates pending_screening (NOT active)
POST /v0/orgs/{id}/screening     # result=cleared requires attestations + sanctions_cleared
POST /v0/orgs/{id}/activate      # requires screening_status=cleared; audited
POST /v0/orgs/{id}/suspend       # right to suspend
POST /v0/orgs/{id}/api-keys      # admin/ops; roles admin|operator|read
```

Cleared screening requires:

- `prohibited_use_attested=true` (no unauthorized surveillance / criminal / mil weapons guidance / jam-spoof / sanctions)
- `sanctions_cleared=true`
- `upstream_tos_acknowledged=true` (customer owns upstream ToS)
- civil/commercial `end_use_representation`

**Do not** auto-approve random signups. Fixture org remains non-prod only.

**ToS remains draft.** Pilots are ops-curated until counsel signs; device routes on active pilots require an org API key (no unauthenticated fallback).

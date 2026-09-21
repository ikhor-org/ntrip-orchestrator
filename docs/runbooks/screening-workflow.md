# Screening workflow — runbook (started)

| Field | Value |
| --- | --- |
| **Status** | **STARTED** — process draft only |
| **Unlocks live orgs?** | **No** — M3 |
| **Date** | 21 Sep 2026 (Europe/Oslo) |

## Goal

Before any `Org.status = active`, require `screening_status = cleared` (architecture §10.3). Fixture orgs (`fixture_exempt`) are non-prod only.

## Current engineering gate

```http
POST /v0/orgs   # live (no fixture flag) → 403 screening_required
```

This runbook does **not** remove that gate.

## Draft workflow steps

1. **Intake** — collect legal entity name, country, ICP segment (A/B/C), intended end use, whether customer brings own upstream seats.
2. **Sanctions / export-control screen** — EU/NO applicable lists; record `screening_reference`.
3. **End-use attestation** — customer signs ToS (when published) + prohibited-use acknowledgment (no jam/spoof, no mil weapons guidance, no unauthorized surveillance).
4. **Decision** — `cleared` | `rejected` | `pending` (more info).
5. **Activation** — only then may control plane set `status=active` (M3 API; not implemented in M2).
6. **Ongoing** — right to suspend on credible misuse; retain audit for review.

## Roles (draft)

| Role | Responsibility |
| --- | --- |
| Ops / sales | Intake + attestation collection |
| Counsel | ToS finalization; CPOS proxying opinion (separate) |
| Builder | Keep live POST gated until M3 flag + cleared status |

## Checklist before M3 unlock

- [ ] ToS published (not draft)
- [ ] Screening form + record store
- [ ] `Org.status` transition API enforces `cleared`
- [ ] Suspend / revoke runbook tested
- [ ] Audit events for `org.screening_*`

## Explicit non-goals here

- Enabling CPOS adapter (post-counsel only)
- Accepting live customer traffic under this draft

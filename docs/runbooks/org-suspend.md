# Runbook — suspend org / credentials

| Field | Value |
| --- | --- |
| **Milestone** | M3 |
| **Date** | 21 Sep 2026 (Europe/Oslo) |

## When to suspend

Credible misuse: unauthorized surveillance, criminal use, military weapons guidance, jam/spoof facilitation, sanctions violations, or ToS breach. Right to suspend is explicit in screening + ToS draft.

## Steps

1. **Suspend org** — `POST /v0/orgs/{org_id}/suspend` with ops key (or org `admin`) and `reason`.
2. **Confirm** — org `status=suspended`; device provision / pilot capabilities return `403`.
3. **Revoke keys** (optional hardening) — revoke all org API keys.
4. **Audit** — `GET /v0/orgs/{org_id}/audit` should show `org.suspended`.
5. **Comms** — notify customer; retain audit for compliance review.
6. **Re-activation** — only via ops after clearance; suspended orgs cannot self-activate (`403 org_suspended` / screening gate).

## Non-goals

- Do not use suspend to enable CPOS.
- Do not auto-unsuspend random signups.

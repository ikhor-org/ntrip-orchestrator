# Terms of Service — DRAFT (not live)

| Field | Value |
| --- | --- |
| **Status** | **DRAFT** — does **not** unlock live org onboarding |
| **Date** | 21 Sep 2026 (Europe/Oslo) |
| **Effect** | Draft still counsel-bound; M3 ops pilot path uses these representations as screening hooks |

> Engineering gate remains: `POST /v0/orgs` (live) → `403 screening_required`.
> This draft does **not** change that gate.

---

## 1. Service description (draft)

grokbot provides a software-only GNSS RTK **correction orchestration** plane: credential vault, NTRIP proxy with multi-upstream failover, device pseudo-credentials, health/SLA signals, audit logs, and usage metering events (connect / bytes / device-days). We do not operate CORS base stations in v0.

## 2. Permitted end use (draft)

Customer represents lawful **civil / commercial** end use, including for example:

- Agriculture and machine control
- Construction machine control
- Civil UAS / robotics / autonomy stacks
- Telematics / SI integration
- Research and development in the above domains

## 3. Prohibited use (draft)

- Unauthorized surveillance or criminal activity
- Military weapons guidance or munitions packaging
- GNSS interference (jamming / spoofing) products or facilitation
- Sanctions-violating destinations or parties (EU/NO screening where applicable)
- Using the service to displace Kartverket CPOS as a national survey CORS alternative (complement, do not compete)

## 4. Credentials & upstream networks (draft)

- Field devices receive **pseudo-credentials** only; master upstream secrets remain in the vault.
- Customer remains responsible for upstream network Terms (including Kartverket CPOS terms if/when customer-supplied CPOS is enabled post-counsel).
- We may suspend credentials on credible misuse; audit logs retained for compliance review (retention period OPEN — counsel/Ops).

## 5. Privacy / location (draft)

- GGA / last-position may be used **only** for live session health/SLA and are dropped when the session ends.
- **No** track histories, breadcrumbs, or location analytics products.
- Metering events contain connect / bytes / device-days only — **no** lat/lon.

## 6. Fees & funds (draft)

- Usage facts are emitted as metering events for later invoicing via a licensed PSP.
- We do **not** hold customer funds, wallets, or e-money credits.

## 7. Screening before live tenants (draft)

Live org activation requires end-use / sanctions screening clearance. See `docs/runbooks/screening-workflow.md`. Until that process is live, only fixture/dev orgs are supported.

---

*DRAFT — counsel review required before publication or M3 unlock.*

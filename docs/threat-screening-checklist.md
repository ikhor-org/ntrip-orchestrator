# Threat & end-use screening checklist (M0 draft)

**Status:** DRAFT for Ops/counsel review  
**Date:** 21 Sep 2026 (Europe/Oslo)  
**Scope:** Engineering + sales gates before **live** org activation. Fixture orgs in non-prod are exempt.  
**Sources:** Architecture §10, decision record non-goals, Sentinel CLEAR holds.

---

## 1. Engineering gates (must stay coded)

| Gate | Behaviour | M0 status |
| --- | --- | --- |
| Live org create | `POST /v0/orgs` without screening readiness → **403 `screening_required`** | Stubbed in API + OpenAPI |
| Fixture org | Only when `ALLOW_FIXTURE_ORGS=true` (non-prod) + explicit fixture flag | Stubbed |
| Org → `active` | Requires `screening_status=cleared` (or equivalent) | Schema field present; enforcement M1+ |
| CPOS adapter | Present as stub; **not registered** for routing; `CPOS_ADAPTER_ENABLED=false` | Stub; disabled |
| CPOS secrets | Do not ingest until counsel clears (OPEN O1/O10) | No ingest path in M0 |
| Metering payloads | connect / bytes / device-days only — **no lat/lon** | Schema comments + OpenAPI |
| GGA / last-position | Session health/SLA only; no track histories | Comments in health stubs |
| Vault | Ciphertext placeholders only in M0 — no production KEK | Migration stubs |

---

## 2. End-use / ToS screening (Ops + counsel — before M3)

Before any **live** customer org becomes `active`:

- [ ] Customer represents **lawful civil/commercial** end use (ag, construction, machine-control, civil UAS, robotics, research).
- [ ] Prohibited uses stated in ToS: unauthorized surveillance, criminal activity, military weapons guidance, GNSS interference (jam/spoof), sanctions-violating parties/destinations.
- [ ] Right to **suspend** credentials on credible misuse; audit logs retained for compliance review.
- [ ] Export-control / sanctions screening on org identity where applicable (EU/NO).
- [ ] Customer remains responsible for **upstream network ToS** (incl. Kartverket CPOS if/when they bring CPOS credentials — post-counsel only).
- [ ] No product packaging as military guidance / anti-spoof SKU.
- [ ] No marketing as Kartverket CPOS displacement for cadastral/survey seats.

**Owner:** Ops + counsel (OPEN O9). Engineering only enforces the API gate.

---

## 3. Threat model sketch (M0 — draft)

| Asset | Threat | Mitigation (v0 direction) |
| --- | --- | --- |
| Upstream master credentials | Exfiltration from DB / logs | Envelope encryption; ciphertext only; never log plaintext; break-glass audited |
| Pseudo device credentials | Stuffing / reuse | High-entropy issue; hash at rest; rate-limit proxy auth; revoke kills sessions |
| Control API | Unauthorized provisioning | API keys (later RBAC); audit all mutations; live org gated |
| NTRIP proxy | Abuse as open relay | Auth required; per-device session caps; no anonymous sourcetable publish in v0 |
| GGA / position | Surveillance product creep | Ephemeral last-sample only; no track store; metering forbids location fields |
| CPOS customer seats | ToS / legality breach | Adapter disabled until counsel; no secret ingest default |
| Metering → money | E-money / custody | Events only; PSP invoices; no wallets/credits endpoints |
| Dual-use misuse | Weapons / jam / sanctions | Screening gate + ToS + suspend right |

---

## 4. Explicit non-goals (reaffirm — do not ship)

1. No Kartverket CPOS displacement marketing.  
2. No GNSS spoof/jam products or attack tradecraft.  
3. No military guidance / anti-spoof packaging.  
4. No building CORS / base stations as v0.  
5. No fund custody / banking-licence path.  
6. No live tenant onboarding before screening.  
7. No CPOS adapter routing before counsel.  
8. No fleet track histories / location analytics.  
9. No Lenovo/PGx/SSD or Hetzner-as-idea product framing.

---

## 5. M0 → M3 checklist owners

| Item | Owner | Milestone |
| --- | --- | --- |
| Keep 403 screening gate in CI/contract tests | Builder | M0–M2 |
| ToS draft + screening runbook | Ops + counsel | M2→M3 |
| Screening provider / manual process | Ops (O9) | M3 |
| CPOS counsel (Kartverket ToS proxying) | Counsel (O1) | Unlock adapter |
| Audit/usage retention periods | Counsel + Ops (O6) | Before multi-tenant prod |

---

*Draft only. Not legal advice. Update after counsel review.*

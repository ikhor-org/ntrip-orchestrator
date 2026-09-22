# Non-goals (standing)

| Field | Value |
| --- | --- |
| **Status** | STANDING — align README, ToS draft, runbooks, and code gates with this list |
| **Date** | 22 Sep 2026 (Europe/Oslo) |
| **Source** | Architecture §3 · decision record · Sentinel counsel |

These constraints are product law for grokbot. Do not weaken them in marketing, demos, or pilot talk-tracks.

1. **No Kartverket CPOS replacement** — Do not market to Norwegian surveyors as a CPOS alternative; do not undercut CPOS survey pricing; do not claim to replace the national CORS for cadastral/survey workflows. CPOS may appear only as a *customer-supplied upstream* when the customer already holds a lawful subscription. Complement Kartverket; do not compete.

2. **No GNSS spoof / jam** — No jammers, spoofers, “test spoof kits,” or content that teaches RF attack tradecraft.

3. **No military guidance / anti-spoof product packaging** — No weapons guidance, munitions, or “military GNSS resilience” SKUs. Dual-use enterprise (agriculture, construction, civil UAS, robotics) only, with screening.

4. **No building CORS / base stations as the product** — Software orchestration only; do not become a network operator in v0.

5. **No fund custody / banking-licence path** — Metering events and invoicing via a licensed PSP only. No stored-value wallets or e-money float.

6. **No live self-serve org signup** — `POST /v0/orgs` (live) stays gated (`403 screening_required`). Pilots activate only via ops after `screening_status=cleared`.

7. **CPOS adapter only after counsel** — Keep customer-supplied CPOS stubbed until Kartverket ToS review clears. Do not block vault/proxy/failover on CPOS.

8. **No fleet track histories / location analytics** — GGA / last-position for live session health only. Metering = connect-minutes / bytes / device-days — not location analytics.

9. **No infra-as-product-story** — Hosting choices (e.g. Hetzner) are ops; they are not the idea.

---

Related: [`architecture.md`](architecture.md) §3 · [`tos-draft.md`](tos-draft.md) · runbooks under `docs/runbooks/`.

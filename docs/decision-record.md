# Decision record — GNSS RTK OEM/fleet correction orchestration

**Status:** LOCKED  
**Date:** 21 Sep 2026 (Europe/Oslo)  
**Source:** Scout deep-dive `/workspace/gnss-rtk-oem-fleet-orchestration-deep-dive.md`  
**Counsel:** Sentinel non-goals adopted as standing constraints  
**Owner:** Alexander Nathaniel Ness · team via director  

---

## Decision

We lock a **software-only** product wedge: **GNSS RTK correction orchestration** for OEM and fleet buyers — not another end-user survey CORS seat.

The product sits **above** correction networks: credential vault, multi-network failover, mountpoint routing, device provisioning, health/SLA visibility, and metering hooks. It is sold to machine OEMs, UAS fleets, autonomy stacks, and telematics/SIs. Upstream networks (incl. customer-supplied CPOS where lawful) are feeds, not the SKU.

**Why orchestration vs one CORS:** cross-border failover, OEM embed without exposing master logins, seasonal/pooled usage across providers, mixed-receiver fleets, and credential lifecycle regional nets rarely automate.

**Closest peers (context, not commitment):** RTK FIX (NL) — credential vault + multi-network API; Glopos (CZ) — white-label caster/reseller ops. Correction suppliers (Point One, Swift Skylark, GEODNET, HxGN SmartNet, Trimble RTX, u-blox PointPerfect) remain upstreams or alternatives.

Infra (e.g. Hetzner) is a later ops choice — not part of the idea.

---

## Non-goals (Sentinel counsel — standing)

1. **No Kartverket CPOS displacement** — do not market to Norwegian surveyors as a CPOS alternative, undercut CPOS survey pricing, or claim to replace national CORS for cadastral/survey. CPOS may appear only as a *customer-supplied upstream* when they already hold a lawful subscription.
2. **No GNSS spoof / jam** products, kits, or attack tradecraft content.
3. **No military guidance / anti-spoof product packaging** — dual-use enterprise (ag, construction, civil UAS, robotics) only, with screening.
4. **End-use screening in ToS & sales** — lawful civil/commercial use only; prohibit unauthorized surveillance, criminal use, weapons guidance, jam/spoof, sanctions violations; right to suspend; retain provisioning/access audit logs; customer owns upstream ToS (incl. CPOS).
5. **No holding customer funds / no banking-licence path** — metering + invoicing via licensed PSP only; no custodial wallets or e-money float.
6. **No building CORS / base stations as v0** — software orchestration only.
7. **No unrelated hardware or “hosting-as-idea” framing** in the product story.

---

## Beachhead ICPs (NO/EU) — outreach order A → B → C

| ICP | Who | Why first |
| --- | --- | --- |
| **A** | Nordic construction machine-control SIs & OEM channels (DigPilot / G&L ecosystem, L5 / Unicontrol channels, adjacent autonomy) | Already live with RTK on machines; pain is multi-brand fleets, network juggling, credential sharing — maps to vault + pseudo-creds + failover. Talk first. |
| **B** | EU/NO commercial UAS fleet & dock/BVLOS integrators | High device churn, contractor windows, cross-border missions; centralized provisioning for docks. |
| **C** | Nordic ag-autonomy / precision robot OEMs | Seasonal usage, multi-country expansion; OEM-embed API without running a CORS business. |

**Deprioritise for beachhead:** Norwegian cadastral survey shops on CPOS standard seats; consumer GNSS gadgets; anything needing military packaging.

---

## v0 must-haves

| Must ship in v0 | Notes |
| --- | --- |
| Credential vault | Encrypt provider creds/mountpoints; RBAC |
| Pseudo / disposable device credentials | Field never sees master login |
| Multi-network NTRIP mountpoint routing | Definition of the wedge |
| Failover policy | Ordered upstreams; health-triggered switch (start primary/secondary) |
| Device provisioning API | Create/revoke device; assign network profile |
| SLA / health monitoring | Caster reachability, stream rate, last GGA, fix-age proxy |
| Audit logs | Who provisioned/rotated/accessed what |
| Usage metering / billing hooks | Connect-minutes, bytes, device-days → webhook/export; **no** fund custody |

**v0 nice / later:** basic datum/epoch tagging; team workspaces; coverage pre-check; white-label portal; reseller hierarchy; geofenced entitlement; full datum transform; on-device fusion; L-band; own CORS — out of v0.

**Builder next:** thin orchestration plane (NTRIP proxy + vault + provisioning + health) that *consumes* public networks without owning base stations. Respect non-goals above.

---

## Open (do not invent)

Enterprise list prices for peers; SmartNet Norway portal SKUs; RTK FIX bake-off; counsel on “credits” structure and CPOS credential proxying vs Kartverket ToS.

---

*One-pager for handoff. Full evidence and sources: Scout deep-dive.*

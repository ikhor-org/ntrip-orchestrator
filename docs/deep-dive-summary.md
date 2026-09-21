# Deep-dive (summary + link)

Full Scout deep-dive lives on the Builder box at `/workspace/gnss-rtk-oem-fleet-orchestration-deep-dive.md` (not copied verbatim here — large brief).

## Locked wedge

Software-only GNSS RTK **correction orchestration** for OEM/fleet buyers: vault, multi-network failover, mountpoint routing, device provisioning, health/SLA, metering hooks. Upstream networks (incl. customer-supplied CPOS where lawful) are feeds, not the SKU.

## Constraints carried into this repo

- Non-goals: no CPOS displacement; no spoof/jam; no mil packaging; no CORS/base-station build; no fund custody; screening before live orgs; CPOS adapter post-counsel only; no track histories / no location metering.

- v0 must-haves: vault, pseudo-creds, multi-network NTRIP routing, failover policy, device provisioning API, health/SLA, audit, metering events (connect/bytes/device-days).

- Beachhead ICP order A→B→C (Nordic construction SI/OEM → EU/NO UAS → Nordic ag-autonomy).

See `architecture.md` §3 and `decision-record.md` for standing constraints.


# grokbot

**GNSS RTK correction orchestration** for OEMs and fleets.

Software that sits above correction networks: credential vault, multi-network NTRIP routing and failover, device provisioning, health/SLA, audit, and metering hooks. Upstream networks are feeds. Devices never see master logins.

Not another end-user survey CORS seat. Not a base-station network.

---

## One-sitting demo

Prove the plane locally: healthz up, mock caster streaming, proxy relays **MOCK**.

```bash
git clone https://github.com/AlexanderNess/grokbot.git
cd grokbot
cp .env.example .env
# .env already has a local-dev VAULT_KEK and ALLOW_FIXTURE_ORGS=true — replace before any shared host

docker compose --profile mock-caster up -d --build

curl -fsS http://127.0.0.1:8080/healthz
# expect JSON with ok: true
```

Wire the fixture org to the compose mock caster (host `mock-caster`, port `2102`, mount `MOCK`):

```bash
export API=http://127.0.0.1:8080
FIXTURE_ORG=00000000-0000-4000-8000-000000000001

UP=$(curl -fsS -X POST "$API/v0/fixture/upstream-secret" \
  -H 'content-type: application/json' \
  -d '{"display_name":"mock-caster","host":"mock-caster","port":2102,"mountpoint":"MOCK","username":"mock","password":"mock"}')
echo "$UP"
UPSTREAM_ID=$(echo "$UP" | jq -r .upstream_id)

PROFILE=$(curl -fsS -X POST "$API/v0/orgs/$FIXTURE_ORG/profiles" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"demo-mock\",\"candidates\":[{\"priority\":1,\"upstream_endpoint_id\":\"$UPSTREAM_ID\"}]}")
PROFILE_ID=$(echo "$PROFILE" | jq -r .id)

DEV=$(curl -fsS -X POST "$API/v0/orgs/$FIXTURE_ORG/devices" \
  -H 'content-type: application/json' \
  -d "{\"label\":\"demo-rover\",\"profile_id\":\"$PROFILE_ID\"}")
echo "$DEV"
# save pseudo_username / pseudo_password from the response
```

NTRIP client → `127.0.0.1:2101`, mountpoint **MOCK**, user/pass = the device pseudo-credentials. You should see a continuous mock RTCM-ish stream from the caster through the proxy.

Failover demo (two upstreams, kill primary): `docs/runbooks/m2-failover-demo.md`.  
Prod-shaped smoke (fixtures off, ops pilot path, SSH tunnel): `docs/runbooks/hetzner-deploy.md` §9.

---

## What it does

| Capability | Role |
| --- | --- |
| Credential vault | AES-256-GCM; master upstream secrets stay server-side |
| Pseudo-credentials | Field devices authenticate with disposable logins |
| NTRIP proxy | Relays RTCM; policy picks primary/secondary with hysteresis |
| Provisioning API | Devices, profiles, org API keys (`admin` / `operator` / `read`) |
| Health / audit / usage | Path visibility, append-only audit, metering hooks (not fund custody) |
| Screening gate | Live orgs activate only after ops clearance — no self-serve signup |

Stack: TypeScript (Node 20+) monorepo — `packages/core`, `packages/api`, `packages/proxy`, `packages/adapters`. PostgreSQL migrations ship with compose; runtime store is still shared JSON (`GROKBOT_STORE_PATH`) until a PG adapter lands.

OpenAPI: `docs/openapi/openapi.yaml`.

---

## Non-goals

Standing constraints — full list in [`docs/NON-GOALS.md`](docs/NON-GOALS.md):

- No Kartverket CPOS replacement for Norwegian surveyors
- No GNSS spoof / jam products or marketing
- No military guidance packaging
- No building CORS / base stations as the product
- No holding customer funds
- No live self-serve org signup (ops-screened pilots only)
- CPOS adapter only after counsel; no fleet track histories

---

## License

**Dual-licensed.**

- **Open:** [GNU Affero General Public License v3](LICENSE) (AGPL-3.0). Use, study, modify, and run the software under AGPL; network use requires offering corresponding source.
- **Commercial:** Closed-source embed, proprietary redistribution, or SaaS without AGPL obligations requires a separate commercial license — see [`COMMERCIAL.md`](COMMERCIAL.md).

Final commercial terms are owned by Alexander Ness. Nothing in this repo is legal advice.

---

## Build / test

```bash
npm install
npm run build
npm run lint
npm test
```

Local without Docker: set `VAULT_KEK` and `GROKBOT_STORE_PATH`, then `npm run dev:api` and `npm run dev:proxy` (see `.env.example`).

---

## Docs map

| Doc | Purpose |
| --- | --- |
| [`COMMERCIAL.md`](COMMERCIAL.md) | Commercial license request stub |
| [`docs/NON-GOALS.md`](docs/NON-GOALS.md) | Standing product/legal constraints |
| [`docs/architecture.md`](docs/architecture.md) | v0 architecture |
| [`docs/runbooks/`](docs/runbooks/) | Screening, rotate/revoke, suspend, deploy, failover |
| [`docs/tos-draft.md`](docs/tos-draft.md) | ToS draft — not production Terms |

---

*The software is the argument. Run the demo.*

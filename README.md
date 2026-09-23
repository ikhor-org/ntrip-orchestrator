# grokbot

**GNSS RTK correction orchestration** for OEMs and fleets.

Software that sits above correction networks: credential vault, multi-network NTRIP routing and failover, device provisioning, health/SLA, audit, and metering hooks. Upstream networks are feeds. Devices never see master logins.

Not another end-user survey CORS seat. Not a base-station network.

**License:** AGPL-3.0-or-later (self-run). Dual-license is legal armor for closed embed — see `LICENSE`, `NOTICE`, and [`COMMERCIAL.md`](COMMERCIAL.md). No hosted SaaS product.

---

## One-sitting demo

Localhost only (API/proxy bind `127.0.0.1` by default). Prove the plane: healthz up, mock caster streaming, proxy relays **MOCK**.

**Automated (CI + cold clone):** Docker, `curl`, and `jq` required.

```bash
git clone https://github.com/AlexanderNess/grokbot.git
cd grokbot
./scripts/smoke-local.sh
# copies .env.example → .env if needed, boots compose --profile mock-caster,
# asserts GET /healthz and NTRIP MOCK ICY/200 with body bytes (curl timeout OK)
```

GitHub Actions workflow `.github/workflows/local-compose-smoke.yml` runs the same script on PRs/pushes to `main`.

### Manual steps (same path the script follows)

```bash
cp .env.example .env
# .env has a local-dev VAULT_KEK and ALLOW_FIXTURE_ORGS=true — replace before any shared host

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

Quick NTRIP assert (streaming; curl exit 28 after `--max-time` is fine if headers show ICY/200 and body has bytes):

```bash
curl -v -N --http0.9 -u "$PSEUDO_USER:$PSEUDO_PASS" --max-time 3 "http://127.0.0.1:2101/MOCK"
```

Failover demo (fixture lab, two upstreams): `docs/runbooks/m2-failover-demo.md`.  
**Real / sandbox caster** (ops vault, fixtures off, dual-endpoint connect-fail failover): `docs/runbooks/customer-ntrip-caster.md`.  
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

**Product:** self-run under [AGPL-3.0-or-later](LICENSE). Clone and operate it yourself. Copyright and SPDX: see [`NOTICE`](NOTICE).

**Dual-license (legal armor only):** a separate commercial license may cover **closed embed** or **closed redistribution** without AGPL obligations — see [`COMMERCIAL.md`](COMMERCIAL.md). That is not a hosted SaaS offering and not a product roadmap item.

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
| [`COMMERCIAL.md`](COMMERCIAL.md) | Commercial closed-embed rights stub (not a SaaS offer) |
| [`NOTICE`](NOTICE) | Copyright + dual-license notice |
| [`docs/NON-GOALS.md`](docs/NON-GOALS.md) | Standing product/legal constraints |
| [`docs/architecture.md`](docs/architecture.md) | v0 architecture |
| [`docs/runbooks/`](docs/runbooks/) | Screening, rotate/revoke, suspend, deploy, customer NTRIP caster, failover |
| [`docs/tos-draft.md`](docs/tos-draft.md) | ToS draft — not production Terms |

---

*The software is the argument. Run the demo.*

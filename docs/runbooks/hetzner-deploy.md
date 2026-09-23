# Hetzner deploy runbook (Ubuntu + Docker)

Copy-pasteable steps for Ops/director on an Ubuntu VPS (e.g. Hetzner Cloud).  
**You do not need Hetzner console credentials in this repo** — SSH as the operator who owns the box.

| Field | Value |
| --- | --- |
| **Stack** | `api` :8080, `proxy` :2101 (NTRIP), `postgres` (migrations on init) |
| **Runtime store** | Still **JSON** via `GROKBOT_STORE_PATH` (shared volume). Postgres is **provisioned ready**; app adapter to PG is a later PR. |
| **Health** | `GET /healthz` on the API (not `/v0/health`) |
| **Constraints** | No CPOS; no track histories; screening still required for live orgs; `ALLOW_FIXTURE_ORGS=false` in prod |

---

## 1. Install Docker (Ubuntu)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
# Log out/in (or newgrp docker) so group membership applies
docker version
docker compose version
```

---

## 2. Clone / pull the repo

```bash
# First time
sudo mkdir -p /opt/ntrip-orchestrator
sudo chown "$USER:$USER" /opt/ntrip-orchestrator
git clone https://github.com/ikhor-org/ntrip-orchestrator.git /opt/ntrip-orchestrator
cd /opt/ntrip-orchestrator

# Updates
cd /opt/ntrip-orchestrator
git fetch origin
git checkout main
git pull --ff-only origin main
```

---

## 3. Secrets (never commit)

```bash
cd /opt/ntrip-orchestrator
cp .env.example .env
chmod 600 .env

# Generate real secrets — do NOT use the local-dev placeholders from .env.example
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → VAULT_KEK
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → OPS_API_KEY
node -e "console.log(require('crypto').randomBytes(24).toString('base64'))" # → POSTGRES_PASSWORD
```

Edit `.env` and set at least:

- `NODE_ENV=production`
- `ALLOW_FIXTURE_ORGS=false`
- `VAULT_KEK=` (from generator above)
- `OPS_API_KEY=` (from generator above)
- `POSTGRES_PASSWORD=` (strong; required by prod overlay)
- `CPOS_ADAPTER_ENABLED=false`
- `API_BIND=127.0.0.1` and `PROXY_BIND=127.0.0.1` (loopback; smoke via SSH tunnel — §9)

Keep `.env` only on the server (or a secrets manager). Never commit it; `.gitignore` already ignores `.env`.

---

## 4. Firewall (ufw) — prefer SSH-only for smoke

Set `API_BIND=127.0.0.1` and `PROXY_BIND=127.0.0.1` in `.env` so API/proxy listen on loopback only. For bring-up and prod smoke, **do not** open 8080/2101 in ufw — use SSH local forwards (see §9).

```bash
sudo apt-get install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'SSH'
# Do NOT open 8080/2101 for prod smoke (use API_BIND/PROXY_BIND=127.0.0.1 + SSH tunnel).
# Do NOT open 5432 publicly — Postgres is compose-network-only.
sudo ufw enable
sudo ufw status verbose
```

If you previously allowed 8080/2101 for an older bring-up, remove them before smoke (`sudo ufw delete allow 8080/tcp` etc.).

---

## 5. Bring the stack up (production overlay)

```bash
cd /opt/ntrip-orchestrator
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f --tail=100
```

Migrations under `migrations/*.sql` are mounted into Postgres `docker-entrypoint-initdb.d` and run **once** on first empty data volume (alphabetical `001_`…`004_`).

If you need to re-apply by hand (new volume or ops recovery) — Postgres is **not** published on the host; use `exec`:

```bash
cd /opt/ntrip-orchestrator
for f in migrations/001_initial.sql migrations/002_m1_sessions.sql          migrations/003_m2_profiles_usage.sql migrations/004_m3_screening_rbac.sql; do
  docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres     psql -U grokbot -d grokbot < "$f"
done
```

---

## 6. Health checks

```bash
# On the server (with API_BIND=127.0.0.1)
curl -fsS http://127.0.0.1:8080/healthz | jq .
# Expect: ok=true, service=ntrip-orchestrator-api, milestone=M3

# From your laptop via SSH tunnel (see §9) — not a public HOST:8080
curl -fsS http://127.0.0.1:8080/healthz
```

Proxy has no HTTP health route; confirm the port is listening:

```bash
ss -lntp | grep -E ':2101|:8080'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec proxy \
  node -e "require('net').createServer().listen(0,()=>process.exit(0))"
```

---

## 7. TLS (Caddy sketch — or defer)

**Deferred by default:** the compose stack serves plain HTTP/TCP. For production TLS, put Caddy (or another reverse proxy) in front of the API; NTRIP TLS is a separate decision (often terminate TLS on a dedicated frontier or leave 2101 as TCP for caster clients).

Optional Caddy sketch (install Caddy separately; not shipped in this compose):

```caddyfile
# /etc/caddy/Caddyfile — sketch only
api.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Then ufw allow `80`/`443` and optionally stop publishing `8080` publicly (bind API to loopback and proxy via Caddy). **If TLS is not ready, leave this section deferred** and keep API on 8080 with network/firewall controls only.

---

## 8. Prod policy reminders

- **`ALLOW_FIXTURE_ORGS=false`** — prod overlay sets this; app also blocks fixtures when `NODE_ENV=production`.
- **No fixture orgs in prod** — pilots go through ops: `POST /v0/ops/pilot-orgs` → screening → activate (`X-Ops-Key`).
- **Screening still required** for live orgs (`POST /v0/orgs` remains `403 screening_required`).
- **No CPOS** — `CPOS_ADAPTER_ENABLED=false`; CPOS stays out of the routable registry until counsel clears Kartverket ToS.
- **No track histories** — GGA/last-position for live session health only; metering = connect / bytes / device-days.
- **JSON vs Postgres** — shared volume JSON store is still the runtime; Postgres holds schema for a future adapter. Do not assume app reads/writes SQL yet.

Related runbooks: `screening-workflow.md`, `credential-rotate-revoke.md`, `org-suspend.md`.

---

## 9. Prod NTRIP smoke via SSH tunnel (fixtures off)

**Goal:** Seed a vaulted upstream for an **activated pilot org** with `ALLOW_FIXTURE_ORGS=false`, bind a device/profile, and confirm the proxy relays a clear mock/RTCM-ish stream — **without** opening public 8080/2101 for smoke and **without** third-party vendor creds in chat.

### 9.1 Firewall note (prod smoke)

Section 4 above documents opening 8080/2101 for a first bring-up. For **prod smoke**, prefer **not** exposing those ports publicly:

```bash
# If you previously allowed them for bring-up, remove public access for smoke:
sudo ufw delete allow 8080/tcp || true
sudo ufw delete allow 2101/tcp || true
sudo ufw status verbose
# Keep SSH (22). API + NTRIP stay on loopback / compose network; reach them via SSH forwards.
```

### 9.2 SSH local forwards (from your laptop)

```bash
# Replace USER@HOST with the VPS SSH target
ssh -N \
  -L 8080:127.0.0.1:8080 \
  -L 2101:127.0.0.1:2101 \
  USER@HOST
```

Then all `curl` / NTRIP client calls below use `http://127.0.0.1:8080` and `127.0.0.1:2101` on the laptop.

### 9.3 Start mock caster (compose profile — preferred)

On the VPS (no vendor secrets required):

```bash
cd /opt/ntrip-orchestrator
# Optional: set dummy creds in .env (never commit). Defaults are mock/mock if unset in compose.
# MOCK_CASTER_USER=mock
# MOCK_CASTER_PASS=mock
# MOCK_CASTER_MOUNT=MOCK

docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env \
  --profile mock-caster up -d mock-caster

# Confirm it is up (internal only — not published to the host)
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile mock-caster ps mock-caster
```

Proxy reaches the caster as hostname `mock-caster` port `2102` on the compose network.

**Alternative:** run on the host loopback only:

```bash
MOCK_CASTER_PORT=2102 MOCK_CASTER_USER=mock MOCK_CASTER_PASS=mock \
  node scripts/mock-ntrip-caster.mjs
# Then vault host=127.0.0.1 — but the proxy container cannot reach host loopback
# unless you use host networking or host.docker.internal. Prefer compose mock-caster.
```

**Existing test caster you control:** instead of mock-caster, vault `host` / `port` / `mountpoint` / `username` / `password` pointing at that caster. Provide those values **only at runtime on the server** (shell env or `.env` never committed) — **no secrets in docs or chat**.

### 9.4 Ops HTTP calls (placeholders only)

Load `$OPS_API_KEY` from the server `.env` (never paste real keys into tickets/chat).

```bash
# On laptop (with SSH tunnel) OR on the VPS via 127.0.0.1
export API=http://127.0.0.1:8080
# export OPS_API_KEY=...   # from server .env — do not commit

# 0) Health
curl -fsS "$API/healthz" | jq .

# 1) Pilot intake → screening → activate (if no active pilot yet)
ORG_ID=$(curl -fsS -X POST "$API/v0/ops/pilot-orgs" \
  -H "content-type: application/json" \
  -H "X-Ops-Key: $OPS_API_KEY" \
  -d '{
    "name": "Pilot Smoke SI",
    "country": "NO",
    "icp_segment": "A",
    "end_use_representation": "Civil construction machine-control smoke"
  }' | jq -r .id)

curl -fsS -X POST "$API/v0/orgs/$ORG_ID/screening" \
  -H "content-type: application/json" \
  -H "X-Ops-Key: $OPS_API_KEY" \
  -d '{
    "result": "cleared",
    "screening_reference": "SCR-SMOKE-LOCAL",
    "prohibited_use_attested": true,
    "sanctions_cleared": true,
    "upstream_tos_acknowledged": true
  }' | jq .

curl -fsS -X POST "$API/v0/orgs/$ORG_ID/activate" \
  -H "X-Ops-Key: $OPS_API_KEY" | jq .

# 2) Vault upstream for the activated org (NOT /v0/fixture/*)
# Password below is a local dummy for mock-caster — replace at runtime; never commit.
UP=$(curl -fsS -X POST "$API/v0/ops/orgs/$ORG_ID/upstreams" \
  -H "content-type: application/json" \
  -H "X-Ops-Key: $OPS_API_KEY" \
  -d "{
    \"display_name\": \"mock-caster\",
    \"host\": \"mock-caster\",
    \"port\": 2102,
    \"mountpoint\": \"MOCK\",
    \"username\": \"${MOCK_CASTER_USER:-mock}\",
    \"password\": \"${MOCK_CASTER_PASS:-mock}\"
  }")
echo "$UP" | jq .
UPSTREAM_ID=$(echo "$UP" | jq -r .upstream_id)

# 3) Bind profile → device (profile candidates use upstream_endpoint_id)
PROFILE_ID=$(curl -fsS -X POST "$API/v0/orgs/$ORG_ID/profiles" \
  -H "content-type: application/json" \
  -d "{
    \"name\": \"pilot-smoke\",
    \"candidates\": [
      { \"priority\": 1, \"upstream_endpoint_id\": \"$UPSTREAM_ID\" }
    ]
  }" | jq -r .id)

DEV=$(curl -fsS -X POST "$API/v0/orgs/$ORG_ID/devices" \
  -H "content-type: application/json" \
  -H "X-Ops-Key: $OPS_API_KEY" \
  -d "{\"label\": \"smoke-rover\", \"profile_id\": \"$PROFILE_ID\"}")
echo "$DEV" | jq 'del(.pseudo_password)'   # avoid echoing password into logs if possible
USER=$(echo "$DEV" | jq -r .pseudo_username)
PASS=$(echo "$DEV" | jq -r .pseudo_password)

# 4) NTRIP smoke against proxy via SSH tunnel (mount from vault / profile)
# Expect ICY 200 / RTCM-ish bytes from mock-caster through the proxy.
curl -v -u "$USER:$PASS" "http://127.0.0.1:2101/MOCK" --max-time 5 | xxd | head
```

Fixture route must stay closed in prod:

```bash
curl -sS -X POST "$API/v0/fixture/upstream-secret" \
  -H "content-type: application/json" \
  -d '{"host":"x","username":"u","password":"p"}' | jq .
# Expect: 403 fixture_org_only
```

### 9.5 Success criteria

- Ops vault `201` with `upstream_id` / `secret_id` / `last4` / host / port (no password).
- Device provision `201` with `profile_id` bound to that upstream.
- Proxy dials vaulted caster (mock or your test caster) and returns a clear stream over the SSH tunnel.
- `ALLOW_FIXTURE_ORGS=false` throughout; `/v0/fixture/*` remains 403.

Related: `screening-workflow.md`, [`customer-ntrip-caster.md`](customer-ntrip-caster.md) (real/sandbox caster + ops dual failover), `m2-failover-demo.md` (fixture-only demos).

### 9.6 Customer / sandbox caster (beyond mock)

For an operator-owned or customer NTRIP seat (not compose `mock-caster`), vault `$NTRIP_HOST` / `$NTRIP_PORT` / `$NTRIP_MOUNT` / `$NTRIP_USER` / `$NTRIP_PASS` via the same `POST /v0/ops/orgs/$ORG_ID/upstreams` call — **placeholders only in docs/chat**. Full steps, dual-endpoint connect-fail failover, and rotate pointers: [`customer-ntrip-caster.md`](customer-ntrip-caster.md).

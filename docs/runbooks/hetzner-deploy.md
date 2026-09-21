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
sudo mkdir -p /opt/grokbot
sudo chown "$USER:$USER" /opt/grokbot
git clone https://github.com/AlexanderNess/grokbot.git /opt/grokbot
cd /opt/grokbot

# Updates
cd /opt/grokbot
git fetch origin
git checkout main
git pull --ff-only origin main
```

---

## 3. Secrets (never commit)

```bash
cd /opt/grokbot
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

Keep `.env` only on the server (or a secrets manager). Never commit it; `.gitignore` already ignores `.env`.

---

## 4. Firewall (ufw) — 8080, 2101, 22

```bash
sudo apt-get install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'SSH'
sudo ufw allow 8080/tcp comment 'grokbot API'
sudo ufw allow 2101/tcp comment 'grokbot NTRIP proxy'
# Do NOT open 5432 publicly — Postgres is loopback-only under prod overlay
sudo ufw enable
sudo ufw status verbose
```

---

## 5. Bring the stack up (production overlay)

```bash
cd /opt/grokbot
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f --tail=100
```

Migrations under `migrations/*.sql` are mounted into Postgres `docker-entrypoint-initdb.d` and run **once** on first empty data volume (alphabetical `001_`…`004_`).

If you need to re-apply by hand (new volume or ops recovery) — Postgres is **not** published on the host; use `exec`:

```bash
cd /opt/grokbot
for f in migrations/001_initial.sql migrations/002_m1_sessions.sql          migrations/003_m2_profiles_usage.sql migrations/004_m3_screening_rbac.sql; do
  docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres     psql -U grokbot -d grokbot < "$f"
done
```

---

## 6. Health checks

```bash
# On the server
curl -fsS http://127.0.0.1:8080/healthz | jq .
# Expect: ok=true, service=grokbot-api, milestone=M3

# From outside (replace HOST)
curl -fsS http://HOST:8080/healthz
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

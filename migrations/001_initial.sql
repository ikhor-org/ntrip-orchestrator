-- M0 initial schema stubs — GNSS RTK orchestration
-- NO production secrets. Ciphertext placeholders only.
-- Fixture orgs OK in non-prod; live org activation gated by screening_status.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Orgs: live create gated until screening cleared (architecture §3.6 / §10 / §11)
CREATE TABLE orgs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending_screening'
                    CHECK (status IN ('fixture', 'pending_screening', 'active', 'suspended')),
  screening_status  TEXT NOT NULL DEFAULT 'required'
                    CHECK (screening_status IN ('required', 'pending', 'cleared', 'rejected', 'fixture_exempt')),
  screening_at      TIMESTAMPTZ,
  screening_reference TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT orgs_active_requires_cleared
    CHECK (status <> 'active' OR screening_status = 'cleared')
);

CREATE TABLE profiles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs (id),
  name         TEXT NOT NULL,
  policy_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  datum_tag    TEXT,
  epoch_tag    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs (id),
  profile_id   UUID REFERENCES profiles (id),
  label        TEXT,
  tags         TEXT[] NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'revoked')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ
);

-- Pseudo credentials: hash only (argon2id at app layer). Never store plaintext password.
CREATE TABLE pseudo_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     UUID NOT NULL REFERENCES devices (id),
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  version       INT NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upstream endpoints. adapter_type cpos_customer may exist in schema but must not be routed until counsel.
CREATE TABLE upstream_endpoints (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES orgs (id),
  adapter_type       TEXT NOT NULL
                     CHECK (adapter_type IN (
                       'ntrip_basic',
                       'point_one_token',
                       'geodnet_enterprise',
                       'skylark',
                       'smartnet',
                       'cpos_customer'
                     )),
  display_name       TEXT NOT NULL,
  host               TEXT NOT NULL,
  port               INT NOT NULL DEFAULT 2101,
  use_tls            BOOLEAN NOT NULL DEFAULT false,
  default_mountpoint TEXT,
  options_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled            BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vault secrets: ciphertext + nonce + key_version only. Never a plaintext column.
CREATE TABLE vault_secrets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upstream_id  UUID NOT NULL REFERENCES upstream_endpoints (id),
  secret_type  TEXT NOT NULL
               CHECK (secret_type IN ('ntrip_basic', 'bearer_token', 'api_key_pair', 'opaque_blob')),
  ciphertext   BYTEA NOT NULL,  -- placeholder envelope ciphertext (no production KEK in M0)
  nonce        BYTEA NOT NULL,
  key_version  INT NOT NULL DEFAULT 1,
  last4        TEXT,
  rotated_at   TIMESTAMPTZ,
  disabled_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit
CREATE TABLE audit_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID REFERENCES orgs (id),
  actor_type    TEXT NOT NULL,
  actor_id      TEXT,
  event_type    TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  payload_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Metering: connect / bytes / device-days ONLY.
-- FORBIDDEN in payload_json: lat, lon, gga, track, geofence, or any location analytics fields.
CREATE TABLE metering_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs (id),
  device_id    UUID REFERENCES devices (id),
  session_id   UUID,
  event_type   TEXT NOT NULL
               CHECK (event_type IN (
                 'usage.session_started',
                 'usage.session_ended',
                 'usage.tick',
                 'usage.device_day'
               )),
  -- Expected payload keys by type (enforced in app, not DB):
  -- session_started: org_id, device_id, session_id, upstream_id, ts
  -- session_ended: session_id, duration_ms, bytes_up, bytes_down, end_reason
  -- tick: session_id, delta_bytes, delta_ms
  -- device_day: org_id, device_id, day, active_seconds
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_org_ts_idx ON audit_events (org_id, ts DESC);
CREATE INDEX metering_events_org_ts_idx ON metering_events (org_id, ts DESC);
CREATE INDEX devices_org_idx ON devices (org_id);
CREATE INDEX upstream_endpoints_org_idx ON upstream_endpoints (org_id);

COMMENT ON TABLE vault_secrets IS 'Ciphertext only — no plaintext secrets; M0 has no production KEK';
COMMENT ON TABLE metering_events IS 'No lat/lon/GGA/track fields — connect/bytes/device-days only';
COMMENT ON COLUMN orgs.screening_status IS 'Live org POST gated until cleared; fixture_exempt for non-prod fixtures only';

COMMIT;

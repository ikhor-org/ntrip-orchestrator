-- M1: ephemeral session health + indexes. Track histories are NOT stored.
-- Live last_position lives in app memory only and is dropped on session end.

BEGIN;

CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY,
  device_id     UUID NOT NULL REFERENCES devices (id),
  org_id        UUID NOT NULL REFERENCES orgs (id),
  profile_id    UUID REFERENCES profiles (id),
  upstream_id   UUID REFERENCES upstream_endpoints (id),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  bytes_up      BIGINT NOT NULL DEFAULT 0,
  bytes_down    BIGINT NOT NULL DEFAULT 0,
  end_reason    TEXT,
  failover_count INT NOT NULL DEFAULT 0
);

-- Health samples are optional operational rows; do NOT store trajectories.
-- last_gga_age is derived at read time from last_gga_at; no lat/lon columns.
CREATE TABLE IF NOT EXISTS session_health_live (
  session_id    UUID PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  last_gga_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  -- Explicitly NO lat/lon/position columns — ephemeral position stays in process memory only
);

CREATE INDEX IF NOT EXISTS sessions_org_started_idx ON sessions (org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS pseudo_credentials_device_idx ON pseudo_credentials (device_id);
CREATE INDEX IF NOT EXISTS vault_secrets_upstream_idx ON vault_secrets (upstream_id);

COMMENT ON TABLE session_health_live IS 'Live session GGA age only — drop row on session end; no track history; no lat/lon columns';
COMMENT ON TABLE sessions IS 'Session metering facts (bytes/duration) — no location fields';

COMMIT;

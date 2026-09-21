-- M2: profile policy already in 001; add usage webhooks + audit/metering filter indexes.
-- Failover hysteresis lives in profile.policy_json (unhealthy_after_ms, max_switches_per_hour).

BEGIN;

CREATE TABLE IF NOT EXISTS usage_webhooks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs (id),
  url         TEXT NOT NULL,
  -- HMAC secret stored hashed or sealed in prod; M2 app store keeps secret for local only
  secret_hash TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_webhooks_org_idx ON usage_webhooks (org_id);
CREATE INDEX IF NOT EXISTS audit_events_org_type_ts_idx
  ON audit_events (org_id, event_type, ts DESC);
CREATE INDEX IF NOT EXISTS audit_events_org_device_ts_idx
  ON audit_events (org_id, (payload_json->>'device_id'), ts DESC);
CREATE INDEX IF NOT EXISTS profiles_org_idx ON profiles (org_id);

COMMENT ON TABLE usage_webhooks IS 'Signed usage export sinks — metering connect/bytes/device-days only; no lat/lon';
COMMENT ON COLUMN profiles.policy_json IS 'ProfilePolicy: candidates[] + failover{unhealthy_after_ms,max_switches_per_hour,on_exhaust}';

COMMIT;

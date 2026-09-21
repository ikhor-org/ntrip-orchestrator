-- M3: screening unlock + RBAC basics (API key roles)
-- Live self-serve org create remains gated. Pilot activation requires screening_status=cleared.
-- CPOS adapter stays disabled / not registered.

BEGIN;

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS country TEXT,
  ADD COLUMN IF NOT EXISTS icp_segment TEXT
    CHECK (icp_segment IS NULL OR icp_segment IN ('A', 'B', 'C', 'other')),
  ADD COLUMN IF NOT EXISTS end_use_representation TEXT,
  ADD COLUMN IF NOT EXISTS prohibited_use_attested BOOLEAN,
  ADD COLUMN IF NOT EXISTS sanctions_cleared BOOLEAN,
  ADD COLUMN IF NOT EXISTS upstream_tos_acknowledged BOOLEAN,
  ADD COLUMN IF NOT EXISTS screening_notes TEXT,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

-- Keep engineering gate: active requires cleared
ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_active_requires_cleared;
ALTER TABLE orgs
  ADD CONSTRAINT orgs_active_requires_cleared
  CHECK (status <> 'active' OR screening_status = 'cleared');

CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs (id),
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  role         TEXT NOT NULL
               CHECK (role IN ('admin', 'operator', 'read')),
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_keys_org_id_idx ON api_keys (org_id);
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys (key_prefix);

COMMENT ON TABLE api_keys IS 'Org-scoped API keys; plaintext returned once at create; hash only stored';
COMMENT ON COLUMN orgs.icp_segment IS 'Beachhead ICP — pilots prefer A (Nordic construction machine-control SI/OEM)';

COMMIT;

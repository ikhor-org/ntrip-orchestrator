export type OrgStatus = 'fixture' | 'pending_screening' | 'active' | 'suspended';
export type ScreeningStatus =
  | 'required'
  | 'pending'
  | 'cleared'
  | 'rejected'
  | 'fixture_exempt';

/** Beachhead ICP from deep-dive §5 — prefer A for pilots. */
export type IcpSegment = 'A' | 'B' | 'C' | 'other';

export interface Org {
  id: string;
  name: string;
  status: OrgStatus;
  screening_status: ScreeningStatus;
  /** ISO country of legal entity (sanctions/export hook). */
  country?: string;
  /** ICP segment — pilots prefer A (Nordic construction machine-control SI/OEM). */
  icp_segment?: IcpSegment;
  /** Civil/commercial end-use representation captured at screening. */
  end_use_representation?: string;
  /** Customer attested prohibited-use acknowledgment. */
  prohibited_use_attested?: boolean;
  /** Sanctions/export screening performed on org identity. */
  sanctions_cleared?: boolean;
  /** Customer owns upstream network ToS (recorded acknowledgment). */
  upstream_tos_acknowledged?: boolean;
  screening_at?: string;
  screening_reference?: string;
  screening_notes?: string;
  activated_at?: string;
  suspended_at?: string;
  suspended_reason?: string;
  created_at?: string;
}

/** API key roles — architecture §10.1. */
export type ApiKeyRole = 'admin' | 'operator' | 'read';

export interface ApiKeyRecord {
  id: string;
  org_id: string;
  /** Public prefix for identification (e.g. gbk_xxxx…). */
  key_prefix: string;
  /** scrypt hash of full secret — never store plaintext. */
  key_hash: string;
  role: ApiKeyRole;
  label?: string;
  created_at: string;
  revoked_at?: string;
  last_used_at?: string;
}

export interface Device {
  id: string;
  org_id: string;
  profile_id?: string;
  label?: string;
  tags: string[];
  status: 'active' | 'revoked';
  created_at: string;
  revoked_at?: string;
}

export interface PseudoCredential {
  id: string;
  device_id: string;
  username: string;
  password_hash: string;
  expires_at?: string;
  revoked_at?: string;
  version: number;
  created_at: string;
}

export type AdapterType =
  | 'ntrip_basic'
  | 'point_one_token'
  | 'geodnet_enterprise'
  | 'skylark'
  | 'smartnet'
  | 'cpos_customer';

export interface UpstreamEndpoint {
  id: string;
  org_id: string;
  adapter_type: AdapterType;
  display_name: string;
  host: string;
  port: number;
  use_tls: boolean;
  default_mountpoint?: string;
  options_json: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
}

export type SecretType =
  | 'ntrip_basic'
  | 'bearer_token'
  | 'api_key_pair'
  | 'opaque_blob';

export interface VaultSecretRecord {
  id: string;
  upstream_id: string;
  secret_type: SecretType;
  ciphertext: Buffer;
  nonce: Buffer;
  key_version: number;
  last4?: string;
  rotated_at?: string;
  disabled_at?: string;
  created_at: string;
}

/** Plaintext ntrip_basic secret — never persist or log. */
export interface NtripBasicSecret {
  username: string;
  password: string;
  /** Optional overrides if not on upstream endpoint. */
  host?: string;
  port?: number;
  mountpoint?: string;
}

export interface AuditEvent {
  id: string;
  org_id?: string;
  actor_type: string;
  actor_id?: string;
  event_type: string;
  resource_type?: string;
  resource_id?: string;
  payload_json: Record<string, unknown>;
  ts: string;
}

export type MeteringEventType =
  | 'usage.session_started'
  | 'usage.session_ended'
  | 'usage.tick'
  | 'usage.device_day';

export interface MeteringEvent {
  id: string;
  org_id: string;
  device_id?: string;
  session_id?: string;
  event_type: MeteringEventType;
  payload_json: Record<string, unknown>;
  ts: string;
}

export interface LiveSessionHealth {
  session_id: string;
  device_id: string;
  org_id: string;
  profile_id?: string;
  upstream_id?: string;
  started_at: string;
  /** Health-only; overwritten; dropped on session end. */
  last_gga_at?: string;
  /** Ephemeral last position for live session only — never in metering. */
  last_position?: { lat: number; lon: number };
  bytes_up: number;
  bytes_down: number;
  failover_count: number;
  /** Current upstream stream status for health API. */
  upstream_ok?: boolean;
}

/** Architecture §5.4 ProfilePolicy */
export interface ProfileCandidate {
  priority: number;
  upstream_endpoint_id: string;
  mountpoint_override?: string;
  min_health?: 'ok';
}

export interface FailoverPolicy {
  unhealthy_after_ms: number;
  max_switches_per_hour: number;
  on_exhaust: 'reject' | 'keep_last_best_effort';
}

export interface ProfilePolicy {
  profile_id?: string;
  candidates: ProfileCandidate[];
  failover: FailoverPolicy;
  datum_tag?: string;
  epoch_tag?: string;
}

export interface Profile {
  id: string;
  org_id: string;
  name: string;
  policy_json: ProfilePolicy;
  datum_tag?: string;
  epoch_tag?: string;
  created_at: string;
}

export type UpstreamHealthStatus = 'ok' | 'degraded' | 'unreachable' | 'unknown';

export interface UpstreamHealthSnapshot {
  upstream_id: string;
  org_id: string;
  status: UpstreamHealthStatus;
  reachable: boolean;
  last_ok_at?: string;
  last_fail_at?: string;
  last_error?: string;
  /** Rolling connect success rate 0..1 if known. */
  recent_success_rate?: number;
  updated_at: string;
}

export interface UsageWebhook {
  id: string;
  org_id: string;
  url: string;
  /** HMAC secret for signed delivery — never expose in list responses. */
  secret: string;
  enabled: boolean;
  created_at: string;
}

export const DEFAULT_FAILOVER: FailoverPolicy = {
  unhealthy_after_ms: 30_000,
  max_switches_per_hour: 10,
  on_exhaust: 'reject',
};

export type FailoverReasonCode =
  | 'primary_ok'
  | 'primary_unreachable'
  | 'primary_unhealthy'
  | 'switched_secondary'
  | 'switched_next'
  | 'hysteresis_hold'
  | 'max_switches_exhausted'
  | 'candidates_exhausted'
  | 'keep_last_best_effort';

/** Org may use pilot capabilities (devices, profiles, sessions). */
export function orgIsUsable(org: Org): boolean {
  if (org.status === 'suspended') return false;
  if (org.status === 'fixture' || org.screening_status === 'fixture_exempt') {
    return true;
  }
  return org.status === 'active' && org.screening_status === 'cleared';
}

/** Engineering gate: active requires cleared screening + attestations still true. */
export function canActivateOrg(org: Org): boolean {
  return (
    org.screening_status === 'cleared' &&
    org.status !== 'suspended' &&
    org.status !== 'fixture' &&
    org.prohibited_use_attested === true &&
    org.sanctions_cleared === true &&
    org.upstream_tos_acknowledged === true
  );
}

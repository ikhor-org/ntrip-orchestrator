export type OrgStatus = 'fixture' | 'pending_screening' | 'active' | 'suspended';
export type ScreeningStatus =
  | 'required'
  | 'pending'
  | 'cleared'
  | 'rejected'
  | 'fixture_exempt';

export interface Org {
  id: string;
  name: string;
  status: OrgStatus;
  screening_status: ScreeningStatus;
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
  upstream_id?: string;
  started_at: string;
  /** Health-only; overwritten; dropped on session end. */
  last_gga_at?: string;
  /** Ephemeral last position for live session only — never in metering. */
  last_position?: { lat: number; lon: number };
  bytes_up: number;
  bytes_down: number;
}

/**
 * Upstream adapter interface (architecture §6).
 * All adapters are called only from the proxy after vault release.
 */

export type AdapterType =
  | 'ntrip_basic'
  | 'point_one_token'
  | 'geodnet_enterprise'
  | 'skylark'
  | 'smartnet'
  | 'cpos_customer';

export interface UpstreamEndpoint {
  id: string;
  adapterType: AdapterType;
  host: string;
  port: number;
  useTls: boolean;
  defaultMountpoint?: string;
  options?: Record<string, unknown>;
}

/**
 * Secret material released from vault for session TTL only.
 * Never log plaintext fields.
 */
export interface SecretMaterial {
  secretType: 'ntrip_basic' | 'bearer_token' | 'api_key_pair' | 'opaque_blob';
  /** ntrip_basic: username + password (+ optional host/port/mount overrides). */
  ntripBasic?: {
    username: string;
    password: string;
    host?: string;
    port?: number;
    mountpoint?: string;
  };
  bearerToken?: string;
  apiKeyPair?: { appId: string; appKey: string };
  opaque?: Record<string, unknown>;
}

export interface SessionHints {
  mountpoint?: string;
  /** GGA may be forwarded for upstream health/routing — not retained as tracks. */
  gga?: string;
  userAgent?: string;
}

export interface UpstreamSession {
  writeGga(nmea: string): Promise<void>;
  readRtcm(): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
  healthSample(): { ok: boolean; note?: string };
}

export interface Adapter {
  readonly type: AdapterType;
  /** When false, adapter must not be selected by the route engine. */
  readonly enabled: boolean;
  connect(
    ctx: { signal?: AbortSignal },
    endpoint: UpstreamEndpoint,
    secret: SecretMaterial,
    hints: SessionHints,
  ): Promise<UpstreamSession>;
}

export class AdapterNotImplementedError extends Error {
  constructor(type: AdapterType) {
    super(`Adapter ${type} is a stub (not_implemented)`);
    this.name = 'AdapterNotImplementedError';
  }
}

export class AdapterDisabledError extends Error {
  constructor(type: AdapterType, reason: string) {
    super(`Adapter ${type} is disabled: ${reason}`);
    this.name = 'AdapterDisabledError';
  }
}

export class AdapterConnectError extends Error {
  readonly code: 'unreachable' | 'auth_failed' | 'stalled' | 'bad_secret' | 'rejected';
  constructor(
    code: AdapterConnectError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'AdapterConnectError';
    this.code = code;
  }
}

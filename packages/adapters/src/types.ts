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

/** Opaque secret material — never log plaintext. */
export interface SecretMaterial {
  secretType: 'ntrip_basic' | 'bearer_token' | 'api_key_pair' | 'opaque_blob';
  /** In M0 this is a placeholder; real vault decrypt lands in M1. */
  placeholder: true;
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

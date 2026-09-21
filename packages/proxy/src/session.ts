/**
 * Proxy session sketch (architecture §5.1).
 * GGA / last_gga_at are for session health only — do not retain tracks.
 * Metering fields: bytes_in/out, started_at — no lat/lon.
 */

export type SessionState =
  | 'connecting'
  | 'streaming'
  | 'failing_over'
  | 'closed';

export interface ProxySession {
  id: string;
  deviceId: string;
  orgId: string;
  profileId?: string;
  pseudoUser: string;
  selectedUpstreamId?: string;
  state: SessionState;
  bytesIn: number;
  bytesOut: number;
  startedAt: Date;
  failoverCount: number;
  /** Health-only; overwrite/drop on session end — no track history. */
  lastGgaAt?: Date;
  /** Ephemeral; drop on session end. */
  lastPosition?: { lat: number; lon: number };
}

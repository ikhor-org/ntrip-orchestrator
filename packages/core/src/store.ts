import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { FIXTURE_ORG_ID, FIXTURE_ORG_NAME } from './constants.js';
import { buildMeteringEvent } from './metering.js';
import {
  AuditEvent,
  Device,
  LiveSessionHealth,
  MeteringEvent,
  MeteringEventType,
  Org,
  PseudoCredential,
  UpstreamEndpoint,
  VaultSecretRecord,
} from './types.js';

interface StoreSnapshot {
  orgs: Org[];
  devices: Device[];
  credentials: Array<Omit<PseudoCredential, 'password_hash'> & { password_hash: string }>;
  upstreams: UpstreamEndpoint[];
  vaultSecrets: Array<
    Omit<VaultSecretRecord, 'ciphertext' | 'nonce'> & {
      ciphertext_b64: string;
      nonce_b64: string;
    }
  >;
  auditEvents: AuditEvent[];
  meteringEvents: MeteringEvent[];
}

/**
 * In-memory store with optional JSON file persistence for local api+proxy sharing.
 * Migrations remain the PG source of truth; this is the M1 vertical-slice runtime.
 */
export class Store {
  readonly orgs = new Map<string, Org>();
  readonly devices = new Map<string, Device>();
  readonly credentialsByUsername = new Map<string, PseudoCredential>();
  readonly credentialsByDevice = new Map<string, PseudoCredential>();
  readonly upstreams = new Map<string, UpstreamEndpoint>();
  readonly vaultByUpstream = new Map<string, VaultSecretRecord>();
  readonly auditEvents: AuditEvent[] = [];
  readonly meteringEvents: MeteringEvent[] = [];
  /** Live sessions only — health samples dropped on end. */
  readonly liveSessions = new Map<string, LiveSessionHealth>();

  private storePath?: string;

  constructor(opts?: { storePath?: string }) {
    if (opts?.storePath) this.storePath = opts.storePath;
  }

  seedFixtureOrg(): Org {
    const existing = this.orgs.get(FIXTURE_ORG_ID);
    if (existing) return existing;
    const org: Org = {
      id: FIXTURE_ORG_ID,
      name: FIXTURE_ORG_NAME,
      status: 'fixture',
      screening_status: 'fixture_exempt',
    };
    this.orgs.set(org.id, org);
    return org;
  }

  getOrg(id: string): Org | undefined {
    return this.orgs.get(id);
  }

  putOrg(org: Org): void {
    this.orgs.set(org.id, org);
  }

  listDevices(orgId: string): Device[] {
    return [...this.devices.values()].filter((d) => d.org_id === orgId);
  }

  getDevice(id: string): Device | undefined {
    return this.devices.get(id);
  }

  putDevice(device: Device, cred: PseudoCredential): void {
    this.devices.set(device.id, device);
    this.credentialsByUsername.set(cred.username, cred);
    this.credentialsByDevice.set(device.id, cred);
  }

  getCredentialByUsername(username: string): PseudoCredential | undefined {
    return this.credentialsByUsername.get(username);
  }

  putUpstream(endpoint: UpstreamEndpoint): void {
    this.upstreams.set(endpoint.id, endpoint);
  }

  getUpstream(id: string): UpstreamEndpoint | undefined {
    return this.upstreams.get(id);
  }

  listUpstreams(orgId: string): UpstreamEndpoint[] {
    return [...this.upstreams.values()].filter((u) => u.org_id === orgId);
  }

  putVaultSecret(secret: VaultSecretRecord): void {
    this.vaultByUpstream.set(secret.upstream_id, secret);
  }

  getVaultSecret(upstreamId: string): VaultSecretRecord | undefined {
    return this.vaultByUpstream.get(upstreamId);
  }

  appendAudit(partial: Omit<AuditEvent, 'id' | 'ts'> & { id?: string; ts?: string }): AuditEvent {
    const event: AuditEvent = {
      id: partial.id ?? randomUUID(),
      actor_type: partial.actor_type,
      event_type: partial.event_type,
      payload_json: partial.payload_json,
      ts: partial.ts ?? new Date().toISOString(),
    };
    if (partial.org_id !== undefined) event.org_id = partial.org_id;
    if (partial.actor_id !== undefined) event.actor_id = partial.actor_id;
    if (partial.resource_type !== undefined) event.resource_type = partial.resource_type;
    if (partial.resource_id !== undefined) event.resource_id = partial.resource_id;
    this.auditEvents.push(event);
    return event;
  }

  appendMetering(input: {
    org_id: string;
    device_id?: string;
    session_id?: string;
    event_type: MeteringEventType;
    payload_json: Record<string, unknown>;
  }): MeteringEvent {
    const event = buildMeteringEvent({
      id: randomUUID(),
      ...input,
    });
    this.meteringEvents.push(event);
    return event;
  }

  listMetering(orgId: string): MeteringEvent[] {
    return this.meteringEvents.filter((e) => e.org_id === orgId);
  }

  listAudit(orgId: string): AuditEvent[] {
    return this.auditEvents.filter((e) => e.org_id === orgId);
  }

  startLiveSession(health: LiveSessionHealth): void {
    this.liveSessions.set(health.session_id, health);
  }

  updateLiveSession(
    sessionId: string,
    patch: Partial<LiveSessionHealth>,
  ): LiveSessionHealth | undefined {
    const cur = this.liveSessions.get(sessionId);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.liveSessions.set(sessionId, next);
    return next;
  }

  /** Drop ephemeral health (incl. last_position) on session end. */
  endLiveSession(sessionId: string): void {
    this.liveSessions.delete(sessionId);
  }

  countLiveSessions(orgId: string): number {
    let n = 0;
    for (const s of this.liveSessions.values()) {
      if (s.org_id === orgId) n++;
    }
    return n;
  }

  liveSessionsForOrg(orgId: string): LiveSessionHealth[] {
    return [...this.liveSessions.values()].filter((s) => s.org_id === orgId);
  }

  async persist(): Promise<void> {
    if (!this.storePath) return;
    const snap: StoreSnapshot = {
      orgs: [...this.orgs.values()],
      devices: [...this.devices.values()],
      credentials: [...this.credentialsByUsername.values()],
      upstreams: [...this.upstreams.values()],
      vaultSecrets: [...this.vaultByUpstream.values()].map((s) => ({
        id: s.id,
        upstream_id: s.upstream_id,
        secret_type: s.secret_type,
        ciphertext_b64: s.ciphertext.toString('base64'),
        nonce_b64: s.nonce.toString('base64'),
        key_version: s.key_version,
        last4: s.last4,
        rotated_at: s.rotated_at,
        disabled_at: s.disabled_at,
        created_at: s.created_at,
      })),
      auditEvents: this.auditEvents,
      meteringEvents: this.meteringEvents,
    };
    await fs.writeFile(this.storePath, JSON.stringify(snap, null, 2), 'utf8');
  }

  async load(): Promise<void> {
    if (!this.storePath) return;
    let raw: string;
    try {
      raw = await fs.readFile(this.storePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw err;
    }
    const snap = JSON.parse(raw) as StoreSnapshot;
    this.orgs.clear();
    this.devices.clear();
    this.credentialsByUsername.clear();
    this.credentialsByDevice.clear();
    this.upstreams.clear();
    this.vaultByUpstream.clear();
    this.auditEvents.length = 0;
    this.meteringEvents.length = 0;
    for (const o of snap.orgs ?? []) this.orgs.set(o.id, o);
    for (const d of snap.devices ?? []) this.devices.set(d.id, d);
    for (const c of snap.credentials ?? []) {
      this.credentialsByUsername.set(c.username, c);
      this.credentialsByDevice.set(c.device_id, c);
    }
    for (const u of snap.upstreams ?? []) this.upstreams.set(u.id, u);
    for (const s of snap.vaultSecrets ?? []) {
      const rec: VaultSecretRecord = {
        id: s.id,
        upstream_id: s.upstream_id,
        secret_type: s.secret_type,
        ciphertext: Buffer.from(s.ciphertext_b64, 'base64'),
        nonce: Buffer.from(s.nonce_b64, 'base64'),
        key_version: s.key_version,
        created_at: s.created_at,
      };
      if (s.last4 !== undefined) rec.last4 = s.last4;
      if (s.rotated_at !== undefined) rec.rotated_at = s.rotated_at;
      if (s.disabled_at !== undefined) rec.disabled_at = s.disabled_at;
      this.vaultByUpstream.set(rec.upstream_id, rec);
    }
    this.auditEvents.push(...(snap.auditEvents ?? []));
    this.meteringEvents.push(...(snap.meteringEvents ?? []));
  }

  /** Reload from disk if storePath set — used by proxy before auth. */
  async reload(): Promise<void> {
    await this.load();
  }
}

let defaultStore: Store | undefined;

export function getDefaultStore(): Store {
  if (!defaultStore) {
    defaultStore = new Store({
      storePath: process.env.GROKBOT_STORE_PATH,
    });
    defaultStore.seedFixtureOrg();
  }
  return defaultStore;
}

export function setDefaultStore(store: Store): void {
  defaultStore = store;
}

export function resetDefaultStore(): void {
  defaultStore = undefined;
}

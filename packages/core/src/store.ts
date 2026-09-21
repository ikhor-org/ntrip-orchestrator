import { createHmac, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { FIXTURE_ORG_ID, FIXTURE_ORG_NAME } from './constants.js';
import { buildMeteringEvent } from './metering.js';
import { normalizePolicy } from './policy.js';
import {
  AuditEvent,
  Device,
  LiveSessionHealth,
  MeteringEvent,
  MeteringEventType,
  Org,
  Profile,
  ProfilePolicy,
  PseudoCredential,
  UpstreamEndpoint,
  UpstreamHealthSnapshot,
  UpstreamHealthStatus,
  UsageWebhook,
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
  profiles: Profile[];
  auditEvents: AuditEvent[];
  meteringEvents: MeteringEvent[];
  upstreamHealth: UpstreamHealthSnapshot[];
  usageWebhooks: UsageWebhook[];
}

export interface AuditQueryFilter {
  org_id: string;
  from?: string;
  to?: string;
  event_type?: string;
  device_id?: string;
  cursor?: string;
  limit?: number;
}

export interface MeteringQueryFilter {
  org_id: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/**
 * In-memory store with optional JSON file persistence for local api+proxy sharing.
 * Migrations remain the PG source of truth; this is the M1/M2 vertical-slice runtime.
 */
export class Store {
  readonly orgs = new Map<string, Org>();
  readonly devices = new Map<string, Device>();
  readonly credentialsByUsername = new Map<string, PseudoCredential>();
  readonly credentialsByDevice = new Map<string, PseudoCredential>();
  readonly upstreams = new Map<string, UpstreamEndpoint>();
  readonly vaultByUpstream = new Map<string, VaultSecretRecord>();
  readonly profiles = new Map<string, Profile>();
  readonly auditEvents: AuditEvent[] = [];
  readonly meteringEvents: MeteringEvent[] = [];
  readonly upstreamHealth = new Map<string, UpstreamHealthSnapshot>();
  readonly usageWebhooks = new Map<string, UsageWebhook>();
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

  updateDevice(device: Device): void {
    this.devices.set(device.id, device);
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

  putProfile(profile: Profile): void {
    this.profiles.set(profile.id, profile);
  }

  getProfile(id: string): Profile | undefined {
    return this.profiles.get(id);
  }

  listProfiles(orgId: string): Profile[] {
    return [...this.profiles.values()].filter((p) => p.org_id === orgId);
  }

  createProfile(input: {
    org_id: string;
    name: string;
    policy_json: Partial<ProfilePolicy> & { candidates?: Profile['policy_json']['candidates'] };
    datum_tag?: string;
    epoch_tag?: string;
  }): Profile {
    const id = randomUUID();
    const policy = normalizePolicy({
      ...input.policy_json,
      profile_id: id,
    });
    const profile: Profile = {
      id,
      org_id: input.org_id,
      name: input.name,
      policy_json: policy,
      created_at: new Date().toISOString(),
    };
    if (input.datum_tag !== undefined) profile.datum_tag = input.datum_tag;
    if (input.epoch_tag !== undefined) profile.epoch_tag = input.epoch_tag;
    this.profiles.set(id, profile);
    return profile;
  }

  replaceProfilePolicy(
    profileId: string,
    policy_json: Partial<ProfilePolicy> & { candidates?: Profile['policy_json']['candidates'] },
    meta?: { name?: string; datum_tag?: string; epoch_tag?: string },
  ): Profile | undefined {
    const cur = this.profiles.get(profileId);
    if (!cur) return undefined;
    const next: Profile = {
      ...cur,
      policy_json: normalizePolicy({ ...policy_json, profile_id: profileId }),
    };
    if (meta?.name !== undefined) next.name = meta.name;
    if (meta?.datum_tag !== undefined) next.datum_tag = meta.datum_tag;
    if (meta?.epoch_tag !== undefined) next.epoch_tag = meta.epoch_tag;
    this.profiles.set(profileId, next);
    return next;
  }

  setUpstreamHealth(
    upstreamId: string,
    orgId: string,
    patch: {
      status: UpstreamHealthStatus;
      reachable: boolean;
      last_error?: string;
      recent_success_rate?: number;
    },
  ): UpstreamHealthSnapshot {
    const now = new Date().toISOString();
    const prev = this.upstreamHealth.get(upstreamId);
    const snap: UpstreamHealthSnapshot = {
      upstream_id: upstreamId,
      org_id: orgId,
      status: patch.status,
      reachable: patch.reachable,
      updated_at: now,
    };
    if (patch.reachable && patch.status === 'ok') {
      snap.last_ok_at = now;
    } else if (prev?.last_ok_at) {
      snap.last_ok_at = prev.last_ok_at;
    }
    if (!patch.reachable || patch.status === 'unreachable') {
      snap.last_fail_at = now;
    } else if (prev?.last_fail_at) {
      snap.last_fail_at = prev.last_fail_at;
    }
    if (patch.last_error !== undefined) snap.last_error = patch.last_error;
    if (patch.recent_success_rate !== undefined) {
      snap.recent_success_rate = patch.recent_success_rate;
    }
    this.upstreamHealth.set(upstreamId, snap);
    return snap;
  }

  getUpstreamHealth(upstreamId: string): UpstreamHealthSnapshot | undefined {
    return this.upstreamHealth.get(upstreamId);
  }

  listUpstreamHealth(orgId: string): UpstreamHealthSnapshot[] {
    return [...this.upstreamHealth.values()].filter((h) => h.org_id === orgId);
  }

  healthMapForOrg(orgId: string): Map<string, UpstreamHealthSnapshot> {
    const m = new Map<string, UpstreamHealthSnapshot>();
    for (const h of this.listUpstreamHealth(orgId)) {
      m.set(h.upstream_id, h);
    }
    return m;
  }

  putUsageWebhook(hook: UsageWebhook): void {
    this.usageWebhooks.set(hook.id, hook);
  }

  listUsageWebhooks(orgId: string): UsageWebhook[] {
    return [...this.usageWebhooks.values()].filter((h) => h.org_id === orgId);
  }

  createUsageWebhook(orgId: string, url: string, secret?: string): UsageWebhook {
    const hook: UsageWebhook = {
      id: randomUUID(),
      org_id: orgId,
      url,
      secret: secret ?? randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      enabled: true,
      created_at: new Date().toISOString(),
    };
    this.usageWebhooks.set(hook.id, hook);
    return hook;
  }

  /** Sign a usage export payload with HMAC-SHA256. */
  signUsagePayload(secret: string, body: string): string {
    return createHmac('sha256', secret).update(body).digest('hex');
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

  queryMetering(filter: MeteringQueryFilter): {
    events: MeteringEvent[];
    next_cursor: string | null;
  } {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    let events = this.meteringEvents.filter((e) => e.org_id === filter.org_id);
    if (filter.from) {
      const fromMs = Date.parse(filter.from);
      events = events.filter((e) => Date.parse(e.ts) >= fromMs);
    }
    if (filter.to) {
      const toMs = Date.parse(filter.to);
      events = events.filter((e) => Date.parse(e.ts) <= toMs);
    }
    events = events.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    if (filter.cursor) {
      const idx = events.findIndex((e) => e.id === filter.cursor);
      if (idx >= 0) events = events.slice(idx + 1);
    }
    const page = events.slice(0, limit);
    const next =
      events.length > limit ? (page[page.length - 1]?.id ?? null) : null;
    return { events: page, next_cursor: next };
  }

  listAudit(orgId: string): AuditEvent[] {
    return this.auditEvents.filter((e) => e.org_id === orgId);
  }

  queryAudit(filter: AuditQueryFilter): {
    events: AuditEvent[];
    next_cursor: string | null;
  } {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    let events = this.auditEvents.filter((e) => e.org_id === filter.org_id);
    if (filter.from) {
      const fromMs = Date.parse(filter.from);
      events = events.filter((e) => Date.parse(e.ts) >= fromMs);
    }
    if (filter.to) {
      const toMs = Date.parse(filter.to);
      events = events.filter((e) => Date.parse(e.ts) <= toMs);
    }
    if (filter.event_type) {
      events = events.filter((e) => e.event_type === filter.event_type);
    }
    if (filter.device_id) {
      events = events.filter(
        (e) =>
          e.resource_id === filter.device_id ||
          e.actor_id === filter.device_id ||
          (e.payload_json.device_id as string | undefined) === filter.device_id,
      );
    }
    events = events.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    if (filter.cursor) {
      const idx = events.findIndex((e) => e.id === filter.cursor);
      if (idx >= 0) events = events.slice(idx + 1);
    }
    const page = events.slice(0, limit);
    const next =
      events.length > limit ? (page[page.length - 1]?.id ?? null) : null;
    return { events: page, next_cursor: next };
  }

  startLiveSession(health: LiveSessionHealth): void {
    const withDefaults: LiveSessionHealth = {
      ...health,
      failover_count: health.failover_count ?? 0,
    };
    this.liveSessions.set(health.session_id, withDefaults);
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

  getLiveSessionForDevice(deviceId: string): LiveSessionHealth | undefined {
    for (const s of this.liveSessions.values()) {
      if (s.device_id === deviceId) return s;
    }
    return undefined;
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
      profiles: [...this.profiles.values()],
      auditEvents: this.auditEvents,
      meteringEvents: this.meteringEvents,
      upstreamHealth: [...this.upstreamHealth.values()],
      usageWebhooks: [...this.usageWebhooks.values()],
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
    this.profiles.clear();
    this.upstreamHealth.clear();
    this.usageWebhooks.clear();
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
    for (const p of snap.profiles ?? []) this.profiles.set(p.id, p);
    for (const h of snap.upstreamHealth ?? []) {
      this.upstreamHealth.set(h.upstream_id, h);
    }
    for (const w of snap.usageWebhooks ?? []) this.usageWebhooks.set(w.id, w);
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

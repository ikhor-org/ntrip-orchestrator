import { randomUUID } from 'node:crypto';
import net from 'node:net';
import {
  Adapter,
  AdapterConnectError,
  getRoutableAdapter,
  SecretMaterial,
  UpstreamEndpoint as AdapterEndpoint,
  UpstreamSession,
} from '@grokbot/adapters';
import {
  decryptJson,
  NtripBasicSecret,
  parseKek,
  Store,
  UpstreamEndpoint,
} from '@grokbot/core';
import { ProxyRuntimeConfig } from './config.js';
import { ProxySession } from './session.js';

/** Optional inject for tests — bypass real adapter connect. */
export type UpstreamConnectFn = (
  endpoint: AdapterEndpoint,
  secret: SecretMaterial,
  hints: { mountpoint?: string; gga?: string },
) => Promise<UpstreamSession>;

let upstreamConnectOverride: UpstreamConnectFn | null = null;

export function setUpstreamConnectOverride(fn: UpstreamConnectFn | null): void {
  upstreamConnectOverride = fn;
}

function resolveUpstream(
  store: Store,
  config: ProxyRuntimeConfig,
  orgId: string,
): { endpoint: UpstreamEndpoint; secret: SecretMaterial } | null {
  const list = store
    .listUpstreams(orgId)
    .filter((u) => u.enabled && u.adapter_type === 'ntrip_basic');
  if (list.length > 0) {
    const endpoint = list[0]!;
    const vault = store.getVaultSecret(endpoint.id);
    if (!vault || vault.disabled_at) return null;
    if (!config.vaultKekRaw) return null;
    const kek = parseKek(config.vaultKekRaw);
    const plain = decryptJson<NtripBasicSecret>(kek, {
      ciphertext: vault.ciphertext,
      nonce: vault.nonce,
      keyVersion: vault.key_version,
    });
    const secret: SecretMaterial = {
      secretType: 'ntrip_basic',
      ntripBasic: {
        username: plain.username,
        password: plain.password,
      },
    };
    if (plain.host) secret.ntripBasic!.host = plain.host;
    if (plain.port) secret.ntripBasic!.port = plain.port;
    if (plain.mountpoint) secret.ntripBasic!.mountpoint = plain.mountpoint;
    return { endpoint, secret };
  }

  // Dev fallback from env (encrypts nothing — for local mock caster only)
  if (config.ntripUpstreamHost && config.ntripUpstreamMountpoint) {
    const endpoint: UpstreamEndpoint = {
      id: '00000000-0000-4000-8000-0000000000ee',
      org_id: orgId,
      adapter_type: 'ntrip_basic',
      display_name: 'env-ntrip-upstream',
      host: config.ntripUpstreamHost,
      port: config.ntripUpstreamPort,
      use_tls: config.ntripUpstreamTls,
      default_mountpoint: config.ntripUpstreamMountpoint,
      options_json: {},
      enabled: true,
      created_at: new Date().toISOString(),
    };
    const secret: SecretMaterial = {
      secretType: 'ntrip_basic',
      ntripBasic: {
        username: config.ntripUpstreamUser ?? '',
        password: config.ntripUpstreamPass ?? '',
        mountpoint: config.ntripUpstreamMountpoint,
      },
    };
    return { endpoint, secret };
  }
  return null;
}

function toAdapterEndpoint(u: UpstreamEndpoint): AdapterEndpoint {
  const ep: AdapterEndpoint = {
    id: u.id,
    adapterType: u.adapter_type,
    host: u.host,
    port: u.port,
    useTls: u.use_tls,
    options: u.options_json,
  };
  if (u.default_mountpoint !== undefined) {
    ep.defaultMountpoint = u.default_mountpoint;
  }
  return ep;
}

function parseGgaLatLon(
  nmea: string,
): { lat: number; lon: number } | undefined {
  // Minimal GGA parse for ephemeral health only
  if (!nmea.includes('GGA')) return undefined;
  const parts = nmea.trim().split(',');
  if (parts.length < 6) return undefined;
  const latRaw = parts[2];
  const latHem = parts[3];
  const lonRaw = parts[4];
  const lonHem = parts[5];
  if (!latRaw || !lonRaw || !latHem || !lonHem) return undefined;
  const latNum = Number(latRaw);
  const lonNum = Number(lonRaw);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return undefined;
  const latDeg = Math.floor(latNum / 100);
  const latMin = latNum - latDeg * 100;
  let lat = latDeg + latMin / 60;
  if (latHem === 'S') lat = -lat;
  const lonDeg = Math.floor(lonNum / 100);
  const lonMin = lonNum - lonDeg * 100;
  let lon = lonDeg + lonMin / 60;
  if (lonHem === 'W') lon = -lon;
  return { lat, lon };
}

export async function handleAuthenticatedSession(opts: {
  socket: net.Socket;
  store: Store;
  config: ProxyRuntimeConfig;
  identity: { deviceId: string; orgId: string; username: string };
  requestLine: string;
  leftover: Buffer;
}): Promise<void> {
  const { socket, store, config, identity } = opts;
  const sessionId = randomUUID();
  const session: ProxySession = {
    id: sessionId,
    deviceId: identity.deviceId,
    orgId: identity.orgId,
    pseudoUser: identity.username,
    state: 'connecting',
    bytesIn: 0,
    bytesOut: 0,
    startedAt: new Date(),
  };

  const resolved = resolveUpstream(store, config, identity.orgId);
  if (!resolved) {
    store.appendAudit({
      org_id: identity.orgId,
      actor_type: 'device',
      actor_id: identity.deviceId,
      event_type: 'session.auth_fail',
      resource_type: 'session',
      resource_id: sessionId,
      payload_json: { reason: 'no_upstream' },
    });
    await store.persist();
    socket.write('HTTP/1.0 503 Service Unavailable\r\n\r\n');
    socket.end();
    return;
  }

  session.selectedUpstreamId = resolved.endpoint.id;
  const adapterEp = toAdapterEndpoint(resolved.endpoint);
  const mount =
    resolved.secret.ntripBasic?.mountpoint ??
    resolved.endpoint.default_mountpoint ??
    parseMount(opts.requestLine);

  let upstream: UpstreamSession;
  try {
    if (upstreamConnectOverride) {
      upstream = await upstreamConnectOverride(
        adapterEp,
        resolved.secret,
        { mountpoint: mount },
      );
    } else {
      const adapter: Adapter | undefined = getRoutableAdapter('ntrip_basic');
      if (!adapter) {
        throw new AdapterConnectError('rejected', 'ntrip_basic not routable');
      }
      upstream = await adapter.connect(
        {},
        adapterEp,
        resolved.secret,
        { mountpoint: mount },
      );
    }
  } catch (err) {
    const reason =
      err instanceof AdapterConnectError ? err.code : 'upstream_error';
    store.appendAudit({
      org_id: identity.orgId,
      actor_type: 'device',
      actor_id: identity.deviceId,
      event_type: 'session.auth_fail',
      resource_type: 'session',
      resource_id: sessionId,
      payload_json: { reason, upstream_id: resolved.endpoint.id },
    });
    await store.persist();
    socket.write('HTTP/1.0 502 Bad Gateway\r\n\r\n');
    socket.end();
    return;
  }

  session.state = 'streaming';
  store.startLiveSession({
    session_id: sessionId,
    device_id: identity.deviceId,
    org_id: identity.orgId,
    upstream_id: resolved.endpoint.id,
    started_at: session.startedAt.toISOString(),
    bytes_up: 0,
    bytes_down: 0,
  });
  store.appendAudit({
    org_id: identity.orgId,
    actor_type: 'device',
    actor_id: identity.deviceId,
    event_type: 'session.started',
    resource_type: 'session',
    resource_id: sessionId,
    payload_json: { upstream_id: resolved.endpoint.id },
  });
  store.appendMetering({
    org_id: identity.orgId,
    device_id: identity.deviceId,
    session_id: sessionId,
    event_type: 'usage.session_started',
    payload_json: {
      org_id: identity.orgId,
      device_id: identity.deviceId,
      session_id: sessionId,
      upstream_id: resolved.endpoint.id,
      ts: session.startedAt.toISOString(),
    },
  });
  // device-days hook (one event per session start day)
  const day = session.startedAt.toISOString().slice(0, 10);
  store.appendMetering({
    org_id: identity.orgId,
    device_id: identity.deviceId,
    session_id: sessionId,
    event_type: 'usage.device_day',
    payload_json: {
      org_id: identity.orgId,
      device_id: identity.deviceId,
      day,
      active_seconds: 0,
    },
  });
  await store.persist();

  socket.write('ICY 200 OK\r\nServer: grokbot-proxy-m1\r\n\r\n');

  let ended = false;
  const endSession = async (endReason: string) => {
    if (ended) return;
    ended = true;
    session.state = 'closed';
    const durationMs = Date.now() - session.startedAt.getTime();
    store.appendAudit({
      org_id: identity.orgId,
      actor_type: 'device',
      actor_id: identity.deviceId,
      event_type: 'session.ended',
      resource_type: 'session',
      resource_id: sessionId,
      payload_json: {
        upstream_id: resolved.endpoint.id,
        reason: endReason,
        bytes_up: session.bytesIn,
        bytes_down: session.bytesOut,
      },
    });
    store.appendMetering({
      org_id: identity.orgId,
      device_id: identity.deviceId,
      session_id: sessionId,
      event_type: 'usage.session_ended',
      payload_json: {
        session_id: sessionId,
        duration_ms: durationMs,
        bytes_up: session.bytesIn,
        bytes_down: session.bytesOut,
        end_reason: endReason,
      },
    });
    // Drop ephemeral health / last position — no track history
    store.endLiveSession(sessionId);
    await store.persist();
    try {
      await upstream.close();
    } catch {
      /* ignore */
    }
    if (!socket.destroyed) socket.end();
  };

  // Device → upstream (GGA / NMEA)
  if (opts.leftover.length > 0) {
    session.bytesIn += opts.leftover.length;
    const text = opts.leftover.toString('utf8');
    if (text.includes('GGA')) {
      session.lastGgaAt = new Date();
      const pos = parseGgaLatLon(text);
      const patch: {
        bytes_up: number;
        last_gga_at: string;
        last_position?: { lat: number; lon: number };
      } = {
        bytes_up: session.bytesIn,
        last_gga_at: session.lastGgaAt.toISOString(),
      };
      if (pos) {
        session.lastPosition = pos;
        patch.last_position = pos;
      }
      store.updateLiveSession(sessionId, patch);
    }
    void upstream.writeGga(text);
  }

  socket.on('data', (chunk: Buffer) => {
    session.bytesIn += chunk.length;
    const text = chunk.toString('utf8');
    if (text.includes('GGA')) {
      session.lastGgaAt = new Date();
      const pos = parseGgaLatLon(text);
      const patch: {
        bytes_up: number;
        last_gga_at: string;
        last_position?: { lat: number; lon: number };
      } = {
        bytes_up: session.bytesIn,
        last_gga_at: session.lastGgaAt.toISOString(),
      };
      if (pos) {
        session.lastPosition = pos;
        patch.last_position = pos;
      }
      store.updateLiveSession(sessionId, patch);
    } else {
      store.updateLiveSession(sessionId, { bytes_up: session.bytesIn });
    }
    void upstream.writeGga(text);
  });

  socket.on('close', () => {
    void endSession('client_close');
  });
  socket.on('error', () => {
    void endSession('client_error');
  });

  // Upstream → device (RTCM)
  (async () => {
    try {
      for await (const chunk of upstream.readRtcm()) {
        if (socket.destroyed) break;
        session.bytesOut += chunk.byteLength;
        store.updateLiveSession(sessionId, { bytes_down: session.bytesOut });
        socket.write(Buffer.from(chunk));
      }
      await endSession('upstream_end');
    } catch {
      await endSession('upstream_error');
    }
  })();
}

function parseMount(requestLine: string): string {
  const parts = requestLine.split(' ');
  const path = parts[1] ?? '/';
  return path.replace(/^\//, '') || 'MOUNT';
}

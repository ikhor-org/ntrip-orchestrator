import { randomUUID } from 'node:crypto';
import net from 'node:net';
import {
  Adapter,
  AdapterConnectError,
  getRoutableAdapter,
  SecretMaterial,
  UpstreamEndpoint as AdapterEndpoint,
  UpstreamSession,
} from '@ntrip-orchestrator/adapters';
import {
  decryptJson,
  DEFAULT_FAILOVER,
  FailoverController,
  normalizePolicy,
  NtripBasicSecret,
  orderCandidates,
  parseKek,
  ProfileCandidate,
  ProfilePolicy,
  selectCandidates,
  Store,
  UpstreamEndpoint,
} from '@ntrip-orchestrator/core';
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

function materializeSecret(
  store: Store,
  config: ProxyRuntimeConfig,
  endpoint: UpstreamEndpoint,
): SecretMaterial | null {
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
  return secret;
}

function envFallbackEndpoint(
  config: ProxyRuntimeConfig,
  orgId: string,
): { endpoint: UpstreamEndpoint; secret: SecretMaterial } | null {
  if (!config.ntripUpstreamHost || !config.ntripUpstreamMountpoint) return null;
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

/**
 * Resolve ordered candidates from device profile policy, or fall back to
 * all enabled ntrip_basic upstreams / env.
 */
function resolvePolicyCandidates(
  store: Store,
  config: ProxyRuntimeConfig,
  orgId: string,
  profileId?: string,
): { policy: ProfilePolicy; candidates: ProfileCandidate[] } {
  if (profileId) {
    const profile = store.getProfile(profileId);
    if (profile) {
      const policy = normalizePolicy({
        ...profile.policy_json,
        profile_id: profile.id,
      });
      return { policy, candidates: orderCandidates(policy.candidates) };
    }
  }

  // Implicit primary/secondary from enabled upstreams (creation order ≈ priority)
  const list = store
    .listUpstreams(orgId)
    .filter((u) => u.enabled && u.adapter_type === 'ntrip_basic');
  if (list.length > 0) {
    const candidates: ProfileCandidate[] = list.map((u, i) => ({
      priority: i + 1,
      upstream_endpoint_id: u.id,
    }));
    const policy = normalizePolicy({
      candidates,
      failover: DEFAULT_FAILOVER,
    });
    return { policy, candidates: orderCandidates(candidates) };
  }

  const env = envFallbackEndpoint(config, orgId);
  if (env) {
    // Ensure env upstream is visible to secret resolver
    if (!store.getUpstream(env.endpoint.id)) {
      store.putUpstream(env.endpoint);
    }
    const candidates: ProfileCandidate[] = [
      { priority: 1, upstream_endpoint_id: env.endpoint.id },
    ];
    return {
      policy: normalizePolicy({ candidates, failover: DEFAULT_FAILOVER }),
      candidates,
    };
  }

  return {
    policy: normalizePolicy({ candidates: [], failover: DEFAULT_FAILOVER }),
    candidates: [],
  };
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

async function connectCandidate(
  store: Store,
  config: ProxyRuntimeConfig,
  orgId: string,
  candidate: ProfileCandidate,
  requestMount: string,
): Promise<{
  endpoint: UpstreamEndpoint;
  secret: SecretMaterial;
  upstream: UpstreamSession;
  mount: string;
} | null> {
  const endpoint = store.getUpstream(candidate.upstream_endpoint_id);
  let secret: SecretMaterial | null = null;

  if (endpoint) {
    secret = materializeSecret(store, config, endpoint);
  }

  // Env fallback endpoint may have no vault — synthesize secret from config
  if (
    endpoint &&
    !secret &&
    endpoint.id === '00000000-0000-4000-8000-0000000000ee'
  ) {
    const env = envFallbackEndpoint(config, orgId);
    if (env) secret = env.secret;
  }

  if (!endpoint || !secret) return null;
  if (endpoint.adapter_type === 'cpos_customer') return null;

  const adapterEp = toAdapterEndpoint(endpoint);
  const mount =
    candidate.mountpoint_override ??
    secret.ntripBasic?.mountpoint ??
    endpoint.default_mountpoint ??
    requestMount;

  let upstream: UpstreamSession;
  try {
    if (upstreamConnectOverride) {
      upstream = await upstreamConnectOverride(adapterEp, secret, {
        mountpoint: mount,
      });
    } else {
      const adapter: Adapter | undefined = getRoutableAdapter(
        endpoint.adapter_type === 'ntrip_basic'
          ? 'ntrip_basic'
          : endpoint.adapter_type,
      );
      if (!adapter || !adapter.enabled) {
        throw new AdapterConnectError('rejected', 'adapter not routable');
      }
      upstream = await adapter.connect({}, adapterEp, secret, {
        mountpoint: mount,
      });
    }
  } catch {
    store.setUpstreamHealth(endpoint.id, orgId, {
      status: 'unreachable',
      reachable: false,
      last_error: 'connect_failed',
    });
    return null;
  }

  store.setUpstreamHealth(endpoint.id, orgId, {
    status: 'ok',
    reachable: true,
  });
  return { endpoint, secret, upstream, mount };
}

export async function handleAuthenticatedSession(opts: {
  socket: net.Socket;
  store: Store;
  config: ProxyRuntimeConfig;
  identity: {
    deviceId: string;
    orgId: string;
    username: string;
    profileId?: string;
  };
  requestLine: string;
  leftover: Buffer;
}): Promise<void> {
  const { socket, store, config, identity } = opts;
  const sessionId = randomUUID();
  const device = store.getDevice(identity.deviceId);
  const profileId = identity.profileId ?? device?.profile_id;

  const session: ProxySession = {
    id: sessionId,
    deviceId: identity.deviceId,
    orgId: identity.orgId,
    pseudoUser: identity.username,
    state: 'connecting',
    bytesIn: 0,
    bytesOut: 0,
    startedAt: new Date(),
    failoverCount: 0,
  };
  if (profileId) session.profileId = profileId;

  const { policy, candidates } = resolvePolicyCandidates(
    store,
    config,
    identity.orgId,
    profileId,
  );

  if (candidates.length === 0) {
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

  const ctrl = new FailoverController(policy.failover);
  const requestMount = parseMount(opts.requestLine);
  const healthMap = store.healthMapForOrg(identity.orgId);

  // Prefer healthy candidates; fall back to full ordered list for connect attempts
  let selection = selectCandidates({
    policy,
    healthByUpstream: healthMap,
    excludedUpstreamIds: ctrl.excludedUpstreamIds,
  });

  let connected: Awaited<ReturnType<typeof connectCandidate>> = null;
  let lastFailReason = 'primary_unreachable';

  const tryOrder = orderCandidates(policy.candidates);
  let attempt = 0;

  for (const cand of tryOrder) {
    if (ctrl.switchCountLastHour() >= policy.failover.max_switches_per_hour && attempt > 0) {
      lastFailReason = 'max_switches_exhausted';
      break;
    }

    const fromId = ctrl.currentUpstream;
    if (attempt === 0) {
      ctrl.bind(cand.upstream_endpoint_id);
    } else {
      const sw = ctrl.rejectCurrentAndPick(cand.upstream_endpoint_id);
      if (!sw.ok) {
        lastFailReason = sw.reason;
        if (sw.reason === 'max_switches_exhausted') break;
        ctrl.exclude(cand.upstream_endpoint_id);
        continue;
      }
      session.failoverCount += 1;
      store.appendAudit({
        org_id: identity.orgId,
        actor_type: 'device',
        actor_id: identity.deviceId,
        event_type: 'session.failover',
        resource_type: 'session',
        resource_id: sessionId,
        payload_json: {
          from_upstream_id: fromId,
          to_upstream_id: cand.upstream_endpoint_id,
          reason: sw.reason,
        },
      });
    }

    connected = await connectCandidate(
      store,
      config,
      identity.orgId,
      cand,
      requestMount,
    );
    if (connected) {
      selection = {
        ordered: tryOrder,
        selected: cand,
        reason: attempt === 0 ? 'primary_ok' : 'switched_secondary',
      };
      break;
    }

    lastFailReason = 'primary_unreachable';
    ctrl.exclude(cand.upstream_endpoint_id);
    attempt += 1;
  }

  if (!connected) {
    store.appendAudit({
      org_id: identity.orgId,
      actor_type: 'device',
      actor_id: identity.deviceId,
      event_type: 'session.auth_fail',
      resource_type: 'session',
      resource_id: sessionId,
      payload_json: { reason: lastFailReason },
    });
    await store.persist();
    socket.write('HTTP/1.0 502 Bad Gateway\r\n\r\n');
    socket.end();
    return;
  }

  let currentUpstream = connected.upstream;
  let currentEndpoint = connected.endpoint;
  session.selectedUpstreamId = currentEndpoint.id;
  session.state = 'streaming';

  store.startLiveSession({
    session_id: sessionId,
    device_id: identity.deviceId,
    org_id: identity.orgId,
    profile_id: profileId,
    upstream_id: currentEndpoint.id,
    started_at: session.startedAt.toISOString(),
    bytes_up: 0,
    bytes_down: 0,
    failover_count: session.failoverCount,
    upstream_ok: true,
  });
  store.appendAudit({
    org_id: identity.orgId,
    actor_type: 'device',
    actor_id: identity.deviceId,
    event_type: 'session.started',
    resource_type: 'session',
    resource_id: sessionId,
    payload_json: {
      upstream_id: currentEndpoint.id,
      reason: selection.reason,
      failover_count: session.failoverCount,
    },
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
      upstream_id: currentEndpoint.id,
      ts: session.startedAt.toISOString(),
    },
  });
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

  socket.write('ICY 200 OK\r\nServer: ntrip-orchestrator-proxy-m2\r\n\r\n');

  let ended = false;
  let rtcmAbort: AbortController | null = new AbortController();

  const endSession = async (endReason: string) => {
    if (ended) return;
    ended = true;
    session.state = 'closed';
    rtcmAbort?.abort();
    const durationMs = Date.now() - session.startedAt.getTime();
    store.appendAudit({
      org_id: identity.orgId,
      actor_type: 'device',
      actor_id: identity.deviceId,
      event_type: 'session.ended',
      resource_type: 'session',
      resource_id: sessionId,
      payload_json: {
        upstream_id: currentEndpoint.id,
        reason: endReason,
        bytes_up: session.bytesIn,
        bytes_down: session.bytesOut,
        failover_count: session.failoverCount,
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
    store.endLiveSession(sessionId);
    await store.persist();
    try {
      await currentUpstream.close();
    } catch {
      /* ignore */
    }
    if (!socket.destroyed) socket.end();
  };

  const pumpRtcm = () => {
    const localAbort = new AbortController();
    rtcmAbort = localAbort;
    void (async () => {
      try {
        for await (const chunk of currentUpstream.readRtcm()) {
          if (localAbort.signal.aborted || socket.destroyed || ended) break;
          ctrl.markHealthy();
          session.bytesOut += chunk.byteLength;
          store.updateLiveSession(sessionId, {
            bytes_down: session.bytesOut,
            upstream_ok: true,
          });
          socket.write(Buffer.from(chunk));
        }
        if (!ended && !localAbort.signal.aborted) {
          await maybeFailoverOrEnd('upstream_end');
        }
      } catch {
        if (!ended && !localAbort.signal.aborted) {
          await maybeFailoverOrEnd('upstream_error');
        }
      }
    })();
  };

  const maybeFailoverOrEnd = async (why: string) => {
    store.setUpstreamHealth(currentEndpoint.id, identity.orgId, {
      status: 'unreachable',
      reachable: false,
      last_error: why,
    });
    store.updateLiveSession(sessionId, { upstream_ok: false });

    // For mid-session failover, respect hysteresis unless unhealthy_after_ms is 0
    // Tests / demos often use 0. Also treat connect-already-failed as ready after mark.
    const check = ctrl.markUnhealthy(Date.now());
    if (check.reason === 'max_switches_exhausted') {
      await endSession('max_switches_exhausted');
      return;
    }
    if (!check.ready && policy.failover.unhealthy_after_ms > 0) {
      // Wait remaining hysteresis then re-check once (simple v0)
      await new Promise((r) => setTimeout(r, check.remainingMs));
      if (ended) return;
      const again = ctrl.markUnhealthy(Date.now());
      if (!again.ready) {
        await endSession(why);
        return;
      }
    }

    const nextSel = selectCandidates({
      policy,
      healthByUpstream: store.healthMapForOrg(identity.orgId),
      excludedUpstreamIds: new Set([
        ...ctrl.excludedUpstreamIds,
        currentEndpoint.id,
      ]),
    });
    if (!nextSel.selected) {
      if (policy.failover.on_exhaust === 'keep_last_best_effort') {
        await endSession('keep_last_best_effort');
      } else {
        await endSession('candidates_exhausted');
      }
      return;
    }

    const sw = ctrl.commitSwitch(nextSel.selected.upstream_endpoint_id);
    // If unhealthy_after_ms was 0, commitSwitch may still require markUnhealthy ready
    if (!sw.ok && policy.failover.unhealthy_after_ms === 0) {
      // Force exclude + pick via rejectCurrentAndPick path
      const forced = ctrl.rejectCurrentAndPick(
        nextSel.selected.upstream_endpoint_id,
      );
      if (!forced.ok) {
        await endSession(forced.reason);
        return;
      }
    } else if (!sw.ok) {
      await endSession(sw.reason);
      return;
    }

    session.state = 'failing_over';
    try {
      await currentUpstream.close();
    } catch {
      /* ignore */
    }

    const nextConn = await connectCandidate(
      store,
      config,
      identity.orgId,
      nextSel.selected,
      requestMount,
    );
    if (!nextConn) {
      await endSession('failover_connect_failed');
      return;
    }

    session.failoverCount += 1;
    currentUpstream = nextConn.upstream;
    currentEndpoint = nextConn.endpoint;
    session.selectedUpstreamId = currentEndpoint.id;
    session.state = 'streaming';
    store.updateLiveSession(sessionId, {
      upstream_id: currentEndpoint.id,
      failover_count: session.failoverCount,
      upstream_ok: true,
    });
    store.appendAudit({
      org_id: identity.orgId,
      actor_type: 'device',
      actor_id: identity.deviceId,
      event_type: 'session.failover',
      resource_type: 'session',
      resource_id: sessionId,
      payload_json: {
        to_upstream_id: currentEndpoint.id,
        reason: 'switched_secondary',
        trigger: why,
      },
    });
    await store.persist();
    pumpRtcm();
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
    void currentUpstream.writeGga(text);
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
    void currentUpstream.writeGga(text);
  });

  socket.on('close', () => {
    void endSession('client_close');
  });
  socket.on('error', () => {
    void endSession('client_error');
  });

  pumpRtcm();
}

function parseMount(requestLine: string): string {
  const parts = requestLine.split(' ');
  const path = parts[1] ?? '/';
  return path.replace(/^\//, '') || 'MOUNT';
}

import { Store } from '@grokbot/core';
import { ApiErrorBody } from './types.js';

export function orgHealth(store: Store, orgId: string): {
  status: number;
  body: Record<string, unknown> | ApiErrorBody;
} {
  const org = store.getOrg(orgId);
  if (!org) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'org not found' },
    };
  }
  const sessions = store.liveSessionsForOrg(orgId).map((s) => ({
    session_id: s.session_id,
    device_id: s.device_id,
    upstream_id: s.upstream_id,
    started_at: s.started_at,
    failover_count: s.failover_count ?? 0,
    upstream_ok: s.upstream_ok ?? null,
    last_gga_age_ms: s.last_gga_at
      ? Date.now() - Date.parse(s.last_gga_at)
      : null,
    // Ephemeral last_position for live health only — not metering / not track
    has_last_position: Boolean(s.last_position),
  }));
  const upstreams = store.listUpstreamHealth(orgId);
  return {
    status: 200,
    body: {
      org_id: orgId,
      active_sessions: sessions.length,
      sessions,
      upstreams,
      notes:
        'GGA/last-position for session health only — no track histories; metering = connect/bytes/device-days only',
    },
  };
}

export function upstreamHealth(store: Store, upstreamId: string): {
  status: number;
  body: Record<string, unknown> | ApiErrorBody;
} {
  const up = store.getUpstream(upstreamId);
  if (!up) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'upstream not found' },
    };
  }
  const snap = store.getUpstreamHealth(upstreamId);
  return {
    status: 200,
    body: {
      upstream_id: upstreamId,
      org_id: up.org_id,
      display_name: up.display_name,
      adapter_type: up.adapter_type,
      enabled: up.enabled,
      health: snap ?? {
        upstream_id: upstreamId,
        org_id: up.org_id,
        status: 'unknown',
        reachable: false,
        updated_at: null,
      },
      active_sessions: [...store.liveSessions.values()].filter(
        (s) => s.upstream_id === upstreamId,
      ).length,
    },
  };
}

export function deviceHealth(store: Store, deviceId: string): {
  status: number;
  body: Record<string, unknown> | ApiErrorBody;
} {
  const device = store.getDevice(deviceId);
  if (!device) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'device not found' },
    };
  }
  const live = store.getLiveSessionForDevice(deviceId);
  return {
    status: 200,
    body: {
      device_id: deviceId,
      org_id: device.org_id,
      profile_id: device.profile_id ?? null,
      status: device.status,
      session: live
        ? {
            session_id: live.session_id,
            upstream_id: live.upstream_id ?? null,
            started_at: live.started_at,
            failover_count: live.failover_count ?? 0,
            upstream_ok: live.upstream_ok ?? null,
            last_gga_age_ms: live.last_gga_at
              ? Date.now() - Date.parse(live.last_gga_at)
              : null,
            has_last_position: Boolean(live.last_position),
            bytes_up: live.bytes_up,
            bytes_down: live.bytes_down,
          }
        : null,
      notes:
        'Ephemeral GGA/last-position dropped on session end — no track histories',
    },
  };
}

export function listActiveSessions(store: Store, orgId: string): {
  status: number;
  body: Record<string, unknown> | ApiErrorBody;
} {
  const org = store.getOrg(orgId);
  if (!org) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'org not found' },
    };
  }
  const sessions = store.liveSessionsForOrg(orgId).map((s) => ({
    session_id: s.session_id,
    device_id: s.device_id,
    upstream_id: s.upstream_id,
    started_at: s.started_at,
    failover_count: s.failover_count ?? 0,
    has_last_position: Boolean(s.last_position),
  }));
  return {
    status: 200,
    body: { org_id: orgId, status: 'active', sessions },
  };
}

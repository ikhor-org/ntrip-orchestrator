import {
  buildUsageExport,
  signUsageExport,
  Store,
  webhookPublicView,
} from '@ntrip-orchestrator/core';
import { ApiErrorBody } from './types.js';

function parseQuery(url: string): URLSearchParams {
  const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  return new URLSearchParams(q);
}

export function queryUsageEvents(
  store: Store,
  orgId: string,
  url: string,
): { status: number; body: Record<string, unknown> | ApiErrorBody } {
  const org = store.getOrg(orgId);
  if (!org) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'org not found' },
    };
  }
  const qs = parseQuery(url);
  const filter: {
    org_id: string;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
  } = { org_id: orgId };
  const from = qs.get('from');
  const to = qs.get('to');
  const cursor = qs.get('cursor');
  const limitRaw = qs.get('limit');
  if (from) filter.from = from;
  if (to) filter.to = to;
  if (cursor) filter.cursor = cursor;
  if (limitRaw) filter.limit = Number(limitRaw);
  const page = store.queryMetering(filter);
  return {
    status: 200,
    body: {
      events: page.events,
      next_cursor: page.next_cursor,
      notes:
        'Metering = connect/bytes/device-days only — no lat/lon/GGA/track fields',
    },
  };
}

export function exportUsage(
  store: Store,
  orgId: string,
  url: string,
  opts?: { webhook_id?: string },
): { status: number; body: Record<string, unknown> | ApiErrorBody } {
  const org = store.getOrg(orgId);
  if (!org) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'org not found' },
    };
  }
  const qs = parseQuery(url);
  const filter: {
    org_id: string;
    from?: string;
    to?: string;
    limit?: number;
  } = { org_id: orgId, limit: 1000 };
  const from = qs.get('from');
  const to = qs.get('to');
  if (from) filter.from = from;
  if (to) filter.to = to;
  const page = store.queryMetering(filter);
  const bundle = buildUsageExport(orgId, page.events);

  let signature: string | undefined;
  let webhook_id: string | undefined;
  const hookId = opts?.webhook_id ?? qs.get('webhook_id') ?? undefined;
  if (hookId) {
    const hook = store.usageWebhooks.get(hookId);
    if (!hook || hook.org_id !== orgId) {
      return {
        status: 404,
        body: { error: 'not_found', message: 'webhook not found' },
      };
    }
    const signed = signUsageExport(hook.secret, bundle);
    signature = signed.signature;
    webhook_id = hook.id;
  }

  const body: Record<string, unknown> = {
    ...bundle,
    // Explicitly document absence of location fields
    location_fields: 'forbidden',
  };
  if (signature !== undefined) {
    body.signature = signature;
    body.signature_alg = 'HMAC-SHA256';
    body.signature_input = 'exported_at + "." + body_json';
  }
  if (webhook_id !== undefined) body.webhook_id = webhook_id;
  return { status: 200, body };
}

export function registerUsageWebhook(
  store: Store,
  orgId: string,
  input: { url?: string; secret?: string },
): { status: number; body: Record<string, unknown> | ApiErrorBody } {
  const org = store.getOrg(orgId);
  if (!org) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'org not found' },
    };
  }
  if (!input.url || !/^https?:\/\//i.test(input.url)) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'url must be an http(s) webhook sink',
      },
    };
  }
  const hook = store.createUsageWebhook(orgId, input.url, input.secret);
  store.appendAudit({
    org_id: orgId,
    actor_type: 'api',
    actor_id: 'local',
    event_type: 'usage.webhook.registered',
    resource_type: 'usage_webhook',
    resource_id: hook.id,
    payload_json: { url: hook.url },
  });
  // Return secret ONCE at registration (like device password)
  return {
    status: 201,
    body: {
      ...webhookPublicView(hook),
      secret: hook.secret,
      notes:
        'Store secret now — used to verify HMAC-SHA256 signatures on usage exports. Metering never includes lat/lon.',
    },
  };
}

export function queryAudit(
  store: Store,
  orgId: string,
  url: string,
): { status: number; body: Record<string, unknown> | ApiErrorBody } {
  const org = store.getOrg(orgId);
  if (!org) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'org not found' },
    };
  }
  const qs = parseQuery(url);
  const filter: {
    org_id: string;
    from?: string;
    to?: string;
    event_type?: string;
    device_id?: string;
    cursor?: string;
    limit?: number;
  } = { org_id: orgId };
  const from = qs.get('from');
  const to = qs.get('to');
  const event_type = qs.get('event_type');
  const device_id = qs.get('device_id');
  const cursor = qs.get('cursor');
  const limitRaw = qs.get('limit');
  if (from) filter.from = from;
  if (to) filter.to = to;
  if (event_type) filter.event_type = event_type;
  if (device_id) filter.device_id = device_id;
  if (cursor) filter.cursor = cursor;
  if (limitRaw) filter.limit = Number(limitRaw);
  const page = store.queryAudit(filter);
  return {
    status: 200,
    body: { events: page.events, next_cursor: page.next_cursor },
  };
}

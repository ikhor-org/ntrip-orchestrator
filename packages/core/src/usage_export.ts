/**
 * Usage export helpers — connect/bytes/device-days only; no location fields.
 */

import { createHmac } from 'node:crypto';
import { assertNoLocationFields } from './metering.js';
import { MeteringEvent } from './types.js';

export interface UsageExportBundle {
  org_id: string;
  exported_at: string;
  event_count: number;
  events: MeteringEvent[];
}

export function buildUsageExport(
  orgId: string,
  events: MeteringEvent[],
  exportedAt = new Date().toISOString(),
): UsageExportBundle {
  for (const e of events) {
    assertNoLocationFields(e.payload_json);
  }
  return {
    org_id: orgId,
    exported_at: exportedAt,
    event_count: events.length,
    events,
  };
}

export function signUsageExport(
  secret: string,
  bundle: UsageExportBundle,
): { body: string; signature: string; timestamp: string } {
  const timestamp = bundle.exported_at;
  const body = JSON.stringify(bundle);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return { body, signature, timestamp };
}

/** Public webhook registration response — never includes raw secret after create. */
export function webhookPublicView(hook: {
  id: string;
  org_id: string;
  url: string;
  secret: string;
  enabled: boolean;
  created_at: string;
}): {
  id: string;
  org_id: string;
  url: string;
  enabled: boolean;
  created_at: string;
  secret_last4: string;
} {
  return {
    id: hook.id,
    org_id: hook.org_id,
    url: hook.url,
    enabled: hook.enabled,
    created_at: hook.created_at,
    secret_last4: hook.secret.slice(-4),
  };
}

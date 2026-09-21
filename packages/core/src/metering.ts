import { METERING_FORBIDDEN_KEYS } from './constants.js';
import { MeteringEvent, MeteringEventType } from './types.js';

export class MeteringValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeteringValidationError';
  }
}

function hasForbiddenKey(obj: unknown, path = ''): string | null {
  if (obj === null || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const hit = hasForbiddenKey(obj[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if ((METERING_FORBIDDEN_KEYS as readonly string[]).includes(lower)) {
      return path ? `${path}.${k}` : k;
    }
    const hit = hasForbiddenKey(v, path ? `${path}.${k}` : k);
    if (hit) return hit;
  }
  return null;
}

/** Reject payloads that contain forbidden location fields. */
export function assertNoLocationFields(
  payload: Record<string, unknown>,
): void {
  const hit = hasForbiddenKey(payload);
  if (hit) {
    throw new MeteringValidationError(
      `metering payload must not include location field: ${hit}`,
    );
  }
}

export function buildMeteringEvent(input: {
  id: string;
  org_id: string;
  device_id?: string;
  session_id?: string;
  event_type: MeteringEventType;
  payload_json: Record<string, unknown>;
  ts?: string;
}): MeteringEvent {
  assertNoLocationFields(input.payload_json);
  const event: MeteringEvent = {
    id: input.id,
    org_id: input.org_id,
    event_type: input.event_type,
    payload_json: { ...input.payload_json },
    ts: input.ts ?? new Date().toISOString(),
  };
  if (input.device_id !== undefined) event.device_id = input.device_id;
  if (input.session_id !== undefined) event.session_id = input.session_id;
  return event;
}

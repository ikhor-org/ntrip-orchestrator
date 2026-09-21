import { cposAdapter } from './cpos.js';
import { geodnetAdapter } from './geodnet.js';
import { ntripBasicAdapter } from './ntrip_basic.js';
import { pointOneAdapter } from './point_one.js';
import { skylarkAdapter } from './skylark.js';
import { smartnetAdapter } from './smartnet.js';
import { Adapter, AdapterType } from './types.js';

/**
 * Adapters eligible for routing. CPOS is intentionally omitted —
 * present in codebase for SI visibility of intent, but not registered.
 */
const ROUTABLE: Adapter[] = [
  ntripBasicAdapter,
  pointOneAdapter,
  geodnetAdapter,
  skylarkAdapter,
  smartnetAdapter,
];

export function listRoutableAdapters(): readonly Adapter[] {
  return ROUTABLE.filter((a) => a.enabled);
}

export function getRoutableAdapter(type: AdapterType): Adapter | undefined {
  if (type === 'cpos_customer') {
    return undefined;
  }
  return ROUTABLE.find((a) => a.type === type && a.enabled);
}

/** CPOS stub accessor for tests/docs — never use for live routing. */
export function getCposStubDisabled(): Adapter {
  return cposAdapter;
}

export function isCposRoutingAllowed(): boolean {
  return process.env.CPOS_ADAPTER_ENABLED === 'true' && cposAdapter.enabled;
}

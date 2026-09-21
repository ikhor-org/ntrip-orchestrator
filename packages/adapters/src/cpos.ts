import {
  Adapter,
  AdapterDisabledError,
  SecretMaterial,
  SessionHints,
  UpstreamEndpoint,
  UpstreamSession,
} from './types.js';

/**
 * CPOS (customer-supplied Kartverket credentials) — STUB EXPLICITLY DISABLED.
 * Not registered for routing. Post-counsel only (Sentinel CLEAR / architecture §3.7).
 * Do not enable until Kartverket ToS counsel clears credential proxying.
 */
export const cposAdapter: Adapter = {
  type: 'cpos_customer',
  /** Hard-disabled: never selected by registry for routing. */
  enabled: false,
  async connect(
    _ctx,
    _endpoint: UpstreamEndpoint,
    _secret: SecretMaterial,
    _hints: SessionHints,
  ): Promise<UpstreamSession> {
    throw new AdapterDisabledError(
      'cpos_customer',
      'post-counsel only; CPOS_ADAPTER_ENABLED defaults false; not registered for routing',
    );
  },
};

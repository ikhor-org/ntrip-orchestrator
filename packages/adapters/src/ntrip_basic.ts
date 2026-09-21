import {
  Adapter,
  AdapterNotImplementedError,
  SecretMaterial,
  SessionHints,
  UpstreamEndpoint,
  UpstreamSession,
} from './types.js';

/**
 * Generic NTRIP Basic Auth — v0 ship path (architecture §6.2).
 * M0: interface placeholder only; real upstream connect in M1.
 */
export const ntripBasicAdapter: Adapter = {
  type: 'ntrip_basic',
  enabled: true,
  async connect(
    _ctx,
    _endpoint: UpstreamEndpoint,
    _secret: SecretMaterial,
    _hints: SessionHints,
  ): Promise<UpstreamSession> {
    throw new AdapterNotImplementedError('ntrip_basic');
  },
};

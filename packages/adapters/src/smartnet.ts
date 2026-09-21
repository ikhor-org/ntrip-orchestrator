import {
  Adapter,
  AdapterNotImplementedError,
  SecretMaterial,
  SessionHints,
  UpstreamEndpoint,
  UpstreamSession,
} from './types.js';

/**
 * SmartNet dedicated stub — prefer generic NTRIP with customer seats when possible.
 * Stub only if portal API is required later.
 */
export const smartnetAdapter: Adapter = {
  type: 'smartnet',
  enabled: true,
  async connect(
    _ctx,
    _endpoint: UpstreamEndpoint,
    _secret: SecretMaterial,
    _hints: SessionHints,
  ): Promise<UpstreamSession> {
    throw new AdapterNotImplementedError('smartnet');
  },
};

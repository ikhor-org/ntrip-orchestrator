import {
  Adapter,
  AdapterNotImplementedError,
  SecretMaterial,
  SessionHints,
  UpstreamEndpoint,
  UpstreamSession,
} from './types.js';

/** Skylark — stub until OEM agreement. */
export const skylarkAdapter: Adapter = {
  type: 'skylark',
  enabled: true,
  async connect(
    _ctx,
    _endpoint: UpstreamEndpoint,
    _secret: SecretMaterial,
    _hints: SessionHints,
  ): Promise<UpstreamSession> {
    throw new AdapterNotImplementedError('skylark');
  },
};

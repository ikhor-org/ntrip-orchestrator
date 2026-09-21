import {
  Adapter,
  AdapterNotImplementedError,
  SecretMaterial,
  SessionHints,
  UpstreamEndpoint,
  UpstreamSession,
} from './types.js';

/** Point One token adapter — stub until token-lifecycle design + account. */
export const pointOneAdapter: Adapter = {
  type: 'point_one_token',
  enabled: true,
  async connect(
    _ctx,
    _endpoint: UpstreamEndpoint,
    _secret: SecretMaterial,
    _hints: SessionHints,
  ): Promise<UpstreamSession> {
    throw new AdapterNotImplementedError('point_one_token');
  },
};

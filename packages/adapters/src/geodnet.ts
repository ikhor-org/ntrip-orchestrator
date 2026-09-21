import {
  Adapter,
  AdapterNotImplementedError,
  SecretMaterial,
  SessionHints,
  UpstreamEndpoint,
  UpstreamSession,
} from './types.js';

/** GEODNET enterprise — stub until API access. */
export const geodnetAdapter: Adapter = {
  type: 'geodnet_enterprise',
  enabled: true,
  async connect(
    _ctx,
    _endpoint: UpstreamEndpoint,
    _secret: SecretMaterial,
    _hints: SessionHints,
  ): Promise<UpstreamSession> {
    throw new AdapterNotImplementedError('geodnet_enterprise');
  },
};

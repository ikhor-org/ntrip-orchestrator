/**
 * NTRIP Basic Auth against pseudo-credentials — never against upstream master.
 * M0: stub validator (always rejects unknown; accepts documented fixture user).
 */

export interface PseudoIdentity {
  deviceId: string;
  orgId: string;
  username: string;
}

const FIXTURE_USER = 'fixture-device';
const FIXTURE_PASS = 'fixture-pass-not-for-prod';

export function parseBasicAuth(
  header: string | undefined,
): { user: string; pass: string } | null {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export function authenticatePseudo(
  user: string,
  pass: string,
): PseudoIdentity | null {
  if (user === FIXTURE_USER && pass === FIXTURE_PASS) {
    return {
      deviceId: '00000000-0000-4000-8000-0000000000d1',
      orgId: '00000000-0000-4000-8000-000000000001',
      username: user,
    };
  }
  return null;
}

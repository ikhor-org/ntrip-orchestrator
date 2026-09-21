/**
 * NTRIP Basic Auth against pseudo-credentials — never against upstream master.
 */

import { Store, verifyPassword } from '@grokbot/core';

export interface PseudoIdentity {
  deviceId: string;
  orgId: string;
  username: string;
  profileId?: string;
}

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

export async function authenticatePseudo(
  store: Store,
  user: string,
  pass: string,
): Promise<PseudoIdentity | null> {
  await store.reload();
  const cred = store.getCredentialByUsername(user);
  if (!cred || cred.revoked_at) return null;
  if (cred.expires_at && Date.parse(cred.expires_at) < Date.now()) return null;
  const device = store.getDevice(cred.device_id);
  if (!device || device.status !== 'active') return null;
  const ok = await verifyPassword(pass, cred.password_hash);
  if (!ok) return null;
  const identity: PseudoIdentity = {
    deviceId: device.id,
    orgId: device.org_id,
    username: cred.username,
  };
  if (device.profile_id !== undefined) identity.profileId = device.profile_id;
  return identity;
}

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ApiKeyRecord,
  ApiKeyRole,
  hashPassword,
  Store,
  verifyPassword,
} from '@grokbot/core';
import { ApiErrorBody } from './types.js';

export type AuthActor =
  | { kind: 'ops'; label: string }
  | { kind: 'api_key'; key: ApiKeyRecord; role: ApiKeyRole; org_id: string }
  | { kind: 'fixture_dev' };

export type AuthOk = { ok: true; actor: AuthActor };
export type AuthFail = { ok: false; status: number; body: ApiErrorBody };
export type AuthResult = AuthOk | AuthFail;

const ROLE_RANK: Record<ApiKeyRole, number> = {
  read: 1,
  operator: 2,
  admin: 3,
};

export function roleAtLeast(have: ApiKeyRole, need: ApiKeyRole): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[need];
}

export function generateApiKeySecret(): { plaintext: string; prefix: string } {
  const raw = randomBytes(24).toString('base64url');
  const plaintext = `gbk_${raw}`;
  return { plaintext, prefix: plaintext.slice(0, 12) };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!;
  return diff === 0;
}

export function extractPresentedKey(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const x = headers['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

export async function resolveAuth(
  store: Store,
  headers: Record<string, string | string[] | undefined>,
  opts: {
    opsApiKey?: string;
    allowFixtureDev?: boolean;
    requireAuth?: boolean;
  },
): Promise<AuthResult> {
  const opsHeader =
    typeof headers['x-ops-key'] === 'string'
      ? headers['x-ops-key'].trim()
      : undefined;
  const presented = extractPresentedKey(headers);

  if (opts.opsApiKey) {
    if (opsHeader && timingSafeEqualStr(opsHeader, opts.opsApiKey)) {
      return { ok: true, actor: { kind: 'ops', label: 'platform_ops' } };
    }
    if (presented && timingSafeEqualStr(presented, opts.opsApiKey)) {
      return { ok: true, actor: { kind: 'ops', label: 'platform_ops' } };
    }
  }

  if (presented) {
    for (const key of store.listActiveApiKeys()) {
      if (await verifyPassword(presented, key.key_hash)) {
        store.touchApiKey(key.id);
        return {
          ok: true,
          actor: {
            kind: 'api_key',
            key,
            role: key.role,
            org_id: key.org_id,
          },
        };
      }
    }
    return {
      ok: false,
      status: 401,
      body: { error: 'unauthorized', message: 'Invalid or revoked API key' },
    };
  }

  if (opsHeader) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'unauthorized',
        message: opts.opsApiKey
          ? 'Invalid ops key'
          : 'Ops key not configured (set OPS_API_KEY)',
      },
    };
  }

  if (opts.allowFixtureDev && !opts.requireAuth) {
    return { ok: true, actor: { kind: 'fixture_dev' } };
  }

  return {
    ok: false,
    status: 401,
    body: {
      error: 'unauthorized',
      message:
        'API key required (Authorization: Bearer, X-Api-Key, or X-Ops-Key)',
    },
  };
}

export function requireRole(
  actor: AuthActor,
  need: ApiKeyRole,
  orgId?: string,
): AuthFail | null {
  if (actor.kind === 'ops') return null;
  if (actor.kind === 'fixture_dev') return null;
  if (orgId && actor.org_id !== orgId) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'forbidden',
        message: 'API key is not scoped to this org',
      },
    };
  }
  if (!roleAtLeast(actor.role, need)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'forbidden',
        message: `Role '${actor.role}' cannot perform this action (requires '${need}')`,
      },
    };
  }
  return null;
}

export function requireOps(actor: AuthActor): AuthFail | null {
  if (actor.kind === 'ops') return null;
  return {
    ok: false,
    status: 403,
    body: {
      error: 'forbidden',
      message: 'Platform ops key required for this action',
    },
  };
}

export function actorAuditFields(actor: AuthActor): {
  actor_type: string;
  actor_id: string;
} {
  if (actor.kind === 'ops') {
    return { actor_type: 'ops', actor_id: actor.label };
  }
  if (actor.kind === 'api_key') {
    return { actor_type: 'api_key', actor_id: actor.key.id };
  }
  return { actor_type: 'fixture_dev', actor_id: 'local' };
}

export async function createOrgApiKey(
  store: Store,
  orgId: string,
  role: ApiKeyRole,
  label?: string,
): Promise<{ record: ApiKeyRecord; plaintext: string }> {
  const { plaintext, prefix } = generateApiKeySecret();
  const key_hash = await hashPassword(plaintext);
  const record: ApiKeyRecord = {
    id: randomUUID(),
    org_id: orgId,
    key_prefix: prefix,
    key_hash,
    role,
    created_at: new Date().toISOString(),
  };
  if (label !== undefined) record.label = label;
  store.putApiKey(record);
  return { record, plaintext };
}

export function publicApiKeyView(record: ApiKeyRecord): Record<string, unknown> {
  return {
    id: record.id,
    org_id: record.org_id,
    key_prefix: record.key_prefix,
    role: record.role,
    label: record.label ?? null,
    created_at: record.created_at,
    revoked_at: record.revoked_at ?? null,
    last_used_at: record.last_used_at ?? null,
  };
}

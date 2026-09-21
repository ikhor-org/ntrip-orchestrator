import { randomUUID } from 'node:crypto';
import {
  encryptJson,
  FIXTURE_ORG_ID,
  NtripBasicSecret,
  parseKek,
  Store,
  UpstreamEndpoint,
  VaultSecretRecord,
} from '@grokbot/core';
import { ApiConfig } from './config.js';
import { ApiErrorBody } from './types.js';

export interface VaultSeedResult {
  status: number;
  body:
    | {
        upstream_id: string;
        secret_id: string;
        last4: string;
        adapter_type: string;
        host: string;
        port: number;
        mountpoint?: string;
      }
    | ApiErrorBody;
}

/**
 * Seed a fixture-org upstream + vaulted ntrip_basic secret.
 * Never returns plaintext password.
 */
export function seedFixtureUpstreamSecret(
  store: Store,
  config: ApiConfig,
  input: {
    display_name?: string;
    host: string;
    port?: number;
    use_tls?: boolean;
    mountpoint?: string;
    username: string;
    password: string;
  },
): VaultSeedResult {
  if (!config.allowFixtureOrgs) {
    return {
      status: 403,
      body: {
        error: 'fixture_org_only',
        message: 'Vault seed requires ALLOW_FIXTURE_ORGS=true in non-prod.',
      },
    };
  }
  if (!config.vaultKekRaw) {
    return {
      status: 500,
      body: {
        error: 'vault_kek_missing',
        message: 'Set VAULT_KEK or VAULT_MASTER_KEY (32-byte hex or base64).',
      },
    };
  }
  if (!input.host || !input.username || !input.password) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'host, username, and password are required',
      },
    };
  }

  store.seedFixtureOrg();
  const kek = parseKek(config.vaultKekRaw);
  const now = new Date().toISOString();
  const upstreamId = randomUUID();
  const secretId = randomUUID();

  const upstream: UpstreamEndpoint = {
    id: upstreamId,
    org_id: FIXTURE_ORG_ID,
    adapter_type: 'ntrip_basic',
    display_name: input.display_name ?? 'fixture-ntrip-upstream',
    host: input.host,
    port: input.port ?? 2101,
    use_tls: input.use_tls ?? false,
    options_json: {},
    enabled: true,
    created_at: now,
  };
  if (input.mountpoint !== undefined) {
    upstream.default_mountpoint = input.mountpoint;
  }

  const plain: NtripBasicSecret = {
    username: input.username,
    password: input.password,
  };
  if (input.mountpoint !== undefined) plain.mountpoint = input.mountpoint;

  const blob = encryptJson(kek, plain);
  const last4 = input.password.slice(-4);

  const secret: VaultSecretRecord = {
    id: secretId,
    upstream_id: upstreamId,
    secret_type: 'ntrip_basic',
    ciphertext: blob.ciphertext,
    nonce: blob.nonce,
    key_version: blob.keyVersion,
    last4,
    created_at: now,
  };

  store.putUpstream(upstream);
  store.putVaultSecret(secret);
  store.appendAudit({
    org_id: FIXTURE_ORG_ID,
    actor_type: 'api',
    actor_id: 'local',
    event_type: 'vault.secret.created',
    resource_type: 'vault_secret',
    resource_id: secretId,
    payload_json: {
      upstream_id: upstreamId,
      secret_type: 'ntrip_basic',
      last4,
    },
  });

  const body: {
    upstream_id: string;
    secret_id: string;
    last4: string;
    adapter_type: string;
    host: string;
    port: number;
    mountpoint?: string;
  } = {
    upstream_id: upstreamId,
    secret_id: secretId,
    last4,
    adapter_type: 'ntrip_basic',
    host: upstream.host,
    port: upstream.port,
  };
  if (upstream.default_mountpoint !== undefined) {
    body.mountpoint = upstream.default_mountpoint;
  }

  return { status: 201, body };
}

/**
 * Ops: vault an upstream NTRIP secret for an activated, screened pilot org.
 * Never opens fixture routes; never returns plaintext password.
 * Callers must enforce OPS_API_KEY at the HTTP layer.
 */
export function seedOpsUpstreamSecret(
  store: Store,
  config: ApiConfig,
  orgId: string,
  input: {
    display_name?: string;
    host: string;
    port?: number;
    use_tls?: boolean;
    mountpoint?: string;
    username: string;
    password: string;
  },
): VaultSeedResult {
  const org = store.getOrg(orgId);
  if (!org) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'org not found' },
    };
  }
  if (org.status === 'fixture' || org.screening_status === 'fixture_exempt') {
    return {
      status: 403,
      body: {
        error: 'fixture_org_only',
        message:
          'Use POST /v0/fixture/upstream-secret for fixture orgs (non-prod only). Ops vault is for screened pilot orgs.',
      },
    };
  }
  if (org.status === 'suspended') {
    return {
      status: 403,
      body: {
        error: 'org_suspended',
        message: 'Suspended orgs cannot receive vaulted upstreams',
      },
    };
  }
  if (org.status !== 'active' || org.screening_status !== 'cleared') {
    return {
      status: 403,
      body: {
        error: 'screening_required',
        message:
          'Ops upstream vault requires an active org with screening_status=cleared',
      },
    };
  }
  if (!config.vaultKekRaw) {
    return {
      status: 500,
      body: {
        error: 'vault_kek_missing',
        message: 'Set VAULT_KEK or VAULT_MASTER_KEY (32-byte hex or base64).',
      },
    };
  }
  if (!input.host || !input.username || !input.password) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'host, username, and password are required',
      },
    };
  }

  const kek = parseKek(config.vaultKekRaw);
  const now = new Date().toISOString();
  const upstreamId = randomUUID();
  const secretId = randomUUID();

  const upstream: UpstreamEndpoint = {
    id: upstreamId,
    org_id: orgId,
    adapter_type: 'ntrip_basic',
    display_name: input.display_name ?? 'ops-ntrip-upstream',
    host: input.host,
    port: input.port ?? 2101,
    use_tls: input.use_tls ?? false,
    options_json: {},
    enabled: true,
    created_at: now,
  };
  if (input.mountpoint !== undefined) {
    upstream.default_mountpoint = input.mountpoint;
  }

  const plain: NtripBasicSecret = {
    username: input.username,
    password: input.password,
  };
  if (input.mountpoint !== undefined) plain.mountpoint = input.mountpoint;

  const blob = encryptJson(kek, plain);
  const last4 = input.password.slice(-4);

  const secret: VaultSecretRecord = {
    id: secretId,
    upstream_id: upstreamId,
    secret_type: 'ntrip_basic',
    ciphertext: blob.ciphertext,
    nonce: blob.nonce,
    key_version: blob.keyVersion,
    last4,
    created_at: now,
  };

  store.putUpstream(upstream);
  store.putVaultSecret(secret);
  store.appendAudit({
    org_id: orgId,
    actor_type: 'ops',
    actor_id: 'platform_ops',
    event_type: 'vault.secret.created',
    resource_type: 'vault_secret',
    resource_id: secretId,
    payload_json: {
      upstream_id: upstreamId,
      secret_type: 'ntrip_basic',
      last4,
      host: upstream.host,
      port: upstream.port,
    },
  });

  const body: {
    upstream_id: string;
    secret_id: string;
    last4: string;
    adapter_type: string;
    host: string;
    port: number;
    mountpoint?: string;
  } = {
    upstream_id: upstreamId,
    secret_id: secretId,
    last4,
    adapter_type: 'ntrip_basic',
    host: upstream.host,
    port: upstream.port,
  };
  if (upstream.default_mountpoint !== undefined) {
    body.mountpoint = upstream.default_mountpoint;
  }

  return { status: 201, body };
}

import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { generateKekHex, Store } from '@grokbot/core';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

const KEK = generateKekHex();
const OPS = 'test-ops-key-upstream-smoke';

function makeStore(): Store {
  const store = new Store();
  store.seedFixtureOrg();
  return store;
}

function request(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      reject(new Error('no address'));
      return;
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          ...(payload
            ? { 'content-length': Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(
  env: Record<string, string>,
  fn: (server: http.Server, store: Store) => Promise<void>,
): Promise<void> {
  const store = makeStore();
  const config = loadConfig({
    NODE_ENV: 'development',
    VAULT_KEK: KEK,
    OPS_API_KEY: OPS,
    ...env,
  });
  const server = createServer({ store, config });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn(server, store);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function intakeClearActivate(server: http.Server): Promise<string> {
  const intake = await request(
    server,
    'POST',
    '/v0/ops/pilot-orgs',
    {
      name: 'Pilot Smoke SI',
      country: 'NO',
      icp_segment: 'A',
      end_use_representation: 'Civil construction machine-control',
    },
    { 'x-ops-key': OPS },
  );
  assert.equal(intake.status, 201, JSON.stringify(intake.json));
  const orgId = intake.json.id as string;

  const screen = await request(
    server,
    'POST',
    `/v0/orgs/${orgId}/screening`,
    {
      result: 'cleared',
      screening_reference: 'SCR-SMOKE-1',
      prohibited_use_attested: true,
      sanctions_cleared: true,
      upstream_tos_acknowledged: true,
    },
    { 'x-ops-key': OPS },
  );
  assert.equal(screen.status, 200, JSON.stringify(screen.json));

  const activate = await request(
    server,
    'POST',
    `/v0/orgs/${orgId}/activate`,
    {},
    { 'x-ops-key': OPS },
  );
  assert.equal(activate.status, 200, JSON.stringify(activate.json));
  return orgId;
}

const upstreamBody = {
  display_name: 'mock-caster',
  host: 'mock-caster',
  port: 2102,
  mountpoint: 'MOCK',
  username: 'mock',
  password: 'mock-secret-xyz',
};

test('ops upstream vault returns 401 without ops key', async () => {
  await withServer({ ALLOW_FIXTURE_ORGS: 'false' }, async (server) => {
    const orgId = await intakeClearActivate(server);
    const res = await request(
      server,
      'POST',
      `/v0/ops/orgs/${orgId}/upstreams`,
      upstreamBody,
    );
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'unauthorized');
  });
});

test('ops upstream vault returns 403 for non-ops api key', async () => {
  await withServer({ ALLOW_FIXTURE_ORGS: 'false' }, async (server) => {
    const orgId = await intakeClearActivate(server);
    const keyRes = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/api-keys`,
      { role: 'admin', label: 'not-ops' },
      { 'x-ops-key': OPS },
    );
    assert.equal(keyRes.status, 201);
    const apiKey = keyRes.json.api_key as string;

    const res = await request(
      server,
      'POST',
      `/v0/ops/orgs/${orgId}/upstreams`,
      upstreamBody,
      { authorization: `Bearer ${apiKey}` },
    );
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'forbidden');
  });
});

test('ops upstream vault 403 when org not active/cleared', async () => {
  await withServer({ ALLOW_FIXTURE_ORGS: 'false' }, async (server) => {
    const intake = await request(
      server,
      'POST',
      '/v0/ops/pilot-orgs',
      {
        name: 'Pending Only',
        country: 'NO',
        end_use_representation: 'Civil use',
      },
      { 'x-ops-key': OPS },
    );
    assert.equal(intake.status, 201);
    const orgId = intake.json.id as string;

    const res = await request(
      server,
      'POST',
      `/v0/ops/orgs/${orgId}/upstreams`,
      upstreamBody,
      { 'x-ops-key': OPS },
    );
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'screening_required');
  });
});

test('ops upstream vault 201 for activated pilot + bind profile/device', async () => {
  await withServer({ ALLOW_FIXTURE_ORGS: 'false' }, async (server, store) => {
    const orgId = await intakeClearActivate(server);

    const up = await request(
      server,
      'POST',
      `/v0/ops/orgs/${orgId}/upstreams`,
      upstreamBody,
      { 'x-ops-key': OPS },
    );
    assert.equal(up.status, 201, JSON.stringify(up.json));
    assert.ok(up.json.upstream_id);
    assert.ok(up.json.secret_id);
    assert.equal(up.json.last4, 'mock-secret-xyz'.slice(-4));
    assert.equal(up.json.host, 'mock-caster');
    assert.equal(up.json.port, 2102);
    assert.equal(up.json.mountpoint, 'MOCK');
    assert.ok(!('password' in up.json));

    const vault = store.getVaultSecret(up.json.upstream_id as string);
    assert.ok(vault);
    assert.equal(vault!.last4, 'mock-secret-xyz'.slice(-4));

    const profile = await request(server, 'POST', `/v0/orgs/${orgId}/profiles`, {
      name: 'pilot-primary',
      candidates: [
        {
          priority: 1,
          upstream_endpoint_id: up.json.upstream_id,
        },
      ],
    });
    assert.equal(profile.status, 201, JSON.stringify(profile.json));
    const profileId = profile.json.id as string;

    const device = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/devices`,
      { label: 'smoke-rover', profile_id: profileId },
      { 'x-ops-key': OPS },
    );
    assert.equal(device.status, 201, JSON.stringify(device.json));
    const deviceBody = device.json.device as { profile_id?: string };
    assert.equal(deviceBody.profile_id, profileId);
    assert.ok(device.json.pseudo_username);
    assert.ok(device.json.pseudo_password);
  });
});

test('fixture upstream-secret still 403 when ALLOW_FIXTURE_ORGS=false', async () => {
  await withServer({ ALLOW_FIXTURE_ORGS: 'false' }, async (server) => {
    const res = await request(server, 'POST', '/v0/fixture/upstream-secret', {
      host: '127.0.0.1',
      port: 2102,
      username: 'u',
      password: 'p',
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'fixture_org_only');
  });
});

test('ops upstream vault rejects fixture org id', async () => {
  await withServer({ ALLOW_FIXTURE_ORGS: 'false' }, async (server) => {
    const { FIXTURE_ORG_ID } = await import('@grokbot/core');
    const res = await request(
      server,
      'POST',
      `/v0/ops/orgs/${FIXTURE_ORG_ID}/upstreams`,
      upstreamBody,
      { 'x-ops-key': OPS },
    );
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'fixture_org_only');
  });
});

import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import {
  getCposStubDisabled,
  listRoutableAdapters,
} from '@grokbot/adapters';
import { generateKekHex, Store } from '@grokbot/core';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

const KEK = generateKekHex();
const OPS = 'test-ops-key-m3-not-for-prod';

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
  fn: (server: http.Server, store: Store) => Promise<void>,
): Promise<void> {
  const store = makeStore();
  const config = loadConfig({
    NODE_ENV: 'development',
    ALLOW_FIXTURE_ORGS: 'true',
    VAULT_KEK: KEK,
    OPS_API_KEY: OPS,
  });
  const server = createServer({ store, config });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn(server, store);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function intakePilot(
  server: http.Server,
  name = 'Nordic Dig SI Pilot',
): Promise<string> {
  const intake = await request(
    server,
    'POST',
    '/v0/ops/pilot-orgs',
    {
      name,
      country: 'NO',
      icp_segment: 'A',
      end_use_representation:
        'Civil construction machine-control for Nordic fleets',
    },
    { 'x-ops-key': OPS },
  );
  assert.equal(intake.status, 201, JSON.stringify(intake.json));
  assert.equal(intake.json.screening_status, 'pending');
  assert.equal(intake.json.status, 'pending_screening');
  return intake.json.id as string;
}

async function clearAndActivate(
  server: http.Server,
  orgId: string,
): Promise<void> {
  const screen = await request(
    server,
    'POST',
    `/v0/orgs/${orgId}/screening`,
    {
      result: 'cleared',
      screening_reference: 'SCR-2026-001',
      prohibited_use_attested: true,
      sanctions_cleared: true,
      upstream_tos_acknowledged: true,
    },
    { 'x-ops-key': OPS },
  );
  assert.equal(screen.status, 200, JSON.stringify(screen.json));
  assert.equal(screen.json.screening_status, 'cleared');

  const activate = await request(
    server,
    'POST',
    `/v0/orgs/${orgId}/activate`,
    {},
    { 'x-ops-key': OPS },
  );
  assert.equal(activate.status, 200, JSON.stringify(activate.json));
  assert.equal(activate.json.status, 'active');
}

test('POST /v0/orgs live still 403 screening_required (M3)', async () => {
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/v0/orgs', {
      name: 'Random Self-Serve OEM',
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'screening_required');
  });
});

test('GET /healthz reports M3', async () => {
  await withServer(async (server) => {
    const res = await request(server, 'GET', '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.json.milestone, 'M3');
  });
});

test('cannot activate without screening clearance', async () => {
  await withServer(async (server, store) => {
    const orgId = await intakePilot(server);
    const activate = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/activate`,
      {},
      { 'x-ops-key': OPS },
    );
    assert.equal(activate.status, 403);
    assert.equal(activate.json.error, 'screening_required');
    assert.equal(store.getOrg(orgId)?.status, 'pending_screening');
  });
});

test('approved pilot can activate and provision', async () => {
  await withServer(async (server, store) => {
    const orgId = await intakePilot(server, 'ICP-A Construction SI');
    await clearAndActivate(server, orgId);

    const keyRes = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/api-keys`,
      { role: 'operator', label: 'pilot-ops' },
      { 'x-ops-key': OPS },
    );
    assert.equal(keyRes.status, 201, JSON.stringify(keyRes.json));
    const apiKey = keyRes.json.api_key as string;
    assert.ok(typeof apiKey === 'string' && apiKey.length > 8);

    const device = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/devices`,
      { label: 'dozer-1' },
      { authorization: `Bearer ${apiKey}` },
    );
    assert.equal(device.status, 201, JSON.stringify(device.json));
    assert.ok(device.json.pseudo_username);
    assert.ok(device.json.pseudo_password);

    const types = store.listAudit(orgId).map((a) => a.event_type);
    assert.ok(types.includes('org.pilot_intake'));
    assert.ok(types.includes('org.screening_cleared'));
    assert.ok(types.includes('org.activated'));
  });
});

test('RBAC denies operator/read from admin-only api-key create', async () => {
  await withServer(async (server) => {
    const orgId = await intakePilot(server, 'RBAC Pilot');
    await clearAndActivate(server, orgId);

    const opKey = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/api-keys`,
      { role: 'operator', label: 'op' },
      { 'x-ops-key': OPS },
    );
    const readKey = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/api-keys`,
      { role: 'read', label: 'ro' },
      { 'x-ops-key': OPS },
    );
    assert.equal(opKey.status, 201, JSON.stringify(opKey.json));
    assert.equal(readKey.status, 201, JSON.stringify(readKey.json));

    const deniedOp = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/api-keys`,
      { role: 'read', label: 'should-fail' },
      { authorization: `Bearer ${opKey.json.api_key}` },
    );
    assert.equal(deniedOp.status, 403);
    assert.equal(deniedOp.json.error, 'forbidden');

    const deniedRead = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/api-keys`,
      { role: 'admin', label: 'should-fail' },
      { authorization: `Bearer ${readKey.json.api_key}` },
    );
    assert.equal(deniedRead.status, 403);

    const deniedActivate = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/activate`,
      {},
      { authorization: `Bearer ${opKey.json.api_key}` },
    );
    assert.equal(deniedActivate.status, 403);
  });
});

test('suspend works and blocks further use', async () => {
  await withServer(async (server, store) => {
    const orgId = await intakePilot(server, 'Suspend Me SI');
    await clearAndActivate(server, orgId);

    const sus = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/suspend`,
      { reason: 'credible_misuse_report' },
      { 'x-ops-key': OPS },
    );
    assert.equal(sus.status, 200, JSON.stringify(sus.json));
    assert.equal(sus.json.status, 'suspended');
    assert.equal(store.getOrg(orgId)?.status, 'suspended');

    const unauthDevice = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/devices`,
      { label: 'blocked' },
    );
    assert.equal(unauthDevice.status, 401);

    const keyRes = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/api-keys`,
      { role: 'operator', label: 'after-suspend' },
      { 'x-ops-key': OPS },
    );
    // ops may still mint keys; provisioning must still fail for suspended org
    assert.equal(keyRes.status, 201, JSON.stringify(keyRes.json));
    const device = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/devices`,
      { label: 'blocked' },
      { authorization: `Bearer ${keyRes.json.api_key}` },
    );
    assert.equal(device.status, 403);
    assert.equal(device.json.error, 'org_suspended');

    const reAct = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/activate`,
      {},
      { 'x-ops-key': OPS },
    );
    assert.equal(reAct.status, 403);
  });
});

test('activate rejects when attestation flags cleared after screening', async () => {
  await withServer(async (server, store) => {
    const orgId = await intakePilot(server, 'Attestation Tamper Pilot');
    const screen = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/screening`,
      {
        result: 'cleared',
        screening_reference: 'SCR-TAMPER-001',
        prohibited_use_attested: true,
        sanctions_cleared: true,
        upstream_tos_acknowledged: true,
      },
      { 'x-ops-key': OPS },
    );
    assert.equal(screen.status, 200, JSON.stringify(screen.json));

    // Simulate post-clearance flag regression while status stays cleared
    const org = store.getOrg(orgId)!;
    store.putOrg({
      ...org,
      prohibited_use_attested: false,
      sanctions_cleared: true,
      upstream_tos_acknowledged: true,
    });

    const activate = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/activate`,
      {},
      { 'x-ops-key': OPS },
    );
    assert.equal(activate.status, 403);
    assert.equal(activate.json.error, 'attestation_required');
    assert.equal(store.getOrg(orgId)?.status, 'pending_screening');
  });
});

test('unauthenticated device routes on active pilot org return 401', async () => {
  await withServer(async (server) => {
    const orgId = await intakePilot(server, 'Auth Required Pilot');
    await clearAndActivate(server, orgId);

    const listUnauth = await request(
      server,
      'GET',
      `/v0/orgs/${orgId}/devices`,
    );
    assert.equal(listUnauth.status, 401);
    assert.equal(listUnauth.json.error, 'unauthorized');

    const provisionUnauth = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/devices`,
      { label: 'no-key' },
    );
    assert.equal(provisionUnauth.status, 401);
    assert.equal(provisionUnauth.json.error, 'unauthorized');

    // Provision with key, then GET device without key → 401
    const keyRes = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/api-keys`,
      { role: 'operator', label: 'pilot-device' },
      { 'x-ops-key': OPS },
    );
    assert.equal(keyRes.status, 201, JSON.stringify(keyRes.json));
    const apiKey = keyRes.json.api_key as string;

    const provisioned = await request(
      server,
      'POST',
      `/v0/orgs/${orgId}/devices`,
      { label: 'with-key' },
      { authorization: `Bearer ${apiKey}` },
    );
    assert.equal(provisioned.status, 201, JSON.stringify(provisioned.json));
    const deviceId = (provisioned.json.device as { id: string }).id;

    const getUnauth = await request(server, 'GET', `/v0/devices/${deviceId}`);
    assert.equal(getUnauth.status, 401);
    assert.equal(getUnauth.json.error, 'unauthorized');

    const getAuth = await request(
      server,
      'GET',
      `/v0/devices/${deviceId}`,
      undefined,
      { authorization: `Bearer ${apiKey}` },
    );
    assert.equal(getAuth.status, 200);
    assert.equal(getAuth.json.id, deviceId);

    const listAuth = await request(
      server,
      'GET',
      `/v0/orgs/${orgId}/devices`,
      undefined,
      { authorization: `Bearer ${apiKey}` },
    );
    assert.equal(listAuth.status, 200);
    const devices = listAuth.json.devices as unknown[];
    assert.ok(Array.isArray(devices) && devices.length >= 1);
  });
});

test('CPOS still not registered / not routable', async () => {
  const types = listRoutableAdapters().map((a) => a.type);
  assert.ok(!types.includes('cpos_customer'));
  assert.equal(getCposStubDisabled().enabled, false);
  await withServer(async (server) => {
    const res = await request(server, 'GET', '/healthz');
    const routable = (res.json.routable_adapters ??
      res.json.routable_adapters) as string[];
    assert.ok(Array.isArray(routable));
    assert.ok(!routable.includes('cpos_customer'));
  });
});

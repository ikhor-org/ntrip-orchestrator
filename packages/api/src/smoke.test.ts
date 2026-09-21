import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import {
  FIXTURE_ORG_ID,
  generateKekHex,
  Store,
  decryptJson,
  parseKek,
  NtripBasicSecret,
} from '@grokbot/core';
import { createServer } from './server.js';
import { loadConfig } from './config.js';

const KEK = generateKekHex();

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

test('POST /v0/orgs live → 403 screening_required', async () => {
  const store = makeStore();
  const config = loadConfig({
    NODE_ENV: 'development',
    ALLOW_FIXTURE_ORGS: 'true',
    VAULT_KEK: KEK,
  });
  const server = createServer({ store, config });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const res = await request(server, 'POST', '/v0/orgs', {
      name: 'Acme Live OEM',
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'screening_required');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('GET /healthz ok M2', async () => {
  const store = makeStore();
  const config = loadConfig({
    NODE_ENV: 'development',
    ALLOW_FIXTURE_ORGS: 'true',
    VAULT_KEK: KEK,
  });
  const server = createServer({ store, config });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const res = await request(server, 'GET', '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.milestone, 'M2');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('fixture device provision returns password once and stores hash only', async () => {
  const store = makeStore();
  const config = loadConfig({
    NODE_ENV: 'development',
    ALLOW_FIXTURE_ORGS: 'true',
    VAULT_KEK: KEK,
  });
  const server = createServer({ store, config });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const res = await request(
      server,
      'POST',
      `/v0/orgs/${FIXTURE_ORG_ID}/devices`,
      { label: 'rover-1' },
    );
    assert.equal(res.status, 201);
    assert.ok(typeof res.json.pseudo_username === 'string');
    assert.ok(typeof res.json.pseudo_password === 'string');
    const device = res.json.device as { id: string };
    const cred = store.getCredentialByUsername(
      res.json.pseudo_username as string,
    );
    assert.ok(cred);
    assert.equal(cred!.device_id, device.id);
    assert.ok(cred!.password_hash.startsWith('scrypt$'));
    assert.ok(!cred!.password_hash.includes(res.json.pseudo_password as string));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('vault seed encrypts secret; decrypt round-trip', async () => {
  const store = makeStore();
  const config = loadConfig({
    NODE_ENV: 'development',
    ALLOW_FIXTURE_ORGS: 'true',
    VAULT_KEK: KEK,
  });
  const server = createServer({ store, config });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const res = await request(server, 'POST', '/v0/fixture/upstream-secret', {
      host: 'caster.example',
      port: 2101,
      mountpoint: 'NEAR',
      username: 'up-user',
      password: 'up-secret-pass',
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.last4, 'pass');
    assert.ok(!JSON.stringify(res.json).includes('up-secret-pass'));
    const upstreamId = res.json.upstream_id as string;
    const vault = store.getVaultSecret(upstreamId);
    assert.ok(vault);
    const plain = decryptJson<NtripBasicSecret>(parseKek(KEK), {
      ciphertext: vault!.ciphertext,
      nonce: vault!.nonce,
      keyVersion: vault!.key_version,
    });
    assert.equal(plain.username, 'up-user');
    assert.equal(plain.password, 'up-secret-pass');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/**
 * Concurrent mocked-session load test.
 * Provisional target (architecture O8 OPEN): 50 concurrent sessions.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { test } from 'node:test';
import {
  Device,
  encryptJson,
  FIXTURE_ORG_ID,
  generateKekHex,
  generatePseudoPassword,
  generatePseudoUsername,
  hashPassword,
  parseKek,
  PseudoCredential,
  Store,
  UpstreamEndpoint,
  VaultSecretRecord,
} from '@ntrip-orchestrator/core';
import { createProxyServer } from './server.js';
import { setUpstreamConnectOverride } from './relay.js';
import { loadProxyConfig } from './config.js';

/** Provisional small-team target — labeled OPEN in architecture O8. */
export const LOAD_TEST_CONCURRENT_TARGET = 50;

const KEK = generateKekHex();

async function seedMany(
  store: Store,
  n: number,
): Promise<Array<{ username: string; password: string }>> {
  store.seedFixtureOrg();
  const upstreamId = randomUUID();
  const upstream: UpstreamEndpoint = {
    id: upstreamId,
    org_id: FIXTURE_ORG_ID,
    adapter_type: 'ntrip_basic',
    display_name: 'load-mock',
    host: '127.0.0.1',
    port: 2101,
    use_tls: false,
    default_mountpoint: 'LOAD',
    options_json: {},
    enabled: true,
    created_at: new Date().toISOString(),
  };
  store.putUpstream(upstream);
  const blob = encryptJson(parseKek(KEK), {
    username: 'up',
    password: 'up-pass',
    mountpoint: 'LOAD',
  });
  const secret: VaultSecretRecord = {
    id: randomUUID(),
    upstream_id: upstreamId,
    secret_type: 'ntrip_basic',
    ciphertext: blob.ciphertext,
    nonce: blob.nonce,
    key_version: blob.keyVersion,
    last4: 'pass',
    created_at: new Date().toISOString(),
  };
  store.putVaultSecret(secret);
  store.setUpstreamHealth(upstreamId, FIXTURE_ORG_ID, {
    status: 'ok',
    reachable: true,
  });

  const out: Array<{ username: string; password: string }> = [];
  for (let i = 0; i < n; i++) {
    const deviceId = randomUUID();
    const username = generatePseudoUsername(`ld${i}`);
    const password = generatePseudoPassword();
    const device: Device = {
      id: deviceId,
      org_id: FIXTURE_ORG_ID,
      tags: [],
      status: 'active',
      created_at: new Date().toISOString(),
    };
    const cred: PseudoCredential = {
      id: randomUUID(),
      device_id: deviceId,
      username,
      password_hash: await hashPassword(password),
      version: 1,
      created_at: new Date().toISOString(),
    };
    store.putDevice(device, cred);
    out.push({ username, password });
  }
  return out;
}

function openSession(
  port: number,
  username: string,
  password: string,
): Promise<{ ok: boolean; sawRtcm: boolean }> {
  return new Promise((resolve) => {
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.write(
        `GET /LOAD HTTP/1.0\r\nAuthorization: Basic ${auth}\r\nUser-Agent: load\r\n\r\n`,
      );
    });
    let data = '';
    let settled = false;
    const done = (ok: boolean, sawRtcm: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ok, sawRtcm });
    };
    sock.on('data', (c) => {
      data += c.toString('utf8');
      if (data.includes('RTCMLOAD')) {
        done(data.includes('200'), true);
      }
    });
    sock.on('error', () => done(false, false));
    sock.on('end', () => done(data.includes('200'), data.includes('RTCMLOAD')));
    setTimeout(() => done(data.includes('200'), data.includes('RTCMLOAD')), 3000);
  });
}

test(`concurrent mocked sessions reach provisional target ${LOAD_TEST_CONCURRENT_TARGET}`, async () => {
  const store = new Store();
  const creds = await seedMany(store, LOAD_TEST_CONCURRENT_TARGET);

  // Hold streams open until all clients have connected
  const hold = new Map<string, () => void>();
  setUpstreamConnectOverride(async () => {
    const id = randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    hold.set(id, release);
    return {
      async writeGga() {},
      async *readRtcm() {
        yield new Uint8Array(Buffer.from('RTCMLOAD'));
        await gate;
      },
      async close() {
        hold.delete(id);
      },
      healthSample() {
        return { ok: true };
      },
    };
  });

  const config = loadProxyConfig({ PROXY_PORT: '0', VAULT_KEK: KEK });
  const server = createProxyServer({ store, config });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');

  try {
    const results = await Promise.all(
      creds.map((c) => openSession(addr.port, c.username, c.password)),
    );
    const okCount = results.filter((r) => r.ok && r.sawRtcm).length;
    assert.equal(
      okCount,
      LOAD_TEST_CONCURRENT_TARGET,
      `expected ${LOAD_TEST_CONCURRENT_TARGET} concurrent sessions, got ${okCount}`,
    );
    // Peak live sessions should have hit the target (may already be draining)
    assert.ok(
      store.auditEvents.filter((e) => e.event_type === 'session.started')
        .length >= LOAD_TEST_CONCURRENT_TARGET,
    );
  } finally {
    for (const release of hold.values()) release();
    setUpstreamConnectOverride(null);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

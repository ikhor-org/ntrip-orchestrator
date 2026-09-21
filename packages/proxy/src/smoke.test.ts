import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { test } from 'node:test';
import { getRoutableAdapter } from '@grokbot/adapters';
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
} from '@grokbot/core';
import { createProxyServer } from './server.js';
import { setUpstreamConnectOverride } from './relay.js';
import { loadProxyConfig } from './config.js';

const KEK = generateKekHex();

async function seedDevice(store: Store): Promise<{
  username: string;
  password: string;
  deviceId: string;
}> {
  store.seedFixtureOrg();
  const deviceId = randomUUID();
  const username = generatePseudoUsername('test');
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

  const upstreamId = randomUUID();
  const upstream: UpstreamEndpoint = {
    id: upstreamId,
    org_id: FIXTURE_ORG_ID,
    adapter_type: 'ntrip_basic',
    display_name: 'mock',
    host: '127.0.0.1',
    port: 2101,
    use_tls: false,
    default_mountpoint: 'TEST',
    options_json: {},
    enabled: true,
    created_at: new Date().toISOString(),
  };
  store.putUpstream(upstream);
  const blob = encryptJson(parseKek(KEK), {
    username: 'up',
    password: 'up-pass',
    mountpoint: 'TEST',
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
  return { username, password, deviceId };
}

function ntripRequest(
  port: number,
  auth: string | null,
  mount = 'TEST',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      const lines = [
        `GET /${mount} HTTP/1.0`,
        'User-Agent: test',
      ];
      if (auth) lines.push(`Authorization: Basic ${auth}`);
      lines.push('', '');
      sock.write(lines.join('\r\n'));
    });
    let data = '';
    sock.on('data', (c) => {
      data += c.toString('utf8');
    });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
    setTimeout(() => {
      sock.end();
    }, 200);
  });
}

test('CPOS not routable from proxy perspective', () => {
  assert.equal(getRoutableAdapter('cpos_customer'), undefined);
});

test('proxy rejects unauthenticated connection', async () => {
  const store = new Store();
  store.seedFixtureOrg();
  const config = loadProxyConfig({
    PROXY_PORT: '0',
    VAULT_KEK: KEK,
  });
  const server = createProxyServer({ store, config });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  try {
    const response = await ntripRequest(addr.port, null);
    assert.match(response, /401/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('proxy auth reject with bad password', async () => {
  const store = new Store();
  const { username } = await seedDevice(store);
  const config = loadProxyConfig({ PROXY_PORT: '0', VAULT_KEK: KEK });
  const server = createProxyServer({ store, config });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  try {
    const auth = Buffer.from(`${username}:wrong-password`).toString('base64');
    const response = await ntripRequest(addr.port, auth);
    assert.match(response, /401/);
    const fails = store.auditEvents.filter(
      (e) => e.event_type === 'session.auth_fail',
    );
    assert.ok(fails.length >= 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('proxy relay happy path with mocked upstream + metering has no location', async () => {
  const store = new Store();
  const { username, password, deviceId } = await seedDevice(store);
  const config = loadProxyConfig({ PROXY_PORT: '0', VAULT_KEK: KEK });

  setUpstreamConnectOverride(async () => {
    const chunks = [new Uint8Array(Buffer.from('RTCMDATA'))];
    return {
      async writeGga() {
        /* ignore */
      },
      async *readRtcm() {
        yield chunks[0]!;
      },
      async close() {
        /* ignore */
      },
      healthSample() {
        return { ok: true };
      },
    };
  });

  const server = createProxyServer({ store, config });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  try {
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const response = await new Promise<string>((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: addr.port }, () => {
        sock.write(
          `GET /TEST HTTP/1.0\r\nAuthorization: Basic ${auth}\r\nUser-Agent: test\r\n\r\n`,
        );
      });
      let data = '';
      sock.on('data', (c) => {
        data += c.toString('utf8');
        if (data.includes('RTCMDATA')) {
          sock.end();
        }
      });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
      setTimeout(() => sock.end(), 1000);
    });
    assert.match(response, /200/);
    assert.match(response, /RTCMDATA/);

    // Wait for session end metering
    await new Promise((r) => setTimeout(r, 50));

    const started = store.meteringEvents.filter(
      (e) => e.event_type === 'usage.session_started',
    );
    const ended = store.meteringEvents.filter(
      (e) => e.event_type === 'usage.session_ended',
    );
    assert.ok(started.length >= 1);
    assert.ok(ended.length >= 1);
    for (const ev of store.meteringEvents) {
      const keys = Object.keys(ev.payload_json).map((k) => k.toLowerCase());
      assert.ok(!keys.includes('lat'));
      assert.ok(!keys.includes('lon'));
      assert.ok(!keys.includes('gga'));
      assert.ok(!keys.includes('position'));
      assert.ok(!keys.includes('track'));
    }
    assert.equal(store.liveSessions.size, 0);
    assert.ok(
      store.auditEvents.some((e) => e.event_type === 'session.started'),
    );
    assert.ok(store.auditEvents.some((e) => e.event_type === 'session.ended'));
    void deviceId;
  } finally {
    setUpstreamConnectOverride(null);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

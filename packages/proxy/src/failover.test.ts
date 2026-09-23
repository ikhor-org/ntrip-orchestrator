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
  normalizePolicy,
  parseKek,
  PseudoCredential,
  Store,
  UpstreamEndpoint,
  VaultSecretRecord,
} from '@ntrip-orchestrator/core';
import { createProxyServer } from './server.js';
import { setUpstreamConnectOverride } from './relay.js';
import { loadProxyConfig } from './config.js';

const KEK = generateKekHex();

async function seedWithProfile(store: Store): Promise<{
  username: string;
  password: string;
  primaryId: string;
  secondaryId: string;
  profileId: string;
}> {
  store.seedFixtureOrg();
  const primaryId = randomUUID();
  const secondaryId = randomUUID();

  for (const [id, name, port] of [
    [primaryId, 'primary', 2101],
    [secondaryId, 'secondary', 2102],
  ] as const) {
    const upstream: UpstreamEndpoint = {
      id,
      org_id: FIXTURE_ORG_ID,
      adapter_type: 'ntrip_basic',
      display_name: name,
      host: '127.0.0.1',
      port,
      use_tls: false,
      default_mountpoint: 'TEST',
      options_json: {},
      enabled: true,
      created_at: new Date().toISOString(),
    };
    store.putUpstream(upstream);
    const blob = encryptJson(parseKek(KEK), {
      username: 'up',
      password: `pass-${name}`,
      mountpoint: 'TEST',
    });
    const secret: VaultSecretRecord = {
      id: randomUUID(),
      upstream_id: id,
      secret_type: 'ntrip_basic',
      ciphertext: blob.ciphertext,
      nonce: blob.nonce,
      key_version: blob.keyVersion,
      last4: name.slice(-4),
      created_at: new Date().toISOString(),
    };
    store.putVaultSecret(secret);
    store.setUpstreamHealth(id, FIXTURE_ORG_ID, {
      status: 'ok',
      reachable: true,
    });
  }

  const profile = store.createProfile({
    org_id: FIXTURE_ORG_ID,
    name: 'failover',
    policy_json: normalizePolicy({
      candidates: [
        { priority: 1, upstream_endpoint_id: primaryId },
        { priority: 2, upstream_endpoint_id: secondaryId },
      ],
      failover: {
        unhealthy_after_ms: 0,
        max_switches_per_hour: 10,
        on_exhaust: 'reject',
      },
    }),
  });

  const deviceId = randomUUID();
  const username = generatePseudoUsername('fo');
  const password = generatePseudoPassword();
  const device: Device = {
    id: deviceId,
    org_id: FIXTURE_ORG_ID,
    profile_id: profile.id,
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

  return {
    username,
    password,
    primaryId,
    secondaryId,
    profileId: profile.id,
  };
}

test('primary mock fails → secondary takes over (connect-time failover)', async () => {
  const store = new Store();
  const { username, password, primaryId, secondaryId } =
    await seedWithProfile(store);
  // Mark primary unreachable so policy prefers secondary — also force connect fail
  store.setUpstreamHealth(primaryId, FIXTURE_ORG_ID, {
    status: 'unreachable',
    reachable: false,
    last_error: 'demo',
  });

  const tried: string[] = [];
  setUpstreamConnectOverride(async (endpoint) => {
    tried.push(endpoint.id);
    if (endpoint.id === primaryId) {
      throw new Error('primary down');
    }
    return {
      async writeGga() {
        /* ignore */
      },
      async *readRtcm() {
        yield new Uint8Array(Buffer.from('SECONDARY-RTCM'));
      },
      async close() {
        /* ignore */
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
        if (data.includes('SECONDARY-RTCM')) sock.end();
      });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
      setTimeout(() => sock.end(), 1500);
    });

    assert.match(response, /200/);
    assert.match(response, /SECONDARY-RTCM/);
    // Primary may be skipped via health or attempted then failed
    assert.ok(tried.includes(secondaryId));
    assert.ok(
      store.auditEvents.some((e) => e.event_type === 'session.started'),
    );
    const started = store.auditEvents.find(
      (e) => e.event_type === 'session.started',
    );
    assert.equal(started?.payload_json.upstream_id, secondaryId);
  } finally {
    setUpstreamConnectOverride(null);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('connect fails on primary then succeeds on secondary with failover audit', async () => {
  const store = new Store();
  const { username, password, primaryId, secondaryId } =
    await seedWithProfile(store);
  // Both marked ok so primary is tried first
  store.setUpstreamHealth(primaryId, FIXTURE_ORG_ID, {
    status: 'ok',
    reachable: true,
  });

  let primaryAttempts = 0;
  setUpstreamConnectOverride(async (endpoint) => {
    if (endpoint.id === primaryId) {
      primaryAttempts += 1;
      throw new Error('primary refused');
    }
    return {
      async writeGga() {},
      async *readRtcm() {
        yield new Uint8Array(Buffer.from('OK'));
      },
      async close() {},
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
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const response = await new Promise<string>((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: addr.port }, () => {
        sock.write(
          `GET /TEST HTTP/1.0\r\nAuthorization: Basic ${auth}\r\n\r\n`,
        );
      });
      let data = '';
      sock.on('data', (c) => {
        data += c.toString('utf8');
        if (data.includes('OK')) sock.end();
      });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
      setTimeout(() => sock.end(), 1500);
    });
    assert.match(response, /200/);
    assert.equal(primaryAttempts, 1);
    assert.ok(
      store.auditEvents.some((e) => e.event_type === 'session.failover'),
    );
    const fo = store.auditEvents.find((e) => e.event_type === 'session.failover');
    assert.equal(fo?.payload_json.to_upstream_id, secondaryId);
  } finally {
    setUpstreamConnectOverride(null);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

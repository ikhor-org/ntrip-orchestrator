import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import {
  FIXTURE_ORG_ID,
  generateKekHex,
  METERING_FORBIDDEN_KEYS,
  Store,
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

async function withServer(
  fn: (server: http.Server, store: Store) => Promise<void>,
): Promise<void> {
  const store = makeStore();
  const config = loadConfig({
    NODE_ENV: 'development',
    ALLOW_FIXTURE_ORGS: 'true',
    VAULT_KEK: KEK,
  });
  const server = createServer({ store, config });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn(server, store);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('POST /v0/orgs live still 403 screening_required (M2)', async () => {
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/v0/orgs', {
      name: 'Acme Live OEM',
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'screening_required');
  });
});

test('GET /healthz reports M2', async () => {
  await withServer(async (server) => {
    const res = await request(server, 'GET', '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.json.milestone, 'M2');
    assert.equal(res.json.load_test_target_concurrent_sessions, 50);
  });
});

test('profile policy primary/secondary ordering via API', async () => {
  await withServer(async (server, store) => {
    const up1 = await request(server, 'POST', '/v0/fixture/upstream-secret', {
      display_name: 'primary',
      host: '127.0.0.1',
      port: 2101,
      mountpoint: 'P1',
      username: 'u1',
      password: 'pass-one',
    });
    const up2 = await request(server, 'POST', '/v0/fixture/upstream-secret', {
      display_name: 'secondary',
      host: '127.0.0.1',
      port: 2102,
      mountpoint: 'P2',
      username: 'u2',
      password: 'pass-two',
    });
    assert.equal(up1.status, 201);
    assert.equal(up2.status, 201);

    const created = await request(
      server,
      'POST',
      `/v0/orgs/${FIXTURE_ORG_ID}/profiles`,
      {
        name: 'failover-demo',
        candidates: [
          {
            priority: 2,
            upstream_endpoint_id: up2.json.upstream_id,
          },
          {
            priority: 1,
            upstream_endpoint_id: up1.json.upstream_id,
          },
        ],
        failover: {
          unhealthy_after_ms: 100,
          max_switches_per_hour: 5,
          on_exhaust: 'reject',
        },
      },
    );
    assert.equal(created.status, 201);
    const profile = created.json as {
      id: string;
      policy_json: {
        candidates: Array<{ priority: number; upstream_endpoint_id: string }>;
        failover: { unhealthy_after_ms: number };
      };
    };
    // Stored as given; engine orders by priority
    assert.equal(profile.policy_json.failover.unhealthy_after_ms, 100);
    const ordered = [...profile.policy_json.candidates].sort(
      (a, b) => a.priority - b.priority,
    );
    assert.equal(ordered[0]!.upstream_endpoint_id, up1.json.upstream_id);
    assert.equal(ordered[1]!.upstream_endpoint_id, up2.json.upstream_id);

    const got = await request(server, 'GET', `/v0/profiles/${profile.id}`);
    assert.equal(got.status, 200);

    const put = await request(server, 'PUT', `/v0/profiles/${profile.id}`, {
      candidates: [
        { priority: 1, upstream_endpoint_id: up2.json.upstream_id },
        { priority: 2, upstream_endpoint_id: up1.json.upstream_id },
      ],
      failover: {
        unhealthy_after_ms: 30_000,
        max_switches_per_hour: 10,
        on_exhaust: 'keep_last_best_effort',
      },
    });
    assert.equal(put.status, 200);
    const updated = put.json as {
      policy_json: { candidates: Array<{ priority: number }> };
    };
    assert.equal(updated.policy_json.candidates[0]!.priority, 1);
    void store;
  });
});

test('health endpoints for upstreams + devices', async () => {
  await withServer(async (server, store) => {
    const up = await request(server, 'POST', '/v0/fixture/upstream-secret', {
      host: '127.0.0.1',
      port: 2101,
      mountpoint: 'T',
      username: 'u',
      password: 'secretxx',
    });
    const upstreamId = up.json.upstream_id as string;

    const mark = await request(server, 'POST', '/v0/fixture/upstream-health', {
      upstream_id: upstreamId,
      status: 'ok',
      reachable: true,
    });
    assert.equal(mark.status, 200);

    const uh = await request(
      server,
      'GET',
      `/v0/upstreams/${upstreamId}/health`,
    );
    assert.equal(uh.status, 200);
    assert.equal(
      (uh.json.health as { status: string }).status,
      'ok',
    );

    const dev = await request(
      server,
      'POST',
      `/v0/orgs/${FIXTURE_ORG_ID}/devices`,
      { label: 'health-rover' },
    );
    const deviceId = (dev.json.device as { id: string }).id;

    store.startLiveSession({
      session_id: '11111111-1111-4111-8111-111111111111',
      device_id: deviceId,
      org_id: FIXTURE_ORG_ID,
      upstream_id: upstreamId,
      started_at: new Date().toISOString(),
      bytes_up: 10,
      bytes_down: 20,
      failover_count: 0,
      last_gga_at: new Date().toISOString(),
      last_position: { lat: 59.9, lon: 10.7 },
      upstream_ok: true,
    });

    const dh = await request(server, 'GET', `/v0/devices/${deviceId}/health`);
    assert.equal(dh.status, 200);
    const session = dh.json.session as {
      has_last_position: boolean;
      last_gga_age_ms: number | null;
    };
    assert.equal(session.has_last_position, true);
    assert.ok(typeof session.last_gga_age_ms === 'number');

    const oh = await request(
      server,
      'GET',
      `/v0/orgs/${FIXTURE_ORG_ID}/health`,
    );
    assert.equal(oh.status, 200);
    assert.equal(oh.json.active_sessions, 1);

    const sess = await request(
      server,
      'GET',
      `/v0/orgs/${FIXTURE_ORG_ID}/sessions`,
    );
    assert.equal(sess.status, 200);
    assert.equal((sess.json.sessions as unknown[]).length, 1);

    // Drop ephemeral on end — no track history
    store.endLiveSession('11111111-1111-4111-8111-111111111111');
    const dh2 = await request(server, 'GET', `/v0/devices/${deviceId}/health`);
    assert.equal(dh2.json.session, null);
  });
});

test('audit query filters by event_type / device / time', async () => {
  await withServer(async (server, store) => {
    const now = Date.now();
    store.appendAudit({
      org_id: FIXTURE_ORG_ID,
      actor_type: 'api',
      event_type: 'device.provisioned',
      resource_type: 'device',
      resource_id: 'dev-a',
      payload_json: { device_id: 'dev-a' },
      ts: new Date(now - 60_000).toISOString(),
    });
    store.appendAudit({
      org_id: FIXTURE_ORG_ID,
      actor_type: 'device',
      actor_id: 'dev-b',
      event_type: 'session.failover',
      resource_type: 'session',
      resource_id: 'sess-1',
      payload_json: { device_id: 'dev-b' },
      ts: new Date(now).toISOString(),
    });
    store.appendAudit({
      org_id: FIXTURE_ORG_ID,
      actor_type: 'api',
      event_type: 'vault.secret.created',
      payload_json: {},
      ts: new Date(now - 120_000).toISOString(),
    });

    const byType = await request(
      server,
      'GET',
      `/v0/orgs/${FIXTURE_ORG_ID}/audit?event_type=session.failover`,
    );
    assert.equal(byType.status, 200);
    const typeEvents = byType.json.events as Array<{ event_type: string }>;
    assert.ok(typeEvents.length >= 1);
    assert.ok(typeEvents.every((e) => e.event_type === 'session.failover'));

    const byDevice = await request(
      server,
      'GET',
      `/v0/orgs/${FIXTURE_ORG_ID}/audit?device_id=dev-a`,
    );
    assert.equal(byDevice.status, 200);
    const devEvents = byDevice.json.events as unknown[];
    assert.ok(devEvents.length >= 1);

    const from = encodeURIComponent(new Date(now - 30_000).toISOString());
    const byTime = await request(
      server,
      'GET',
      `/v0/orgs/${FIXTURE_ORG_ID}/audit?from=${from}`,
    );
    assert.equal(byTime.status, 200);
    const timeEvents = byTime.json.events as Array<{ event_type: string }>;
    assert.ok(timeEvents.some((e) => e.event_type === 'session.failover'));
    assert.ok(!timeEvents.some((e) => e.event_type === 'vault.secret.created'));
  });
});

test('usage export shape has no location fields; webhook signs', async () => {
  await withServer(async (server, store) => {
    store.appendMetering({
      org_id: FIXTURE_ORG_ID,
      device_id: 'dev-1',
      session_id: 'sess-1',
      event_type: 'usage.session_started',
      payload_json: {
        org_id: FIXTURE_ORG_ID,
        device_id: 'dev-1',
        session_id: 'sess-1',
        upstream_id: 'up-1',
        ts: new Date().toISOString(),
      },
    });
    store.appendMetering({
      org_id: FIXTURE_ORG_ID,
      device_id: 'dev-1',
      session_id: 'sess-1',
      event_type: 'usage.session_ended',
      payload_json: {
        session_id: 'sess-1',
        duration_ms: 1000,
        bytes_up: 10,
        bytes_down: 200,
        end_reason: 'client_close',
      },
    });

    const hook = await request(
      server,
      'POST',
      `/v0/orgs/${FIXTURE_ORG_ID}/usage/webhooks`,
      { url: 'https://billing.example/hooks/usage' },
    );
    assert.equal(hook.status, 201);
    assert.ok(typeof hook.json.secret === 'string');
    assert.ok(!JSON.stringify(hook.json).match(/"lat"|"lon"|"gga"|"track"/i));

    const exp = await request(
      server,
      'GET',
      `/v0/orgs/${FIXTURE_ORG_ID}/usage/export?webhook_id=${hook.json.id}`,
    );
    assert.equal(exp.status, 200);
    assert.equal(exp.json.location_fields, 'forbidden');
    assert.ok(typeof exp.json.signature === 'string');
    assert.ok((exp.json.event_count as number) >= 2);

    const blob = JSON.stringify(exp.json);
    for (const k of METERING_FORBIDDEN_KEYS) {
      // Allow the documentation string "forbidden" / notes; forbid payload keys
      assert.ok(
        !blob.includes(`"${k}":`),
        `export must not contain location key ${k}`,
      );
    }

    const events = await request(
      server,
      'GET',
      `/v0/orgs/${FIXTURE_ORG_ID}/usage/events`,
    );
    assert.equal(events.status, 200);
    for (const ev of events.json.events as Array<{
      payload_json: Record<string, unknown>;
    }>) {
      for (const k of Object.keys(ev.payload_json)) {
        assert.ok(
          !(METERING_FORBIDDEN_KEYS as readonly string[]).includes(
            k.toLowerCase(),
          ),
        );
      }
    }
  });
});

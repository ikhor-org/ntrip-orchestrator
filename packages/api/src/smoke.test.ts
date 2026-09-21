import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createServer } from './server.js';
import { seedFixtureOrg } from './orgs.js';

seedFixtureOrg();

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
  const server = createServer();
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

test('GET /healthz ok', async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const res = await request(server, 'GET', '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

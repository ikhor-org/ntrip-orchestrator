import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { getRoutableAdapter } from '@grokbot/adapters';
import { createProxyServer } from './server.js';

test('CPOS not routable from proxy perspective', () => {
  assert.equal(getRoutableAdapter('cpos_customer'), undefined);
});

test('proxy rejects unauthenticated connection', async () => {
  const server = createProxyServer({ port: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: addr.port }, () => {
        sock.write('GET / HTTP/1.0\r\n\r\n');
      });
      let data = '';
      sock.on('data', (c) => {
        data += c.toString('utf8');
      });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    assert.match(response, /401/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

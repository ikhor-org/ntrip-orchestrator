import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import {
  AdapterConnectError,
  cposAdapter,
  getCposStubDisabled,
  getRoutableAdapter,
  isCposRoutingAllowed,
  listRoutableAdapters,
  ntripBasicAdapter,
  setNtripTcpConnect,
} from './index.js';

test('routable adapters exclude CPOS', () => {
  const types = listRoutableAdapters().map((a) => a.type);
  assert.ok(types.includes('ntrip_basic'));
  assert.ok(!types.includes('cpos_customer'));
  assert.equal(getRoutableAdapter('cpos_customer'), undefined);
});

test('CPOS stub is disabled and not routing-allowed by default', () => {
  assert.equal(cposAdapter.enabled, false);
  assert.equal(getCposStubDisabled().enabled, false);
  assert.equal(isCposRoutingAllowed(), false);
});

test('ntrip_basic happy path with mocked upstream', async () => {
  const mock = await startMockCaster('ICY 200 OK\r\nServer: mock\r\n\r\nRTCM');
  setNtripTcpConnect(async () => mock.acceptClient());
  try {
    const session = await ntripBasicAdapter.connect(
      {},
      {
        id: 'u1',
        adapterType: 'ntrip_basic',
        host: '127.0.0.1',
        port: mock.port,
        useTls: false,
        defaultMountpoint: 'TEST',
      },
      {
        secretType: 'ntrip_basic',
        ntripBasic: { username: 'u', password: 'p' },
      },
      { mountpoint: 'TEST' },
    );
    assert.equal(session.healthSample().ok, true);
    const iter = session.readRtcm()[Symbol.asyncIterator]();
    const first = await iter.next();
    assert.equal(first.done, false);
    assert.ok(Buffer.from(first.value!).toString('utf8').includes('RTCM'));
    await session.close();
  } finally {
    setNtripTcpConnect(null);
    await mock.close();
  }
});

test('ntrip_basic auth_failed on 401', async () => {
  const mock = await startMockCaster('HTTP/1.0 401 Unauthorized\r\n\r\n');
  setNtripTcpConnect(async () => mock.acceptClient());
  try {
    await assert.rejects(
      () =>
        ntripBasicAdapter.connect(
          {},
          {
            id: 'u1',
            adapterType: 'ntrip_basic',
            host: '127.0.0.1',
            port: mock.port,
            useTls: false,
            defaultMountpoint: 'TEST',
          },
          {
            secretType: 'ntrip_basic',
            ntripBasic: { username: 'u', password: 'bad' },
          },
          { mountpoint: 'TEST' },
        ),
      (err: unknown) =>
        err instanceof AdapterConnectError && err.code === 'auth_failed',
    );
  } finally {
    setNtripTcpConnect(null);
    await mock.close();
  }
});

interface MockCaster {
  port: number;
  acceptClient(): Promise<net.Socket>;
  close(): Promise<void>;
}

async function startMockCaster(response: string): Promise<MockCaster> {
  const server = net.createServer();
  server.on('connection', (sock) => {
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      if (buf.includes('\r\n\r\n')) {
        sock.write(response);
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');

  return {
    port: addr.port,
    acceptClient() {
      return new Promise((resolve, reject) => {
        const client = net.connect({ host: '127.0.0.1', port: addr.port });
        client.once('error', reject);
        client.once('connect', () => resolve(client));
      });
    },
    close() {
      return new Promise((r) => server.close(() => r()));
    },
  };
}

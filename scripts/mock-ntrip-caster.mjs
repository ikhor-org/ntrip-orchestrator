#!/usr/bin/env node
/**
 * Minimal NTRIP-ish TCP caster for Ops smoke (no vendor creds).
 *
 * Speaks enough of NTRIP over TCP:
 *   - Accepts GET /<mount> with Authorization: Basic ...
 *   - Replies ICY 200 OK (or 401 if MOCK_CASTER_USER/PASS set and mismatch)
 *   - Streams fixed RTCM-ish bytes on an interval
 *
 * Env:
 *   MOCK_CASTER_PORT      default 2102 (avoid colliding with grokbot proxy :2101)
 *   MOCK_CASTER_HOST      default 0.0.0.0
 *   MOCK_CASTER_MOUNT     default MOCK
 *   MOCK_CASTER_USER      optional; if set with PASS, enforce Basic auth
 *   MOCK_CASTER_PASS      optional
 *   MOCK_CASTER_INTERVAL_MS  default 500
 *
 * Usage:
 *   node scripts/mock-ntrip-caster.mjs
 *   docker compose --profile mock-caster up -d mock-caster
 */

import net from 'node:net';

const PORT = Number(process.env.MOCK_CASTER_PORT ?? 2102);
const HOST = process.env.MOCK_CASTER_HOST ?? '0.0.0.0';
const MOUNT = process.env.MOCK_CASTER_MOUNT ?? 'MOCK';
const USER = process.env.MOCK_CASTER_USER ?? '';
const PASS = process.env.MOCK_CASTER_PASS ?? '';
const INTERVAL_MS = Number(process.env.MOCK_CASTER_INTERVAL_MS ?? 500);

/** Fixed faux RTCM-ish payload (not a real message — enough for relay smoke). */
const MOCK_CHUNK = Buffer.from([
  0xd3, 0x00, 0x13, 0x3e, 0xd0, 0x00, 0x02, 0x8b,
  0x0e, 0xde, 0xef, 0x34, 0xb4, 0xbd, 0x62, 0xac,
  0x09, 0x41, 0x98, 0x6f, 0x33, 0x36, 0x0b, 0x98,
]);

function parseBasic(authHeader) {
  if (!authHeader || !authHeader.toLowerCase().startsWith('basic ')) return null;
  try {
    const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) return null;
    return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

function authOk(headers) {
  if (!USER && !PASS) return true;
  const creds = parseBasic(headers.authorization);
  if (!creds) return false;
  return creds.user === USER && creds.pass === PASS;
}

const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let streaming = false;
  let timer;

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  sock.on('data', (chunk) => {
    if (streaming) return;
    buf = Buffer.concat([buf, chunk]);
    const text = buf.toString('utf8');
    if (!text.includes('\r\n\r\n')) return;

    const [head] = text.split('\r\n\r\n');
    const lines = head.split('\r\n');
    const reqLine = lines[0] ?? '';
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const c = line.indexOf(':');
      if (c > 0) {
        headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
      }
    }

    const m = reqLine.match(/^GET\s+(\S+)/i);
    const path = m?.[1] ?? '';
    const mount = path.replace(/^\//, '').split('?')[0] || '';

    if (mount && mount !== MOUNT && mount.toUpperCase() !== MOUNT.toUpperCase()) {
      sock.write('HTTP/1.0 404 Not Found\r\n\r\n');
      sock.end();
      return;
    }

    if (!authOk(headers)) {
      sock.write(
        'HTTP/1.0 401 Unauthorized\r\nWWW-Authenticate: Basic realm="mock-ntrip"\r\n\r\n',
      );
      sock.end();
      return;
    }

    sock.write('ICY 200 OK\r\nServer: grokbot-mock-ntrip-caster\r\nContent-Type: gnss/data\r\n\r\n');
    streaming = true;
    sock.write(MOCK_CHUNK);
    timer = setInterval(() => {
      if (sock.destroyed) {
        stop();
        return;
      }
      try {
        sock.write(MOCK_CHUNK);
      } catch {
        stop();
      }
    }, INTERVAL_MS);
  });

  sock.on('error', stop);
  sock.on('close', stop);
});

server.listen(PORT, HOST, () => {
  console.log(
    `[mock-ntrip-caster] listening on ${HOST}:${PORT} mount=/${MOUNT}` +
      (USER ? ' (basic auth required)' : ' (auth open)'),
  );
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

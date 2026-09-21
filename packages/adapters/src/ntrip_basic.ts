import net from 'node:net';
import tls from 'node:tls';
import {
  Adapter,
  AdapterConnectError,
  SecretMaterial,
  SessionHints,
  UpstreamEndpoint,
  UpstreamSession,
} from './types.js';

export type TcpConnectFn = (opts: {
  host: string;
  port: number;
  useTls: boolean;
  signal?: AbortSignal;
}) => Promise<net.Socket>;

let tcpConnectImpl: TcpConnectFn = defaultTcpConnect;

/** Test hook: inject a mock upstream TCP connect. */
export function setNtripTcpConnect(fn: TcpConnectFn | null): void {
  tcpConnectImpl = fn ?? defaultTcpConnect;
}

async function defaultTcpConnect(opts: {
  host: string;
  port: number;
  useTls: boolean;
  signal?: AbortSignal;
}): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const onErr = (err: Error) => reject(err);
    const sock = opts.useTls
      ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host })
      : net.connect({ host: opts.host, port: opts.port });
    const onAbort = () => {
      sock.destroy();
      reject(new AdapterConnectError('unreachable', 'aborted'));
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    sock.once('connect', () => {
      sock.off('error', onErr);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolve(sock);
    });
    sock.once('error', onErr);
  });
}

function buildAuthHeader(username: string, password: string): string {
  return (
    'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
  );
}

class NtripUpstreamSession implements UpstreamSession {
  private closed = false;
  private ok = true;
  private note = 'connected';
  private readonly pending: Buffer[] = [];

  constructor(
    private readonly socket: net.Socket,
    initialBody?: Buffer,
  ) {
    if (initialBody && initialBody.length > 0) {
      this.pending.push(initialBody);
    }
    socket.on('error', () => {
      this.ok = false;
      this.note = 'socket_error';
    });
    socket.on('close', () => {
      this.closed = true;
      this.ok = false;
      this.note = 'closed';
    });
  }

  async writeGga(nmea: string): Promise<void> {
    if (this.closed) return;
    const line = nmea.endsWith('\r\n') ? nmea : `${nmea}\r\n`;
    this.socket.write(line);
  }

  async *readRtcm(): AsyncIterable<Uint8Array> {
    const socket = this.socket;
    const queue: Buffer[] = [...this.pending];
    this.pending.length = 0;
    let done = false;
    let wake: (() => void) | undefined;
    const onData = (c: Buffer) => {
      queue.push(c);
      wake?.();
    };
    const onEnd = () => {
      done = true;
      wake?.();
    };
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            wake = r;
          });
          wake = undefined;
          continue;
        }
        const chunk = queue.shift()!;
        yield new Uint8Array(chunk);
      }
    } finally {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }

  healthSample(): { ok: boolean; note?: string } {
    return { ok: this.ok && !this.closed, note: this.note };
  }
}

/**
 * Generic NTRIP Basic Auth — v0 ship path (architecture §6.2). REAL in M1.
 */
export const ntripBasicAdapter: Adapter = {
  type: 'ntrip_basic',
  enabled: true,
  async connect(
    ctx,
    endpoint: UpstreamEndpoint,
    secret: SecretMaterial,
    hints: SessionHints,
  ): Promise<UpstreamSession> {
    if (secret.secretType !== 'ntrip_basic' || !secret.ntripBasic) {
      throw new AdapterConnectError(
        'bad_secret',
        'ntrip_basic requires ntripBasic username/password',
      );
    }
    const creds = secret.ntripBasic;
    const host = creds.host ?? endpoint.host;
    const port = creds.port ?? endpoint.port;
    const mount =
      hints.mountpoint ??
      creds.mountpoint ??
      endpoint.defaultMountpoint ??
      '';
    if (!mount || mount === '/') {
      throw new AdapterConnectError(
        'rejected',
        'mountpoint required for ntrip_basic connect',
      );
    }
    const mountPath = mount.startsWith('/') ? mount : `/${mount}`;

    let socket: net.Socket;
    try {
      socket = await tcpConnectImpl({
        host,
        port,
        useTls: endpoint.useTls,
        signal: ctx.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'connect failed';
      throw new AdapterConnectError('unreachable', msg);
    }

    const ua = hints.userAgent ?? 'grokbot-ntrip-basic/0.1';
    const req =
      `GET ${mountPath} HTTP/1.0\r\n` +
      `User-Agent: ${ua}\r\n` +
      `Authorization: ${buildAuthHeader(creds.username, creds.password)}\r\n` +
      `Ntrip-Version: Ntrip/1.0\r\n` +
      `Connection: close\r\n` +
      `\r\n`;
    socket.write(req);
    if (hints.gga) {
      const gga = hints.gga.endsWith('\r\n') ? hints.gga : `${hints.gga}\r\n`;
      socket.write(gga);
    }

    const { headerText, body } = await readHeaders(socket, 8000);
    const statusLine = headerText.split('\r\n')[0] ?? '';
    if (/ 401 | 403 /.test(statusLine) || /Unauthorized/i.test(statusLine)) {
      socket.destroy();
      throw new AdapterConnectError('auth_failed', statusLine);
    }
    if (!/200/.test(statusLine)) {
      socket.destroy();
      throw new AdapterConnectError('rejected', statusLine || 'no status');
    }

    return new NtripUpstreamSession(socket, body);
  },
};

function readHeaders(
  socket: net.Socket,
  timeoutMs: number,
): Promise<{ headerText: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const marker = Buffer.from('\r\n\r\n');
    const timer = setTimeout(() => {
      cleanup();
      reject(new AdapterConnectError('stalled', 'upstream header timeout'));
    }, timeoutMs);
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const idx = buf.indexOf(marker);
      if (idx >= 0) {
        cleanup();
        const headerText = buf.subarray(0, idx).toString('utf8');
        const body = buf.subarray(idx + marker.length);
        resolve({ headerText, body });
      }
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onEnd = () => {
      cleanup();
      reject(new AdapterConnectError('unreachable', 'upstream closed early'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onErr);
      socket.off('end', onEnd);
    };
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('end', onEnd);
  });
}

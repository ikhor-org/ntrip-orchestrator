import net from 'node:net';
import { getRoutableAdapter, listRoutableAdapters } from '@grokbot/adapters';
import { authenticatePseudo, parseBasicAuth } from './auth.js';
import { ProxySession } from './session.js';

export interface ProxyConfig {
  port: number;
}

/**
 * Minimal NTRIP-ish listen loop for M0.
 * Accepts TCP, parses a simple GET + Authorization for skeleton compile/run.
 * Does NOT open real upstream connections in M0.
 */
export function createProxyServer(_config: ProxyConfig): net.Server {
  // Ensure CPOS is not routable
  if (getRoutableAdapter('cpos_customer')) {
    throw new Error('CPOS must not be registered for routing');
  }

  return net.createServer((socket) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (!buf.includes('\r\n\r\n')) return;
      socket.off('data', onData);

      const lines = buf.split('\r\n');
      const requestLine = lines[0] ?? '';
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        if (!line) break;
        const i = line.indexOf(':');
        if (i > 0) {
          headers[line.slice(0, i).trim().toLowerCase()] = line
            .slice(i + 1)
            .trim();
        }
      }

      const auth = parseBasicAuth(headers['authorization']);
      if (!auth) {
        socket.write(
          'HTTP/1.0 401 Unauthorized\r\nWWW-Authenticate: Basic realm="grokbot"\r\n\r\n',
        );
        socket.end();
        return;
      }

      const identity = authenticatePseudo(auth.user, auth.pass);
      if (!identity) {
        socket.write('HTTP/1.0 401 Unauthorized\r\n\r\n');
        socket.end();
        return;
      }

      const session: ProxySession = {
        deviceId: identity.deviceId,
        orgId: identity.orgId,
        pseudoUser: identity.username,
        state: 'connecting',
        bytesIn: 0,
        bytesOut: 0,
        startedAt: new Date(),
      };

      // M0: no real upstream; acknowledge and close with informative body.
      const adapters = listRoutableAdapters()
        .map((a) => a.type)
        .join(',');
      const body =
        `SOURCETABLE 200 OK\r\n` +
        `Server: grokbot-proxy-m0\r\n` +
        `Connection: close\r\n\r\n` +
        `M0 skeleton — no upstream relay yet. device=${session.deviceId} ` +
        `request=${requestLine} routable=${adapters}\r\n` +
        `ENDSOURCETABLE\r\n`;
      session.state = 'closed';
      socket.write(body);
      socket.end();
    };

    socket.on('data', onData);
    socket.on('error', () => {
      socket.destroy();
    });
  });
}

export function listenProxy(config: ProxyConfig): net.Server {
  const server = createProxyServer(config);
  server.listen(config.port);
  return server;
}

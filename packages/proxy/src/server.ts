import net from 'node:net';
import { getRoutableAdapter } from '@ntrip-orchestrator/adapters';
import { getDefaultStore, setDefaultStore, Store } from '@ntrip-orchestrator/core';
import { authenticatePseudo, parseBasicAuth } from './auth.js';
import { loadProxyConfig, ProxyRuntimeConfig } from './config.js';
import { handleAuthenticatedSession } from './relay.js';

export interface ProxyServerOptions {
  config?: ProxyRuntimeConfig;
  store?: Store;
}

/**
 * NTRIP listen loop — authenticates pseudo-creds, relays via generic NTRIP Basic Auth.
 */
export function createProxyServer(opts: ProxyServerOptions = {}): net.Server {
  if (getRoutableAdapter('cpos_customer')) {
    throw new Error('CPOS must not be registered for routing');
  }

  const config = opts.config ?? loadProxyConfig();
  const store = opts.store ?? getDefaultStore();
  if (opts.store) setDefaultStore(opts.store);

  return net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const text = buf.toString('utf8');
      if (!text.includes('\r\n\r\n')) return;
      socket.off('data', onData);

      const headerEnd = buf.indexOf('\r\n\r\n');
      const headerBuf = buf.subarray(0, headerEnd);
      const leftover = buf.subarray(headerEnd + 4);
      const headerText = headerBuf.toString('utf8');
      const lines = headerText.split('\r\n');
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

      void (async () => {
        const auth = parseBasicAuth(headers['authorization']);
        if (!auth) {
          store.appendAudit({
            actor_type: 'device',
            event_type: 'session.auth_fail',
            payload_json: { reason: 'missing_auth' },
          });
          await store.persist();
          socket.write(
            'HTTP/1.0 401 Unauthorized\r\nWWW-Authenticate: Basic realm="ntrip-orchestrator"\r\n\r\n',
          );
          socket.end();
          return;
        }

        const identity = await authenticatePseudo(
          store,
          auth.user,
          auth.pass,
        );
        if (!identity) {
          store.appendAudit({
            actor_type: 'device',
            event_type: 'session.auth_fail',
            payload_json: { reason: 'bad_credentials', username: auth.user },
          });
          await store.persist();
          socket.write('HTTP/1.0 401 Unauthorized\r\n\r\n');
          socket.end();
          return;
        }

        await handleAuthenticatedSession({
          socket,
          store,
          config,
          identity,
          requestLine,
          leftover,
        });
      })().catch(() => {
        if (!socket.destroyed) {
          socket.destroy();
        }
      });
    };

    socket.on('data', onData);
    socket.on('error', () => {
      socket.destroy();
    });
  });
}

export function listenProxy(
  config: ProxyRuntimeConfig | { port: number },
  store?: Store,
): net.Server {
  const full =
    'ntripUpstreamPort' in config
      ? (config as ProxyRuntimeConfig)
      : { ...loadProxyConfig(), port: config.port };
  const server = createProxyServer({ config: full, store });
  server.listen(full.port);
  return server;
}

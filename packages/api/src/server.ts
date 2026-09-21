import http from 'node:http';
import { listRoutableAdapters } from '@grokbot/adapters';
import {
  FIXTURE_ORG_ID,
  getDefaultStore,
  parseKek,
  setDefaultStore,
  Store,
} from '@grokbot/core';
import { ApiConfig, loadConfig } from './config.js';
import { provisionDevice } from './devices.js';
import { createOrg, getOrg, seedFixtureOrg } from './orgs.js';
import { seedFixtureUpstreamSecret } from './vault_admin.js';

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function match(
  method: string,
  url: string,
  wantMethod: string,
  pattern: RegExp,
): RegExpMatchArray | null {
  if (method !== wantMethod) return null;
  return url.split('?')[0]?.match(pattern) ?? null;
}

export interface CreateServerOptions {
  store?: Store;
  config?: ApiConfig;
}

export function createServer(opts: CreateServerOptions = {}): http.Server {
  const config = opts.config ?? loadConfig();
  const store = opts.store ?? getDefaultStore();
  if (opts.store) setDefaultStore(opts.store);
  seedFixtureOrg(store);

  return http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    try {
      if (match(method, url, 'GET', /^\/healthz$/)) {
        sendJson(res, 200, {
          ok: true,
          service: 'grokbot-api',
          milestone: 'M1',
          routable_adapters: listRoutableAdapters().map((a) => a.type),
          fixture_org_id: FIXTURE_ORG_ID,
        });
        return;
      }

      if (match(method, url, 'POST', /^\/v0\/orgs$/)) {
        const raw = (await readJson(req)) as {
          name?: string;
          fixture?: boolean;
        };
        const allowHeader = req.headers['x-allow-fixture-orgs'] === 'true';
        const result = createOrg(store, config, raw, allowHeader);
        if (result.status === 201) await store.persist();
        sendJson(res, result.status, result.body);
        return;
      }

      const orgGet = match(method, url, 'GET', /^\/v0\/orgs\/([^/]+)$/);
      if (orgGet) {
        const org = getOrg(store, orgGet[1]!);
        if (!org) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'org not found',
          });
          return;
        }
        sendJson(res, 200, org);
        return;
      }

      const devicesList = match(
        method,
        url,
        'GET',
        /^\/v0\/orgs\/([^/]+)\/devices$/,
      );
      if (devicesList) {
        const org = getOrg(store, devicesList[1]!);
        if (!org) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'org not found',
          });
          return;
        }
        sendJson(res, 200, { devices: store.listDevices(org.id) });
        return;
      }

      const devicesPost = match(
        method,
        url,
        'POST',
        /^\/v0\/orgs\/([^/]+)\/devices$/,
      );
      if (devicesPost) {
        const raw = (await readJson(req)) as {
          label?: string;
          profile_id?: string;
        };
        const result = await provisionDevice(
          store,
          config,
          devicesPost[1]!,
          raw,
        );
        sendJson(res, result.status, result.body);
        return;
      }

      const deviceGet = match(
        method,
        url,
        'GET',
        /^\/v0\/devices\/([^/]+)$/,
      );
      if (deviceGet) {
        const device = store.getDevice(deviceGet[1]!);
        if (!device) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'device not found',
          });
          return;
        }
        sendJson(res, 200, device);
        return;
      }

      // Seed fixture upstream + vault secret (admin/dev)
      if (match(method, url, 'POST', /^\/v0\/fixture\/upstream-secret$/)) {
        const raw = (await readJson(req)) as {
          display_name?: string;
          host?: string;
          port?: number;
          use_tls?: boolean;
          mountpoint?: string;
          username?: string;
          password?: string;
        };
        const result = seedFixtureUpstreamSecret(store, config, {
          display_name: raw.display_name,
          host: raw.host ?? '',
          port: raw.port,
          use_tls: raw.use_tls,
          mountpoint: raw.mountpoint,
          username: raw.username ?? '',
          password: raw.password ?? '',
        });
        if (result.status === 201) await store.persist();
        sendJson(res, result.status, result.body);
        return;
      }

      const vaultList = match(
        method,
        url,
        'GET',
        /^\/v0\/orgs\/([^/]+)\/upstreams$/,
      );
      if (vaultList) {
        const org = getOrg(store, vaultList[1]!);
        if (!org) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'org not found',
          });
          return;
        }
        const upstreams = store.listUpstreams(org.id).map((u) => {
          const sec = store.getVaultSecret(u.id);
          return {
            id: u.id,
            adapter_type: u.adapter_type,
            display_name: u.display_name,
            host: u.host,
            port: u.port,
            use_tls: u.use_tls,
            default_mountpoint: u.default_mountpoint,
            enabled: u.enabled,
            secret: sec
              ? {
                  id: sec.id,
                  secret_type: sec.secret_type,
                  last4: sec.last4,
                  key_version: sec.key_version,
                }
              : null,
          };
        });
        sendJson(res, 200, { upstreams });
        return;
      }

      const health = match(
        method,
        url,
        'GET',
        /^\/v0\/orgs\/([^/]+)\/health$/,
      );
      if (health) {
        const orgId = health[1]!;
        const sessions = store.liveSessionsForOrg(orgId).map((s) => ({
          session_id: s.session_id,
          device_id: s.device_id,
          upstream_id: s.upstream_id,
          started_at: s.started_at,
          last_gga_age_ms: s.last_gga_at
            ? Date.now() - Date.parse(s.last_gga_at)
            : null,
          // Ephemeral last_position exposed for live health only — not metering
          has_last_position: Boolean(s.last_position),
        }));
        sendJson(res, 200, {
          org_id: orgId,
          active_sessions: sessions.length,
          sessions,
          notes:
            'GGA/last-position for session health only — no track histories; metering = connect/bytes/device-days only',
        });
        return;
      }

      const auditGet = match(
        method,
        url,
        'GET',
        /^\/v0\/orgs\/([^/]+)\/audit$/,
      );
      if (auditGet) {
        const org = getOrg(store, auditGet[1]!);
        if (!org) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'org not found',
          });
          return;
        }
        sendJson(res, 200, { events: store.listAudit(org.id) });
        return;
      }

      const usageGet = match(
        method,
        url,
        'GET',
        /^\/v0\/orgs\/([^/]+)\/usage\/events$/,
      );
      if (usageGet) {
        const org = getOrg(store, usageGet[1]!);
        if (!org) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'org not found',
          });
          return;
        }
        sendJson(res, 200, { events: store.listMetering(org.id) });
        return;
      }

      // Dev helper: confirm vault KEK parses (never echoes key)
      if (match(method, url, 'GET', /^\/v0\/fixture\/vault-status$/)) {
        let kek_ok = false;
        if (config.vaultKekRaw) {
          try {
            parseKek(config.vaultKekRaw);
            kek_ok = true;
          } catch {
            kek_ok = false;
          }
        }
        sendJson(res, 200, {
          kek_configured: Boolean(config.vaultKekRaw),
          kek_ok,
          store_path: config.storePath ?? null,
        });
        return;
      }

      sendJson(res, 404, { error: 'not_found', message: 'route not found' });
    } catch (err) {
      if (err instanceof Error && err.message === 'invalid_json') {
        sendJson(res, 400, {
          error: 'invalid_request',
          message: 'body must be JSON',
        });
        return;
      }
      sendJson(res, 500, {
        error: 'internal_error',
        message: err instanceof Error ? err.message : 'unexpected error',
      });
    }
  });
}

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
import {
  deviceHealth,
  listActiveSessions,
  orgHealth,
  upstreamHealth,
} from './health.js';
import {
  activateOrg,
  createOrg,
  createPilotOrg,
  getOrg,
  recordScreening,
  seedFixtureOrg,
  suspendOrg,
} from './orgs.js';
import {
  createOrgApiKey,
  publicApiKeyView,
  requireOps,
  requireRole,
  resolveAuth,
  resolveOrgScopedAuth,
} from './auth.js';
import {
  createProfile,
  getProfile,
  listProfiles,
  putProfile,
} from './profiles.js';
import {
  exportUsage,
  queryAudit,
  queryUsageEvents,
  registerUsageWebhook,
} from './usage.js';
import {
  seedFixtureUpstreamSecret,
  seedOpsUpstreamSecret,
} from './vault_admin.js';

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
          milestone: 'M3',
          routable_adapters: listRoutableAdapters().map((a) => a.type),
          fixture_org_id: FIXTURE_ORG_ID,
          load_test_target_concurrent_sessions: 50,
          load_test_target_label: 'provisional (architecture O8 OPEN)',
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

      // --- M3: ops pilot intake (no self-serve) ---
      if (match(method, url, 'POST', /^\/v0\/ops\/pilot-orgs$/)) {
        const auth = await resolveAuth(store, req.headers, {
          opsApiKey: config.opsApiKey,
          requireAuth: true,
        });
        if (!auth.ok) {
          sendJson(res, auth.status, auth.body);
          return;
        }
        const opsDeny = requireOps(auth.actor);
        if (opsDeny) {
          sendJson(res, opsDeny.status, opsDeny.body);
          return;
        }
        const raw = (await readJson(req)) as {
          name?: string;
          country?: string;
          icp_segment?: 'A' | 'B' | 'C' | 'other';
          end_use_representation?: string;
          notes?: string;
        };
        const result = createPilotOrg(store, auth.actor, raw);
        if (result.status === 201) await store.persist();
        sendJson(res, result.status, result.body);
        return;
      }

      const screeningPost = match(
        method,
        url,
        'POST',
        /^\/v0\/orgs\/([^/]+)\/screening$/,
      );
      if (screeningPost) {
        const auth = await resolveAuth(store, req.headers, {
          opsApiKey: config.opsApiKey,
          requireAuth: true,
        });
        if (!auth.ok) {
          sendJson(res, auth.status, auth.body);
          return;
        }
        const opsDeny = requireOps(auth.actor);
        if (opsDeny) {
          sendJson(res, opsDeny.status, opsDeny.body);
          return;
        }
        const raw = (await readJson(req)) as Record<string, unknown>;
        const result = recordScreening(
          store,
          auth.actor,
          screeningPost[1]!,
          raw as never,
        );
        if (result.status === 200) await store.persist();
        sendJson(res, result.status, result.body);
        return;
      }

      const activatePost = match(
        method,
        url,
        'POST',
        /^\/v0\/orgs\/([^/]+)\/activate$/,
      );
      if (activatePost) {
        const auth = await resolveAuth(store, req.headers, {
          opsApiKey: config.opsApiKey,
          requireAuth: true,
        });
        if (!auth.ok) {
          sendJson(res, auth.status, auth.body);
          return;
        }
        const opsDeny = requireOps(auth.actor);
        if (opsDeny) {
          sendJson(res, opsDeny.status, opsDeny.body);
          return;
        }
        const result = activateOrg(store, auth.actor, activatePost[1]!);
        if (result.status === 200) await store.persist();
        sendJson(res, result.status, result.body);
        return;
      }

      const suspendPost = match(
        method,
        url,
        'POST',
        /^\/v0\/orgs\/([^/]+)\/suspend$/,
      );
      if (suspendPost) {
        const auth = await resolveAuth(store, req.headers, {
          opsApiKey: config.opsApiKey,
          requireAuth: true,
        });
        if (!auth.ok) {
          sendJson(res, auth.status, auth.body);
          return;
        }
        // Ops or org admin
        const opsDeny = requireOps(auth.actor);
        if (opsDeny) {
          const roleDeny = requireRole(auth.actor, 'admin', suspendPost[1]!);
          if (roleDeny) {
            sendJson(res, roleDeny.status, roleDeny.body);
            return;
          }
        }
        const raw = (await readJson(req)) as { reason?: string };
        const result = suspendOrg(
          store,
          auth.actor,
          suspendPost[1]!,
          raw.reason,
        );
        if (result.status === 200) await store.persist();
        sendJson(res, result.status, result.body);
        return;
      }


      // --- Ops: vault upstream for activated pilot org (fixtures stay gated) ---
      const opsUpstreamPost = match(
        method,
        url,
        'POST',
        /^\/v0\/ops\/orgs\/([^/]+)\/upstreams$/,
      );
      if (opsUpstreamPost) {
        const auth = await resolveAuth(store, req.headers, {
          opsApiKey: config.opsApiKey,
          requireAuth: true,
        });
        if (!auth.ok) {
          sendJson(res, auth.status, auth.body);
          return;
        }
        const opsDeny = requireOps(auth.actor);
        if (opsDeny) {
          sendJson(res, opsDeny.status, opsDeny.body);
          return;
        }
        const raw = (await readJson(req)) as {
          display_name?: string;
          host?: string;
          port?: number;
          use_tls?: boolean;
          mountpoint?: string;
          username?: string;
          password?: string;
        };
        const result = seedOpsUpstreamSecret(store, config, opsUpstreamPost[1]!, {
          display_name: raw.display_name,
          host: raw.host ?? '',
          port: raw.port,
          use_tls: raw.use_tls,
          mountpoint: raw.mountpoint,
          username: raw.username ?? '',
          password: raw.password ?? '',
        });
        if (result.status === 201) {
          const body = result.body as { upstream_id?: string };
          if (body.upstream_id) {
            store.setUpstreamHealth(body.upstream_id, opsUpstreamPost[1]!, {
              status: 'ok',
              reachable: true,
            });
          }
          await store.persist();
        }
        sendJson(res, result.status, result.body);
        return;
      }

      const apiKeysPost = match(
        method,
        url,
        'POST',
        /^\/v0\/orgs\/([^/]+)\/api-keys$/,
      );
      if (apiKeysPost) {
        const orgId = apiKeysPost[1]!;
        const auth = await resolveAuth(store, req.headers, {
          opsApiKey: config.opsApiKey,
          requireAuth: true,
        });
        if (!auth.ok) {
          sendJson(res, auth.status, auth.body);
          return;
        }
        const opsDeny = requireOps(auth.actor);
        if (opsDeny) {
          const roleDeny = requireRole(auth.actor, 'admin', orgId);
          if (roleDeny) {
            sendJson(res, roleDeny.status, roleDeny.body);
            return;
          }
        }
        const org = getOrg(store, orgId);
        if (!org) {
          sendJson(res, 404, { error: 'not_found', message: 'org not found' });
          return;
        }
        const raw = (await readJson(req)) as {
          role?: 'admin' | 'operator' | 'read';
          label?: string;
        };
        const role = raw.role ?? 'read';
        if (!['admin', 'operator', 'read'].includes(role)) {
          sendJson(res, 400, {
            error: 'invalid_request',
            message: 'role must be admin | operator | read',
          });
          return;
        }
        const { record, plaintext } = await createOrgApiKey(
          store,
          orgId,
          role,
          raw.label,
        );
        await store.persist();
        sendJson(res, 201, {
          ...publicApiKeyView(record),
          api_key: plaintext,
        });
        return;
      }

      const apiKeysList = match(
        method,
        url,
        'GET',
        /^\/v0\/orgs\/([^/]+)\/api-keys$/,
      );
      if (apiKeysList) {
        const orgId = apiKeysList[1]!;
        const auth = await resolveAuth(store, req.headers, {
          opsApiKey: config.opsApiKey,
          allowFixtureDev: config.allowFixtureOrgs,
        });
        if (!auth.ok) {
          sendJson(res, auth.status, auth.body);
          return;
        }
        const opsDeny = requireOps(auth.actor);
        if (opsDeny) {
          const roleDeny = requireRole(auth.actor, 'admin', orgId);
          if (roleDeny) {
            sendJson(res, roleDeny.status, roleDeny.body);
            return;
          }
        }
        const keys = store.listApiKeys(orgId).map(publicApiKeyView);
        sendJson(res, 200, { api_keys: keys });
        return;
      }

      const apiKeyRevoke = match(
        method,
        url,
        'POST',
        /^\/v0\/orgs\/([^/]+)\/api-keys\/([^/]+)\/revoke$/,
      );
      if (apiKeyRevoke) {
        const orgId = apiKeyRevoke[1]!;
        const keyId = apiKeyRevoke[2]!;
        const auth = await resolveAuth(store, req.headers, {
          opsApiKey: config.opsApiKey,
          requireAuth: true,
        });
        if (!auth.ok) {
          sendJson(res, auth.status, auth.body);
          return;
        }
        const opsDeny = requireOps(auth.actor);
        if (opsDeny) {
          const roleDeny = requireRole(auth.actor, 'admin', orgId);
          if (roleDeny) {
            sendJson(res, roleDeny.status, roleDeny.body);
            return;
          }
        }
        const key = store.getApiKey(keyId);
        if (!key || key.org_id !== orgId) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'api key not found',
          });
          return;
        }
        const revoked = store.revokeApiKey(keyId);
        await store.persist();
        sendJson(res, 200, publicApiKeyView(revoked!));
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
        // Active/pilot orgs require org API key; fixture may keep fixture-dev path.
        const auth = await resolveOrgScopedAuth(
          store,
          req.headers,
          {
            opsApiKey: config.opsApiKey,
            allowFixtureOrgs: config.allowFixtureOrgs,
          },
          org,
          'read',
        );
        if (!auth.ok) {
          sendJson(res, auth.status, auth.body);
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
        const orgId = devicesPost[1]!;
        const org = getOrg(store, orgId);
        if (!org) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'org not found',
          });
          return;
        }
        // Active/pilot orgs require org API key; fixture may keep fixture-dev path.
        const auth = await resolveOrgScopedAuth(
          store,
          req.headers,
          {
            opsApiKey: config.opsApiKey,
            allowFixtureOrgs: config.allowFixtureOrgs,
          },
          org,
          'operator',
        );
        if (!auth.ok) {
          sendJson(res, auth.status, auth.body);
          return;
        }
        const raw = (await readJson(req)) as {
          label?: string;
          profile_id?: string;
        };
        const result = await provisionDevice(store, config, orgId, raw);
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
        const org = getOrg(store, device.org_id);
        if (!org) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'org not found',
          });
          return;
        }
        const auth = await resolveOrgScopedAuth(
          store,
          req.headers,
          {
            opsApiKey: config.opsApiKey,
            allowFixtureOrgs: config.allowFixtureOrgs,
          },
          org,
          'read',
        );
        if (!auth.ok) {
          sendJson(res, auth.status, auth.body);
          return;
        }
        sendJson(res, 200, device);
        return;
      }

      // Profiles
      const profilesList = match(
        method,
        url,
        'GET',
        /^\/v0\/orgs\/([^/]+)\/profiles$/,
      );
      if (profilesList) {
        const result = listProfiles(store, profilesList[1]!);
        sendJson(res, result.status, result.body);
        return;
      }

      const profilesPost = match(
        method,
        url,
        'POST',
        /^\/v0\/orgs\/([^/]+)\/profiles$/,
      );
      if (profilesPost) {
        const raw = (await readJson(req)) as Record<string, unknown>;
        const result = createProfile(store, profilesPost[1]!, raw as never);
        if (result.status === 201) await store.persist();
        sendJson(res, result.status, result.body);
        return;
      }

      const profileGet = match(
        method,
        url,
        'GET',
        /^\/v0\/profiles\/([^/]+)$/,
      );
      if (profileGet) {
        const result = getProfile(store, profileGet[1]!);
        sendJson(res, result.status, result.body);
        return;
      }

      const profilePut = match(
        method,
        url,
        'PUT',
        /^\/v0\/profiles\/([^/]+)$/,
      );
      if (profilePut) {
        const raw = (await readJson(req)) as Record<string, unknown>;
        const result = putProfile(store, profilePut[1]!, raw as never);
        if (result.status === 200) await store.persist();
        sendJson(res, result.status, result.body);
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
        if (result.status === 201) {
          const body = result.body as { upstream_id?: string };
          if (body.upstream_id) {
            store.setUpstreamHealth(body.upstream_id, FIXTURE_ORG_ID, {
              status: 'ok',
              reachable: true,
            });
          }
          await store.persist();
        }
        sendJson(res, result.status, result.body);
        return;
      }

      // Dev helper: mark upstream health (for failover demos)
      if (match(method, url, 'POST', /^\/v0\/fixture\/upstream-health$/)) {
        const raw = (await readJson(req)) as {
          upstream_id?: string;
          status?: 'ok' | 'degraded' | 'unreachable' | 'unknown';
          reachable?: boolean;
          last_error?: string;
        };
        if (!raw.upstream_id || !raw.status) {
          sendJson(res, 400, {
            error: 'invalid_request',
            message: 'upstream_id and status required',
          });
          return;
        }
        const up = store.getUpstream(raw.upstream_id);
        if (!up) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'upstream not found',
          });
          return;
        }
        const snap = store.setUpstreamHealth(raw.upstream_id, up.org_id, {
          status: raw.status,
          reachable: raw.reachable ?? raw.status === 'ok',
          last_error: raw.last_error,
        });
        await store.persist();
        sendJson(res, 200, snap);
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
          const health = store.getUpstreamHealth(u.id);
          return {
            id: u.id,
            adapter_type: u.adapter_type,
            display_name: u.display_name,
            host: u.host,
            port: u.port,
            use_tls: u.use_tls,
            default_mountpoint: u.default_mountpoint,
            enabled: u.enabled,
            health: health ?? null,
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

      // Health endpoints
      const healthOrg = match(
        method,
        url,
        'GET',
        /^\/v0\/orgs\/([^/]+)\/health$/,
      );
      if (healthOrg) {
        const result = orgHealth(store, healthOrg[1]!);
        sendJson(res, result.status, result.body);
        return;
      }

      const healthUp = match(
        method,
        url,
        'GET',
        /^\/v0\/upstreams\/([^/]+)\/health$/,
      );
      if (healthUp) {
        const result = upstreamHealth(store, healthUp[1]!);
        sendJson(res, result.status, result.body);
        return;
      }

      const healthDev = match(
        method,
        url,
        'GET',
        /^\/v0\/devices\/([^/]+)\/health$/,
      );
      if (healthDev) {
        const result = deviceHealth(store, healthDev[1]!);
        sendJson(res, result.status, result.body);
        return;
      }

      const sessionsList = match(
        method,
        url,
        'GET',
        /^\/v0\/orgs\/([^/]+)\/sessions$/,
      );
      if (sessionsList) {
        const result = listActiveSessions(store, sessionsList[1]!);
        sendJson(res, result.status, result.body);
        return;
      }

      // Audit query with filters
      const auditGet = match(
        method,
        url,
        'GET',
        /^\/v0\/orgs\/([^/]+)\/audit$/,
      );
      if (auditGet) {
        const result = queryAudit(store, auditGet[1]!, url);
        sendJson(res, result.status, result.body);
        return;
      }

      // Usage events + export + webhooks
      const usageExport = match(
        method,
        url,
        'GET',
        /^\/v0\/orgs\/([^/]+)\/usage\/export$/,
      );
      if (usageExport) {
        const result = exportUsage(store, usageExport[1]!, url);
        sendJson(res, result.status, result.body);
        return;
      }

      const usageGet = match(
        method,
        url,
        'GET',
        /^\/v0\/orgs\/([^/]+)\/usage\/events$/,
      );
      if (usageGet) {
        const result = queryUsageEvents(store, usageGet[1]!, url);
        sendJson(res, result.status, result.body);
        return;
      }

      const usageWebhook = match(
        method,
        url,
        'POST',
        /^\/v0\/orgs\/([^/]+)\/usage\/webhooks$/,
      );
      if (usageWebhook) {
        const raw = (await readJson(req)) as { url?: string; secret?: string };
        const result = registerUsageWebhook(store, usageWebhook[1]!, raw);
        if (result.status === 201) await store.persist();
        sendJson(res, result.status, result.body);
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

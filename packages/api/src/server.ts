import http from 'node:http';
import { listRoutableAdapters } from '@grokbot/adapters';
import { loadConfig } from './config.js';
import { createOrg, getOrg, seedFixtureOrg } from './orgs.js';

const config = loadConfig();
seedFixtureOrg();

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

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    try {
      if (match(method, url, 'GET', /^\/healthz$/)) {
        sendJson(res, 200, {
          ok: true,
          service: 'grokbot-api',
          milestone: 'M0',
          routable_adapters: listRoutableAdapters().map((a) => a.type),
        });
        return;
      }

      if (match(method, url, 'POST', /^\/v0\/orgs$/)) {
        const raw = (await readJson(req)) as {
          name?: string;
          fixture?: boolean;
        };
        const allowHeader =
          req.headers['x-allow-fixture-orgs'] === 'true';
        const result = createOrg(config, raw, allowHeader);
        sendJson(res, result.status, result.body);
        return;
      }

      const orgGet = match(method, url, 'GET', /^\/v0\/orgs\/([^/]+)$/);
      if (orgGet) {
        const org = getOrg(orgGet[1]!);
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
        const org = getOrg(devicesList[1]!);
        if (!org) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'org not found',
          });
          return;
        }
        sendJson(res, 200, { devices: [] });
        return;
      }

      const devicesPost = match(
        method,
        url,
        'POST',
        /^\/v0\/orgs\/([^/]+)\/devices$/,
      );
      if (devicesPost) {
        sendJson(res, 501, {
          error: 'not_implemented',
          message: 'Device provisioning lands in M1 vertical slice',
        });
        return;
      }

      const health = match(
        method,
        url,
        'GET',
        /^\/v0\/orgs\/([^/]+)\/health$/,
      );
      if (health) {
        sendJson(res, 200, {
          org_id: health[1],
          active_sessions: 0,
          notes:
            'GGA/last-position for session health only — no track histories; metering = connect/bytes/device-days only',
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
        message: 'unexpected error',
      });
    }
  });
}

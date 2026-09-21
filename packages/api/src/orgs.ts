import { randomUUID } from 'node:crypto';
import { ApiConfig } from './config.js';
import { ApiErrorBody, Org } from './types.js';

/** In-memory fixture store for M0 — no DB yet. */
const fixtureOrgs = new Map<string, Org>();

export function seedFixtureOrg(): Org {
  const org: Org = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'fixture-dev-org',
    status: 'fixture',
    screening_status: 'fixture_exempt',
  };
  fixtureOrgs.set(org.id, org);
  return org;
}

export function getOrg(id: string): Org | undefined {
  return fixtureOrgs.get(id);
}

export interface CreateOrgResult {
  status: number;
  body: Org | ApiErrorBody;
}

/**
 * Live org create → 403 screening_required.
 * Fixture create only when config + header + body.fixture.
 */
export function createOrg(
  config: ApiConfig,
  input: { name?: string; fixture?: boolean },
  allowFixtureHeader: boolean,
): CreateOrgResult {
  const wantsFixture = input.fixture === true;

  if (wantsFixture) {
    if (!config.allowFixtureOrgs || !allowFixtureHeader) {
      return {
        status: 403,
        body: {
          error: 'screening_required',
          message:
            'Fixture orgs require non-prod ALLOW_FIXTURE_ORGS=true and X-Allow-Fixture-Orgs: true.',
        },
      };
    }
    if (!input.name || input.name.trim() === '') {
      return {
        status: 400,
        body: { error: 'invalid_request', message: 'name is required' },
      };
    }
    const org: Org = {
      id: randomUUID(),
      name: input.name.trim(),
      status: 'fixture',
      screening_status: 'fixture_exempt',
    };
    fixtureOrgs.set(org.id, org);
    return { status: 201, body: org };
  }

  // Live path — always gated in M0
  return {
    status: 403,
    body: {
      error: 'screening_required',
      message:
        'Live org provisioning requires end-use/sanctions screening before activation.',
    },
  };
}

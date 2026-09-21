import { randomUUID } from 'node:crypto';
import { Org, Store } from '@grokbot/core';
import { ApiConfig } from './config.js';
import { ApiErrorBody } from './types.js';

export function seedFixtureOrg(store: Store): Org {
  return store.seedFixtureOrg();
}

export function getOrg(store: Store, id: string): Org | undefined {
  return store.getOrg(id);
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
  store: Store,
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
    store.putOrg(org);
    return { status: 201, body: org };
  }

  return {
    status: 403,
    body: {
      error: 'screening_required',
      message:
        'Live org provisioning requires end-use/sanctions screening before activation.',
    },
  };
}

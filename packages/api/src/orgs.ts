import { randomUUID } from 'node:crypto';
import {
  canActivateOrg,
  IcpSegment,
  Org,
  orgIsUsable,
  ScreeningStatus,
  Store,
} from '@grokbot/core';
import { actorAuditFields, AuthActor } from './auth.js';
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
 * Live org create → 403 screening_required (self-serve closed).
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
      created_at: new Date().toISOString(),
    };
    store.putOrg(org);
    return { status: 201, body: org };
  }

  return {
    status: 403,
    body: {
      error: 'screening_required',
      message:
        'Live org provisioning requires end-use/sanctions screening before activation. Self-serve signup is closed; use the approved pilot ops path.',
    },
  };
}

export interface PilotIntakeInput {
  name?: string;
  country?: string;
  icp_segment?: IcpSegment;
  end_use_representation?: string;
  notes?: string;
}

/**
 * Ops-only: create carefully screened pilot candidate (pending_screening).
 * Prefer ICP A — Nordic construction machine-control SI/OEM.
 * Does NOT auto-approve or activate.
 */
export function createPilotOrg(
  store: Store,
  actor: AuthActor,
  input: PilotIntakeInput,
): CreateOrgResult {
  if (!input.name || input.name.trim() === '') {
    return {
      status: 400,
      body: { error: 'invalid_request', message: 'name is required' },
    };
  }
  if (!input.country || input.country.trim() === '') {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'country is required (sanctions/export screening hook)',
      },
    };
  }
  if (!input.end_use_representation || input.end_use_representation.trim() === '') {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'end_use_representation is required (civil/commercial use)',
      },
    };
  }
  const icp = input.icp_segment ?? 'A';
  const now = new Date().toISOString();
  const org: Org = {
    id: randomUUID(),
    name: input.name.trim(),
    status: 'pending_screening',
    screening_status: 'pending',
    country: input.country.trim().toUpperCase(),
    icp_segment: icp,
    end_use_representation: input.end_use_representation.trim(),
    created_at: now,
  };
  store.putOrg(org);
  const audit = actorAuditFields(actor);
  store.appendAudit({
    org_id: org.id,
    ...audit,
    event_type: 'org.pilot_intake',
    resource_type: 'org',
    resource_id: org.id,
    payload_json: {
      name: org.name,
      country: org.country,
      icp_segment: org.icp_segment,
      notes: input.notes ?? null,
    },
  });
  return { status: 201, body: org };
}

export interface ScreeningInput {
  result?: ScreeningStatus;
  screening_reference?: string;
  screening_notes?: string;
  prohibited_use_attested?: boolean;
  sanctions_cleared?: boolean;
  upstream_tos_acknowledged?: boolean;
  end_use_representation?: string;
}

/**
 * Ops: record screening result. Cleared requires attestations + sanctions clear.
 * Does not activate — activation is a separate audited step.
 */
export function recordScreening(
  store: Store,
  actor: AuthActor,
  orgId: string,
  input: ScreeningInput,
): CreateOrgResult {
  const org = store.getOrg(orgId);
  if (!org) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'org not found' },
    };
  }
  if (org.status === 'fixture' || org.screening_status === 'fixture_exempt') {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'Fixture orgs are screening-exempt',
      },
    };
  }
  const result = input.result;
  if (!result || !['pending', 'cleared', 'rejected'].includes(result)) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'result must be pending | cleared | rejected',
      },
    };
  }
  if (result === 'cleared') {
    if (input.prohibited_use_attested !== true) {
      return {
        status: 400,
        body: {
          error: 'invalid_request',
          message:
            'cleared requires prohibited_use_attested=true (no surveillance/criminal/mil weapons/jam-spoof/sanctions)',
        },
      };
    }
    if (input.sanctions_cleared !== true) {
      return {
        status: 400,
        body: {
          error: 'invalid_request',
          message: 'cleared requires sanctions_cleared=true',
        },
      };
    }
    if (input.upstream_tos_acknowledged !== true) {
      return {
        status: 400,
        body: {
          error: 'invalid_request',
          message:
            'cleared requires upstream_tos_acknowledged=true (customer owns upstream ToS)',
        },
      };
    }
    if (!input.end_use_representation && !org.end_use_representation) {
      return {
        status: 400,
        body: {
          error: 'invalid_request',
          message: 'cleared requires end_use_representation',
        },
      };
    }
  }

  const now = new Date().toISOString();
  const next: Org = {
    ...org,
    screening_status: result,
    screening_at: now,
  };
  if (input.screening_reference !== undefined) {
    next.screening_reference = input.screening_reference;
  }
  if (input.screening_notes !== undefined) {
    next.screening_notes = input.screening_notes;
  }
  if (input.prohibited_use_attested !== undefined) {
    next.prohibited_use_attested = input.prohibited_use_attested;
  }
  if (input.sanctions_cleared !== undefined) {
    next.sanctions_cleared = input.sanctions_cleared;
  }
  if (input.upstream_tos_acknowledged !== undefined) {
    next.upstream_tos_acknowledged = input.upstream_tos_acknowledged;
  }
  if (input.end_use_representation !== undefined) {
    next.end_use_representation = input.end_use_representation;
  }
  if (result === 'rejected' && next.status === 'active') {
    next.status = 'suspended';
    next.suspended_at = now;
    next.suspended_reason = 'screening_rejected';
  }
  store.putOrg(next);
  const audit = actorAuditFields(actor);
  store.appendAudit({
    org_id: orgId,
    ...audit,
    event_type: `org.screening_${result}`,
    resource_type: 'org',
    resource_id: orgId,
    payload_json: {
      screening_status: result,
      screening_reference: next.screening_reference ?? null,
      sanctions_cleared: next.sanctions_cleared ?? false,
      prohibited_use_attested: next.prohibited_use_attested ?? false,
    },
  });
  return { status: 200, body: next };
}

/**
 * Ops: activate approved pilot. Requires screening_status=cleared
 * AND attestation flags still true (re-checked at activation time).
 */
export function activateOrg(
  store: Store,
  actor: AuthActor,
  orgId: string,
): CreateOrgResult {
  const org = store.getOrg(orgId);
  if (!org) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'org not found' },
    };
  }
  if (org.status === 'fixture') {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'Fixture orgs do not need activation',
      },
    };
  }
  if (org.status === 'suspended') {
    return {
      status: 403,
      body: {
        error: 'org_suspended',
        message:
          'Suspended orgs cannot be activated; clear suspension first via ops',
      },
    };
  }
  if (org.screening_status !== 'cleared') {
    return {
      status: 403,
      body: {
        error: 'screening_required',
        message:
          'Org cannot become active unless screening_status=cleared (architecture §10.3)',
      },
    };
  }
  if (
    org.prohibited_use_attested !== true ||
    org.sanctions_cleared !== true ||
    org.upstream_tos_acknowledged !== true
  ) {
    return {
      status: 403,
      body: {
        error: 'attestation_required',
        message:
          'Activation rejected: prohibited_use_attested, sanctions_cleared, and upstream_tos_acknowledged must still be true (not only screening_status=cleared)',
      },
    };
  }
  if (!canActivateOrg(org)) {
    return {
      status: 403,
      body: {
        error: 'screening_required',
        message:
          'Org cannot become active unless screening_status=cleared with attestations (architecture §10.3)',
      },
    };
  }
  const now = new Date().toISOString();
  const next: Org = {
    ...org,
    status: 'active',
    activated_at: now,
  };
  store.putOrg(next);
  const audit = actorAuditFields(actor);
  store.appendAudit({
    org_id: orgId,
    ...audit,
    event_type: 'org.activated',
    resource_type: 'org',
    resource_id: orgId,
    payload_json: {
      screening_reference: org.screening_reference ?? null,
      icp_segment: org.icp_segment ?? null,
      approved_pilot: true,
    },
  });
  return { status: 200, body: next };
}

/**
 * Ops or org admin: suspend org (right to suspend on misuse).
 */
export function suspendOrg(
  store: Store,
  actor: AuthActor,
  orgId: string,
  reason?: string,
): CreateOrgResult {
  const org = store.getOrg(orgId);
  if (!org) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'org not found' },
    };
  }
  if (org.status === 'fixture') {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'Cannot suspend fixture org via this path',
      },
    };
  }
  const now = new Date().toISOString();
  const next: Org = {
    ...org,
    status: 'suspended',
    suspended_at: now,
    suspended_reason: reason ?? 'ops_suspend',
  };
  store.putOrg(next);
  const audit = actorAuditFields(actor);
  store.appendAudit({
    org_id: orgId,
    ...audit,
    event_type: 'org.suspended',
    resource_type: 'org',
    resource_id: orgId,
    payload_json: { reason: next.suspended_reason },
  });
  return { status: 200, body: next };
}

export { orgIsUsable, canActivateOrg };

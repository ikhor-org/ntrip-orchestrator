import { randomUUID } from 'node:crypto';
import {
  Device,
  generatePseudoPassword,
  generatePseudoUsername,
  hashPassword,
  Org,
  orgIsUsable,
  PseudoCredential,
  Store,
} from '@grokbot/core';
import { ApiConfig } from './config.js';
import { ApiErrorBody } from './types.js';

export interface DeviceProvisioned {
  device: Device;
  /** Plaintext password returned ONCE — never stored. */
  pseudo_username: string;
  pseudo_password: string;
}

export interface ProvisionResult {
  status: number;
  body: DeviceProvisioned | ApiErrorBody;
}

function isFixtureOrg(org: Org): boolean {
  return org.status === 'fixture' || org.screening_status === 'fixture_exempt';
}

/**
 * Provision device + pseudo-cred against fixture org only.
 */
export async function provisionDevice(
  store: Store,
  config: ApiConfig,
  orgId: string,
  input: { label?: string; profile_id?: string },
): Promise<ProvisionResult> {
  const org = store.getOrg(orgId);
  if (!org) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'org not found' },
    };
  }
  if (org.status === 'suspended') {
    return {
      status: 403,
      body: {
        error: 'org_suspended',
        message: 'Suspended orgs cannot provision devices',
      },
    };
  }
  if (!orgIsUsable(org)) {
    return {
      status: 403,
      body: {
        error: 'screening_required',
        message:
          'Device provisioning requires an active cleared org or non-prod fixture org',
      },
    };
  }
  if (isFixtureOrg(org) && !config.allowFixtureOrgs) {
    return {
      status: 403,
      body: {
        error: 'fixture_org_only',
        message: 'Fixture provisioning requires ALLOW_FIXTURE_ORGS=true',
      },
    };
  }

  const deviceId = randomUUID();
  const username = generatePseudoUsername('dev');
  const password = generatePseudoPassword();
  const password_hash = await hashPassword(password);
  const now = new Date().toISOString();

  const device: Device = {
    id: deviceId,
    org_id: orgId,
    tags: [],
    status: 'active',
    created_at: now,
  };
  if (input.label !== undefined) device.label = input.label;
  if (input.profile_id !== undefined) device.profile_id = input.profile_id;

  const cred: PseudoCredential = {
    id: randomUUID(),
    device_id: deviceId,
    username,
    password_hash,
    version: 1,
    created_at: now,
  };

  store.putDevice(device, cred);
  store.appendAudit({
    org_id: orgId,
    actor_type: 'api',
    actor_id: 'local',
    event_type: 'device.provisioned',
    resource_type: 'device',
    resource_id: deviceId,
    payload_json: { username, device_id: deviceId },
  });
  await store.persist();

  return {
    status: 201,
    body: {
      device,
      pseudo_username: username,
      pseudo_password: password,
    },
  };
}

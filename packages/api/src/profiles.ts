import {
  defaultFailoverPolicy,
  normalizePolicy,
  Profile,
  ProfileCandidate,
  orgIsUsable,
  ProfilePolicy,
  Store,
} from '@grokbot/core';
import { ApiErrorBody } from './types.js';

export interface ProfileResult {
  status: number;
  body: Profile | ApiErrorBody | { profiles: Profile[] };
}


export function createProfile(
  store: Store,
  orgId: string,
  input: {
    name?: string;
    candidates?: ProfileCandidate[];
    failover?: Partial<ProfilePolicy['failover']>;
    datum_tag?: string;
    epoch_tag?: string;
    policy_json?: Partial<ProfilePolicy>;
  },
): ProfileResult {
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
        message: 'Suspended orgs cannot create profiles',
      },
    };
  }
  if (!orgIsUsable(org)) {
    return {
      status: 403,
      body: {
        error: 'screening_required',
        message:
          'Profile create requires an active cleared org or non-prod fixture org',
      },
    };
  }
  if (!input.name || input.name.trim() === '') {
    return {
      status: 400,
      body: { error: 'invalid_request', message: 'name is required' },
    };
  }
  const candidates =
    input.candidates ??
    input.policy_json?.candidates ??
    [];
  if (candidates.length === 0) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'at least one candidate (primary) is required',
      },
    };
  }
  for (const c of candidates) {
    const up = store.getUpstream(c.upstream_endpoint_id);
    if (!up || up.org_id !== orgId) {
      return {
        status: 400,
        body: {
          error: 'invalid_request',
          message: `unknown upstream_endpoint_id: ${c.upstream_endpoint_id}`,
        },
      };
    }
  }
  const policy = normalizePolicy({
    candidates,
    failover: defaultFailoverPolicy(
      input.failover ?? input.policy_json?.failover,
    ),
    datum_tag: input.datum_tag ?? input.policy_json?.datum_tag,
    epoch_tag: input.epoch_tag ?? input.policy_json?.epoch_tag,
  });
  const profile = store.createProfile({
    org_id: orgId,
    name: input.name.trim(),
    policy_json: policy,
    datum_tag: policy.datum_tag,
    epoch_tag: policy.epoch_tag,
  });
  store.appendAudit({
    org_id: orgId,
    actor_type: 'api',
    actor_id: 'local',
    event_type: 'profile.created',
    resource_type: 'profile',
    resource_id: profile.id,
    payload_json: {
      name: profile.name,
      candidate_count: policy.candidates.length,
    },
  });
  return { status: 201, body: profile };
}

export function listProfiles(store: Store, orgId: string): ProfileResult {
  const org = store.getOrg(orgId);
  if (!org) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'org not found' },
    };
  }
  return { status: 200, body: { profiles: store.listProfiles(orgId) } };
}

export function getProfile(store: Store, profileId: string): ProfileResult {
  const profile = store.getProfile(profileId);
  if (!profile) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'profile not found' },
    };
  }
  return { status: 200, body: profile };
}

export function putProfile(
  store: Store,
  profileId: string,
  input: {
    name?: string;
    candidates?: ProfileCandidate[];
    failover?: Partial<ProfilePolicy['failover']>;
    datum_tag?: string;
    epoch_tag?: string;
    policy_json?: Partial<ProfilePolicy>;
  },
): ProfileResult {
  const cur = store.getProfile(profileId);
  if (!cur) {
    return {
      status: 404,
      body: { error: 'not_found', message: 'profile not found' },
    };
  }
  const candidates =
    input.candidates ??
    input.policy_json?.candidates ??
    cur.policy_json.candidates;
  if (!candidates || candidates.length === 0) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'at least one candidate is required',
      },
    };
  }
  for (const c of candidates) {
    const up = store.getUpstream(c.upstream_endpoint_id);
    if (!up || up.org_id !== cur.org_id) {
      return {
        status: 400,
        body: {
          error: 'invalid_request',
          message: `unknown upstream_endpoint_id: ${c.upstream_endpoint_id}`,
        },
      };
    }
  }
  const policy = normalizePolicy({
    candidates,
    failover: defaultFailoverPolicy(
      input.failover ??
        input.policy_json?.failover ??
        cur.policy_json.failover,
    ),
    datum_tag:
      input.datum_tag ?? input.policy_json?.datum_tag ?? cur.datum_tag,
    epoch_tag:
      input.epoch_tag ?? input.policy_json?.epoch_tag ?? cur.epoch_tag,
  });
  const updated = store.replaceProfilePolicy(profileId, policy, {
    name: input.name,
    datum_tag: policy.datum_tag,
    epoch_tag: policy.epoch_tag,
  });
  store.appendAudit({
    org_id: cur.org_id,
    actor_type: 'api',
    actor_id: 'local',
    event_type: 'profile.updated',
    resource_type: 'profile',
    resource_id: profileId,
    payload_json: { candidate_count: policy.candidates.length },
  });
  return { status: 200, body: updated! };
}

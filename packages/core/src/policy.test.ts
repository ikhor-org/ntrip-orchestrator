import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FailoverController,
  normalizePolicy,
  orderCandidates,
  selectCandidates,
} from './policy.js';
import { ProfileCandidate, UpstreamHealthSnapshot } from './types.js';

function cand(priority: number, id: string): ProfileCandidate {
  return { priority, upstream_endpoint_id: id };
}

test('orderCandidates sorts by ascending priority', () => {
  const ordered = orderCandidates([
    cand(3, 'c'),
    cand(1, 'a'),
    cand(2, 'b'),
  ]);
  assert.deepEqual(
    ordered.map((c) => c.upstream_endpoint_id),
    ['a', 'b', 'c'],
  );
});

test('orderCandidates is stable for equal priority (id tie-break)', () => {
  const ordered = orderCandidates([cand(1, 'z'), cand(1, 'a'), cand(1, 'm')]);
  assert.deepEqual(
    ordered.map((c) => c.upstream_endpoint_id),
    ['a', 'm', 'z'],
  );
});

test('selectCandidates picks primary when healthy', () => {
  const policy = normalizePolicy({
    candidates: [cand(1, 'primary'), cand(2, 'secondary')],
  });
  const health = new Map<string, UpstreamHealthSnapshot>([
    [
      'primary',
      {
        upstream_id: 'primary',
        org_id: 'o',
        status: 'ok',
        reachable: true,
        updated_at: new Date().toISOString(),
      },
    ],
  ]);
  const result = selectCandidates({ policy, healthByUpstream: health });
  assert.equal(result.selected?.upstream_endpoint_id, 'primary');
  assert.equal(result.reason, 'primary_ok');
});

test('selectCandidates skips unreachable primary → secondary', () => {
  const policy = normalizePolicy({
    candidates: [cand(1, 'primary'), cand(2, 'secondary')],
  });
  const health = new Map<string, UpstreamHealthSnapshot>([
    [
      'primary',
      {
        upstream_id: 'primary',
        org_id: 'o',
        status: 'unreachable',
        reachable: false,
        updated_at: new Date().toISOString(),
      },
    ],
    [
      'secondary',
      {
        upstream_id: 'secondary',
        org_id: 'o',
        status: 'ok',
        reachable: true,
        updated_at: new Date().toISOString(),
      },
    ],
  ]);
  const result = selectCandidates({ policy, healthByUpstream: health });
  assert.equal(result.selected?.upstream_endpoint_id, 'secondary');
  assert.equal(result.reason, 'switched_secondary');
});

test('failover hysteresis holds until unhealthy_after_ms', () => {
  const ctrl = new FailoverController({
    unhealthy_after_ms: 1000,
    max_switches_per_hour: 10,
    on_exhaust: 'reject',
  });
  ctrl.bind('primary');
  const t0 = 1_000_000;
  const early = ctrl.markUnhealthy(t0);
  assert.equal(early.ready, false);
  assert.equal(early.reason, 'hysteresis_hold');
  assert.ok(early.remainingMs > 0);

  const still = ctrl.commitSwitch('secondary', t0 + 500);
  assert.equal(still.ok, false);
  assert.equal(still.reason, 'hysteresis_hold');

  const ready = ctrl.markUnhealthy(t0 + 1000);
  assert.equal(ready.ready, true);
  const sw = ctrl.commitSwitch('secondary', t0 + 1000);
  assert.equal(sw.ok, true);
  assert.equal(ctrl.currentUpstream, 'secondary');
});

test('failover max_switches_per_hour prevents flapping', () => {
  const ctrl = new FailoverController({
    unhealthy_after_ms: 0,
    max_switches_per_hour: 2,
    on_exhaust: 'reject',
  });
  ctrl.bind('u0');
  const t0 = 2_000_000;
  assert.equal(ctrl.commitSwitch('u1', t0).ok, true);
  ctrl.markUnhealthy(t0 + 10);
  assert.equal(ctrl.commitSwitch('u2', t0 + 10).ok, true);
  ctrl.markUnhealthy(t0 + 20);
  const blocked = ctrl.commitSwitch('u3', t0 + 20);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'max_switches_exhausted');
  assert.equal(ctrl.switchCountLastHour(t0 + 20), 2);
});

test('markHealthy clears unhealthy timer (no flap on brief blip)', () => {
  const ctrl = new FailoverController({
    unhealthy_after_ms: 5000,
    max_switches_per_hour: 10,
    on_exhaust: 'reject',
  });
  ctrl.bind('primary');
  const t0 = 3_000_000;
  ctrl.markUnhealthy(t0);
  ctrl.markHealthy();
  const again = ctrl.markUnhealthy(t0 + 100);
  // Timer restarted — not ready yet
  assert.equal(again.ready, false);
  assert.ok(again.remainingMs > 4000);
});

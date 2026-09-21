/**
 * Route / failover policy engine (architecture §5.4).
 * Ordered candidates + health-triggered failover with hysteresis.
 */

import {
  DEFAULT_FAILOVER,
  FailoverPolicy,
  FailoverReasonCode,
  ProfileCandidate,
  ProfilePolicy,
  UpstreamHealthSnapshot,
  UpstreamHealthStatus,
} from './types.js';

export function defaultFailoverPolicy(
  overrides?: Partial<FailoverPolicy>,
): FailoverPolicy {
  return { ...DEFAULT_FAILOVER, ...overrides };
}

export function normalizePolicy(
  raw: Partial<ProfilePolicy> & { candidates?: ProfileCandidate[] },
): ProfilePolicy {
  const candidates = [...(raw.candidates ?? [])].map((c) => {
    const out: ProfileCandidate = {
      priority: c.priority,
      upstream_endpoint_id: c.upstream_endpoint_id,
    };
    if (c.mountpoint_override !== undefined) {
      out.mountpoint_override = c.mountpoint_override;
    }
    if (c.min_health !== undefined) out.min_health = c.min_health;
    return out;
  });
  const policy: ProfilePolicy = {
    candidates,
    failover: defaultFailoverPolicy(raw.failover),
  };
  if (raw.profile_id !== undefined) policy.profile_id = raw.profile_id;
  if (raw.datum_tag !== undefined) policy.datum_tag = raw.datum_tag;
  if (raw.epoch_tag !== undefined) policy.epoch_tag = raw.epoch_tag;
  return policy;
}

/** Sort candidates by ascending priority (1 = primary). Stable for ties. */
export function orderCandidates(
  candidates: ProfileCandidate[],
): ProfileCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.upstream_endpoint_id.localeCompare(b.upstream_endpoint_id);
  });
}

function statusMeetsMin(
  status: UpstreamHealthStatus | undefined,
  min?: 'ok',
): boolean {
  if (!min) return true;
  return status === 'ok';
}

export interface SelectionInput {
  policy: ProfilePolicy;
  healthByUpstream: Map<string, UpstreamHealthSnapshot>;
  /** Upstream ids already tried and failed this session attempt. */
  excludedUpstreamIds?: Set<string>;
}

export interface SelectionResult {
  ordered: ProfileCandidate[];
  selected?: ProfileCandidate;
  reason: FailoverReasonCode;
}

/**
 * Return ordered eligible candidates and the top pick for this attempt.
 */
export function selectCandidates(input: SelectionInput): SelectionResult {
  const ordered = orderCandidates(input.policy.candidates);
  const excluded = input.excludedUpstreamIds ?? new Set<string>();
  const eligible: ProfileCandidate[] = [];
  for (const c of ordered) {
    if (excluded.has(c.upstream_endpoint_id)) continue;
    const snap = input.healthByUpstream.get(c.upstream_endpoint_id);
    if (c.min_health && !statusMeetsMin(snap?.status, c.min_health)) continue;
    if (snap?.status === 'unreachable') continue;
    eligible.push(c);
  }

  if (eligible.length === 0) {
    return { ordered, reason: 'candidates_exhausted' };
  }

  const selected = eligible[0]!;
  const isPrimary =
    ordered[0]?.upstream_endpoint_id === selected.upstream_endpoint_id;
  const reason: FailoverReasonCode = isPrimary
    ? 'primary_ok'
    : ordered.length > 1 &&
        selected.upstream_endpoint_id === ordered[1]?.upstream_endpoint_id
      ? 'switched_secondary'
      : 'switched_next';
  return { ordered: eligible, selected, reason };
}

/**
 * Session-scoped failover controller with hysteresis + rate limit.
 * Call markUnhealthy(now) when stream fails; decideSwitch when evaluating.
 */
export class FailoverController {
  readonly failover: FailoverPolicy;
  private unhealthySinceMs: number | null = null;
  private switchTimestampsMs: number[] = [];
  private currentUpstreamId: string | null = null;
  private excluded = new Set<string>();

  constructor(failover: FailoverPolicy = DEFAULT_FAILOVER) {
    this.failover = { ...failover };
  }

  get currentUpstream(): string | null {
    return this.currentUpstreamId;
  }

  get excludedUpstreamIds(): Set<string> {
    return new Set(this.excluded);
  }

  /** Force-exclude an upstream (e.g. connect failed before bind). */
  exclude(upstreamId: string): void {
    this.excluded.add(upstreamId);
  }

  switchCountLastHour(nowMs = Date.now()): number {
    const cutoff = nowMs - 3_600_000;
    this.switchTimestampsMs = this.switchTimestampsMs.filter((t) => t >= cutoff);
    return this.switchTimestampsMs.length;
  }

  /** Bind initial upstream (no switch counted). */
  bind(upstreamId: string): void {
    this.currentUpstreamId = upstreamId;
    this.unhealthySinceMs = null;
  }

  /** Mark current upstream healthy — clears unhealthy timer. */
  markHealthy(): void {
    this.unhealthySinceMs = null;
  }

  /**
   * Mark unhealthy. Returns ms remaining before hysteresis allows switch,
   * or 0 if ready to switch, or -1 if max switches exhausted.
   */
  markUnhealthy(nowMs = Date.now()): {
    ready: boolean;
    unhealthyForMs: number;
    remainingMs: number;
    reason: FailoverReasonCode;
  } {
    if (this.unhealthySinceMs === null) {
      this.unhealthySinceMs = nowMs;
    }
    const unhealthyForMs = nowMs - this.unhealthySinceMs;
    const remainingMs = Math.max(
      0,
      this.failover.unhealthy_after_ms - unhealthyForMs,
    );
    if (this.switchCountLastHour(nowMs) >= this.failover.max_switches_per_hour) {
      return {
        ready: false,
        unhealthyForMs,
        remainingMs,
        reason: 'max_switches_exhausted',
      };
    }
    if (remainingMs > 0) {
      return {
        ready: false,
        unhealthyForMs,
        remainingMs,
        reason: 'hysteresis_hold',
      };
    }
    return {
      ready: true,
      unhealthyForMs,
      remainingMs: 0,
      reason: 'primary_unhealthy',
    };
  }

  /**
   * Attempt a failover to nextCandidate. Records the switch if accepted.
   */
  commitSwitch(
    nextUpstreamId: string,
    nowMs = Date.now(),
  ): { ok: boolean; reason: FailoverReasonCode } {
    const check = this.markUnhealthy(nowMs);
    if (check.reason === 'max_switches_exhausted') {
      return { ok: false, reason: 'max_switches_exhausted' };
    }
    if (!check.ready) {
      return { ok: false, reason: 'hysteresis_hold' };
    }
    if (this.currentUpstreamId) {
      this.excluded.add(this.currentUpstreamId);
    }
    this.switchTimestampsMs.push(nowMs);
    this.currentUpstreamId = nextUpstreamId;
    this.unhealthySinceMs = null;
    return { ok: true, reason: 'switched_next' };
  }

  /** Immediate fail at connect time (no hysteresis — connect never established). */
  rejectCurrentAndPick(
    nextUpstreamId: string | undefined,
    nowMs = Date.now(),
  ): { ok: boolean; reason: FailoverReasonCode } {
    if (this.currentUpstreamId) {
      this.excluded.add(this.currentUpstreamId);
    }
    if (!nextUpstreamId) {
      return {
        ok: false,
        reason:
          this.failover.on_exhaust === 'keep_last_best_effort'
            ? 'keep_last_best_effort'
            : 'candidates_exhausted',
      };
    }
    if (this.switchCountLastHour(nowMs) >= this.failover.max_switches_per_hour) {
      return { ok: false, reason: 'max_switches_exhausted' };
    }
    this.switchTimestampsMs.push(nowMs);
    this.currentUpstreamId = nextUpstreamId;
    this.unhealthySinceMs = null;
    return { ok: true, reason: 'switched_secondary' };
  }
}

export function healthAllowsCandidate(
  snap: UpstreamHealthSnapshot | undefined,
  min?: 'ok',
): boolean {
  if (!snap) return !min;
  if (snap.status === 'unreachable') return false;
  return statusMeetsMin(snap.status, min);
}

/**
 * Remote approval gate (graph runtime v2).
 *
 * Bridges the frozen HumanApprovalPrompter contract to a file-backed
 * decision exchange plus an optional notifier, so approvals can be
 * granted from outside the interactive terminal (via `omg graph
 * approvals decide`, and later via notification reply channels).
 *
 * Protocol (all files live inside the contained run directory):
 *   <runDir>/approvals/pending/<activationId>.json    written by the gate
 *   <runDir>/approvals/decisions/<activationId>.json  written by a decider
 *
 * Fail-closed by construction, mirroring createStdinApprovalGate:
 *   - malformed or unknown decisions never resolve a request (the gate
 *     keeps waiting for a well-formed one)
 *   - an expired request resolves to the configured timeout policy
 *     (default: denied)
 *   - decision artifacts carry no trust: the runner records the outcome
 *     in its own journal, so a forged decision file can only flip a
 *     human-approval node, exactly like typing y at the stdin prompt
 */

import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "fs";
import { join } from "path";

import { atomicWriteJsonSync } from "../../lib/atomic-write.js";
import {
  assertSafeContainedFileName,
  readFileNoFollow,
} from "./safe-fs.js";
import { resolveRunDirHandle } from "./run-dir.js";
import type { RunDirHandle } from "./run-dir.js";
import type {
  ApprovalRequest,
  HumanApprovalPrompter,
} from "./types.js";

type Decision = "approved" | "denied";

/** Persisted pending-request artifact (one per activation). */
export interface PendingApprovalRecord {
  readonly run_id: string;
  readonly node_id: string;
  readonly activation_id: string;
  readonly prompt_text: string;
  readonly created_at: string;
}

/** Persisted decision artifact (one per activation). */
export interface ApprovalDecisionRecord {
  readonly decision: Decision;
  readonly decided_by?: string;
  readonly decided_at: string;
}

/** One row surfaced by listPendingApprovals / `omg graph approvals list`. */
export interface PendingApprovalEntry {
  readonly run_id: string;
  readonly activation_id: string;
  readonly node_id: string;
  readonly prompt_text: string;
  readonly created_at: string;
}

export interface RemoteApprovalGateOptions {
  readonly runsRoot: string;
  readonly runId: string;
  /** Poll cadence for decision artifacts (default 2000ms). */
  readonly pollIntervalMs?: number;
  /** Max wait before the timeout policy applies (default: wait forever). */
  readonly timeoutMs?: number;
  /** Resolution for an expired request (default "denied" — fail closed). */
  readonly timeoutPolicy?: Decision;
  /** AbortSignal observed between polls; an aborted wait resolves denied. */
  readonly signal?: AbortSignal;
  /** Best-effort delivery hook (notification channels). Errors are swallowed. */
  readonly notifier?: (
    request: ApprovalRequest,
    record: PendingApprovalRecord,
  ) => void | Promise<void>;
  /** Injectable clock + sleep for tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const APPROVALS_DIR = "approvals";
const PENDING_DIR = "pending";
const DECISIONS_DIR = "decisions";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_POLICY: Decision = "denied";

const DECISION_VALUES: ReadonlySet<string> = new Set(["approved", "denied"]);

function pendingDirPath(runDir: RunDirHandle): string {
  return join(runDir.path, APPROVALS_DIR, PENDING_DIR);
}

function decisionsDirPath(runDir: RunDirHandle): string {
  return join(runDir.path, APPROVALS_DIR, DECISIONS_DIR);
}

function artifactFileName(activationId: string): string {
  // Activation ids come from the sealed descriptor and are therefore
  // untrusted; refuse traversal-shaped or normalization-ambiguous values.
  assertSafeContainedFileName(activationId);
  return `${activationId}.json`;
}

/**
 * Parse one decision artifact. Returns null for anything that is not a
 * well-formed decision — malformed files are ignored, never trusted.
 */
export function parseDecisionArtifact(raw: string): ApprovalDecisionRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (!DECISION_VALUES.has(candidate.decision as string)) return null;
  if (
    candidate.decided_at !== undefined &&
    typeof candidate.decided_at !== "string"
  ) {
    return null;
  }
  if (
    candidate.decided_by !== undefined &&
    typeof candidate.decided_by !== "string"
  ) {
    return null;
  }
  return {
    decision: candidate.decision as Decision,
    decided_at:
      typeof candidate.decided_at === "string"
        ? candidate.decided_at
        : new Date().toISOString(),
    ...(typeof candidate.decided_by === "string"
      ? { decided_by: candidate.decided_by }
      : {}),
  };
}

function readDecisionFile(
  runDir: RunDirHandle,
  activationId: string,
): ApprovalDecisionRecord | null {
  const filePath = join(decisionsDirPath(runDir), artifactFileName(activationId));
  if (!existsSync(filePath)) return null;
  try {
    return parseDecisionArtifact(readFileNoFollow(filePath));
  } catch {
    return null;
  }
}

/**
 * Create a remote approval gate. Each prompt persists a pending artifact,
 * fires the best-effort notifier once, then polls for a decision artifact
 * until one resolves or the optional timeout expires.
 */
export function createRemoteApprovalGate(
  options: RemoteApprovalGateOptions,
): HumanApprovalPrompter {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutPolicy = options.timeoutPolicy ?? DEFAULT_TIMEOUT_POLICY;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async prompt(request: ApprovalRequest): Promise<Decision> {
      const runDir = resolveRunDirHandle(options.runsRoot, options.runId);
      assertSafeContainedFileName(request.activation_id);
      assertSafeContainedFileName(request.node_id);

      const pendingDir = pendingDirPath(runDir);
      const record: PendingApprovalRecord = {
        run_id: request.run_id,
        node_id: request.node_id,
        activation_id: request.activation_id,
        prompt_text: request.prompt_text,
        created_at: new Date(now()).toISOString(),
      };
      mkdirSync(pendingDir, { recursive: true });
      atomicWriteJsonSync(
        join(pendingDir, artifactFileName(request.activation_id)),
        record,
      );

      if (options.notifier !== undefined) {
        try {
          await options.notifier(request, record);
        } catch {
          // Notification delivery is best-effort; the decision file is the
          // source of truth and the gate must never fail on notifier errors.
        }
      }

      const startedAtMs = now();
      for (;;) {
        const decision = readDecisionFile(runDir, request.activation_id);
        if (decision !== null) {
          // Resolution observed: retire the pending artifact (best-effort).
          try {
            unlinkSync(join(pendingDir, artifactFileName(request.activation_id)));
          } catch {
            // A missing pending file is fine; leaving one behind only
            // affects `approvals list` freshness, never run correctness.
          }
          return decision.decision;
        }
        // An aborted/killed run must not hang in the poll loop: resolve
        // denied (fail closed) and let the runner's fence settle ownership.
        if (options.signal?.aborted === true) {
          try {
            unlinkSync(join(pendingDir, artifactFileName(request.activation_id)));
          } catch {
            // Same best-effort retirement as above.
          }
          return "denied";
        }
        if (
          options.timeoutMs !== undefined &&
          now() - startedAtMs >= options.timeoutMs
        ) {
          try {
            unlinkSync(join(pendingDir, artifactFileName(request.activation_id)));
          } catch {
            // Same best-effort retirement as above.
          }
          return timeoutPolicy;
        }
        await sleep(pollIntervalMs);
      }
    },
  };
}

/**
 * List unresolved approval requests across all runs in a runs root.
 * Read-only: runs with malformed or unreadable artifacts are skipped.
 */
export function listPendingApprovals(runsRoot: string): PendingApprovalEntry[] {
  let runIds: string[];
  try {
    runIds = readdirSync(runsRoot);
  } catch {
    return [];
  }

  const entries: PendingApprovalEntry[] = [];
  for (const runId of runIds) {
    const pendingDir = join(runsRoot, runId, APPROVALS_DIR, PENDING_DIR);
    if (!existsSync(pendingDir)) continue;
    let files: string[];
    try {
      files = readdirSync(pendingDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileNoFollow(join(pendingDir, file));
        const parsed = JSON.parse(raw) as Partial<PendingApprovalRecord>;
        if (
          typeof parsed.run_id !== "string" ||
          typeof parsed.node_id !== "string" ||
          typeof parsed.activation_id !== "string" ||
          typeof parsed.prompt_text !== "string" ||
          typeof parsed.created_at !== "string"
        ) {
          continue;
        }
        entries.push({
          run_id: parsed.run_id,
          activation_id: parsed.activation_id,
          node_id: parsed.node_id,
          prompt_text: parsed.prompt_text,
          created_at: parsed.created_at,
        });
      } catch {
        continue;
      }
    }
  }
  return entries.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Persist one decision artifact on behalf of a human decider (the
 * `omg graph approvals decide` CLI path). Fails closed on malformed ids
 * and on unknown runs: the run directory must already exist (the gate
 * creates it), so a typo'd run id is an error rather than a decision
 * written into a directory nobody polls.
 */
export function writeApprovalDecision(
  runsRoot: string,
  runId: string,
  activationId: string,
  decision: Decision,
  decidedBy?: string,
): ApprovalDecisionRecord {
  assertSafeContainedFileName(runId);
  assertSafeContainedFileName(activationId);
  if (!existsSync(join(runsRoot, runId))) {
    throw new Error(`unknown run "${runId}" (no run directory under ${runsRoot})`);
  }
  const runDir = resolveRunDirHandle(runsRoot, runId);
  const decisionsDir = decisionsDirPath(runDir);
  mkdirSync(decisionsDir, { recursive: true });

  const record: ApprovalDecisionRecord = {
    decision,
    decided_at: new Date().toISOString(),
    ...(decidedBy !== undefined ? { decided_by: decidedBy } : {}),
  };
  atomicWriteJsonSync(
    join(decisionsDir, artifactFileName(activationId)),
    record,
  );
  return record;
}

/** Remove a run's pending artifact directory (best-effort housekeeping). */
export function prunePendingApprovals(runsRoot: string, runId: string): void {
  try {
    assertSafeContainedFileName(runId);
    rmSync(join(runsRoot, runId, APPROVALS_DIR, PENDING_DIR), {
      recursive: true,
      force: true,
    });
  } catch {
    // Housekeeping only; never surface.
  }
}

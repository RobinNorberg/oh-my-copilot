/**
 * Agent node executor.
 *
 * Runs one GraphAgentNode attempt through the Claude Agent SDK. The SDK is an
 * optional peer dependency that oh-my-copilot does not install: it is
 * lazy-imported inside execute() only when no queryImpl is injected, and a
 * missing install fails the node with an install hint. Unit tests inject
 * fakes and never require network access; the injectable queryImpl mirrors
 * `query` from `@anthropic-ai/claude-agent-sdk`.
 */

import { childEnv } from "../../../utils/windows-search.js";
import type {
  NodeExecutionContext,
  NodeExecutionOutput,
  NodeExecutor,
} from "../types.js";
import type { GraphEvidenceReference } from "../../types.js";
import {
  buildAgentEnv,
  idempotencyKeyFor,
  READ_ONLY_AGENT_TOOLS,
} from "./authority.js";

/** Injectable SDK surface: the real `query` or a test fake. */
export type AgentQueryImpl = (
  options: unknown,
) => AsyncIterable<unknown> | Promise<unknown>;

/** Optional peer; a variable specifier keeps bundlers and tsc from resolving it. */
const CLAUDE_AGENT_SDK = "@anthropic-ai/claude-agent-sdk";

/** The slice of the SDK's `canUseTool` permission callback this executor uses. */
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean }
>;

async function loadSdkQuery(): Promise<AgentQueryImpl> {
  let sdk: { query?: unknown };
  try {
    sdk = (await import(CLAUDE_AGENT_SDK)) as { query?: unknown };
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    // Only the SDK itself missing gets the install hint; a broken install
    // (a missing transitive module) surfaces its own error. Node reports
    // ERR_MODULE_NOT_FOUND; vite-based runners say "Could not resolve".
    const notFound =
      code === "ERR_MODULE_NOT_FOUND" ||
      code === "MODULE_NOT_FOUND" ||
      /Cannot find (package|module)|Could not resolve/.test(message);
    if (
      notFound &&
      (message.includes(`'${CLAUDE_AGENT_SDK}'`) ||
        message.includes(`"${CLAUDE_AGENT_SDK}"`))
    ) {
      throw new Error(
        `graph agent nodes need the optional peer dependency ${CLAUDE_AGENT_SDK}; ` +
          `install it next to oh-my-copilot (npm install ${CLAUDE_AGENT_SDK})`,
      );
    }
    throw error;
  }
  if (typeof sdk.query !== "function") {
    throw new Error(`${CLAUDE_AGENT_SDK} does not export query()`);
  }
  return sdk.query as AgentQueryImpl;
}

const SUMMARY_LIMIT = 2000;

class AgentTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timeout after ${timeoutMs}ms`);
    this.name = "AgentTimeoutError";
  }
}

class AgentRunError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    isRecord(value) &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

function stopQuery(value: unknown): void {
  if (!isRecord(value)) return;
  const interrupt = value.interrupt;
  if (typeof interrupt === "function") {
    void Promise.resolve(interrupt.call(value)).catch(() => {});
  }
  const returnMethod = value.return;
  if (typeof returnMethod === "function") {
    void Promise.resolve(returnMethod.call(value)).catch(() => {});
  }
}

/** Text of an assistant message's text blocks, or null when not one. */
function assistantText(message: unknown): string | null {
  if (!isRecord(message) || message.type !== "assistant") return null;
  const inner = message.message;
  if (!isRecord(inner) || !Array.isArray(inner.content)) return null;
  const parts: string[] = [];
  for (const block of inner.content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

/** Terminal SDK result message: ok with final text, failed with reason, or null. */
function sdkResult(
  message: unknown,
): { ok: true; text: string } | { ok: false; reason: string } | null {
  if (!isRecord(message) || message.type !== "result") return null;
  if (message.subtype !== "success" || message.is_error === true) {
    const reason =
      typeof message.subtype === "string" ? message.subtype : "error";
    return { ok: false, reason };
  }
  return { ok: true, text: typeof message.result === "string" ? message.result : "" };
}

function truncate(text: string): string {
  return text.length > SUMMARY_LIMIT ? text.slice(0, SUMMARY_LIMIT) : text;
}

export class AgentNodeExecutor implements NodeExecutor {
  readonly kinds = ["agent"] as const;

  constructor(private readonly queryImpl?: AgentQueryImpl) {}

  async execute(context: NodeExecutionContext): Promise<NodeExecutionOutput> {
    const node = context.node;
    if (node.kind !== "agent") {
      return failed(context, `unsupported node kind ${node.kind}`);
    }
    if (node.effect_policy.policy === "reconcile") {
      return failed(context, "reconcile policy requires a custom executor");
    }

    const prompt = `${node.instructions}\n\nGoal: ${context.descriptor.goal}`;
    const abortController = new AbortController();
    const idempotencyKey = idempotencyKeyFor(context);
    let activeQuery: unknown;
    let timeoutTriggered = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        timeoutTriggered = true;
        abortController.abort();
        stopQuery(activeQuery);
        reject(new AgentTimeoutError(node.timeout_ms));
      }, node.timeout_ms);
    });

    try {
      const queryFn: AgentQueryImpl = this.queryImpl ?? (await loadSdkQuery());

      const canUseTool: CanUseTool = async (
        toolName,
        input,
      ) => {
        if (
          (READ_ONLY_AGENT_TOOLS as readonly string[]).includes(toolName)
        ) {
          return { behavior: "allow", updatedInput: input };
        }
        return {
          behavior: "deny",
          message: "Graph agent execution permits read-only tools only",
          interrupt: true,
        };
      };

      const collect = async (): Promise<string> => {
        const returned = queryFn({
          prompt,
          options: {
            abortController,
            cwd: process.cwd(),
            env: childEnv(buildAgentEnv(idempotencyKey)),
            tools: [...READ_ONLY_AGENT_TOOLS],
            permissionMode: "dontAsk",
            canUseTool,
            additionalDirectories: [],
            persistSession: false,
          },
        });
        activeQuery = returned;
        if (timeoutTriggered) stopQuery(activeQuery);
        if (!isAsyncIterable(returned)) {
          const value = await returned;
          const final = sdkResult(value);
          if (final) {
            if (!final.ok) throw new AgentRunError(`sdk result error: ${final.reason}`);
            return final.text;
          }
          return assistantText(value) ?? "";
        }
        // Accumulate every assistant text chunk: multi-message streams must
        // land their full output in output_summary, not just the last chunk.
        const parts: string[] = [];
        for await (const message of returned) {
          const final = sdkResult(message);
          if (final) {
            if (!final.ok) throw new AgentRunError(`sdk result error: ${final.reason}`);
            return final.text;
          }
          const chunk = assistantText(message);
          if (chunk !== null && chunk.length > 0) {
            parts.push(chunk);
          }
        }
        return parts.join("\n");
      };

      const work = collect();
      try {
        const text = await Promise.race([work, timedOut]);
        if (text.trim().length === 0) {
          return failed(context, "empty response");
        }
        return {
          outcome: "succeeded",
          output_summary: truncate(text),
          evidence_refs: evidenceRefs(context),
          ...(idempotencyKey === undefined
            ? {}
            : { external_idempotency_key: idempotencyKey }),
        };
      } finally {
        work.catch(() => {}); // loser of the race may still reject post-abort
      }
    } catch (error) {
      if (error instanceof AgentTimeoutError) {
        return failed(context, error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      return failed(context, `error: ${truncate(message)}`);
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    }
  }
}

function evidenceRefs(
  context: NodeExecutionContext,
): readonly GraphEvidenceReference[] {
  return [
    {
      kind: "url",
      ref: `agent://${context.activation_id}`,
      summary: `agent attempt ${context.attempt_id}`,
    },
  ];
}

function failed(context: NodeExecutionContext, summary: string): NodeExecutionOutput {
  return {
    outcome: "failed",
    output_summary: summary,
    evidence_refs: evidenceRefs(context),
  };
}

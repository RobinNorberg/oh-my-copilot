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
import type { NodeExecutionContext, NodeExecutionOutput, NodeExecutor } from "../types.js";
/** Injectable SDK surface: the real `query` or a test fake. */
export type AgentQueryImpl = (options: unknown) => AsyncIterable<unknown> | Promise<unknown>;
export declare class AgentNodeExecutor implements NodeExecutor {
    private readonly queryImpl?;
    readonly kinds: readonly ["agent"];
    constructor(queryImpl?: AgentQueryImpl | undefined);
    execute(context: NodeExecutionContext): Promise<NodeExecutionOutput>;
}
//# sourceMappingURL=agent.d.ts.map
import { describe, expect, it } from 'vitest';
import { formatWorkerPermissionLines } from '../runtime-v2.js';
import type { CliAgentType } from '../model-contract.js';
import type { WorkerLaunchDescriptor } from '../types.js';

function launch(agentType: CliAgentType, binary: string, args: string[], model: string | null = null) {
  const descriptor: WorkerLaunchDescriptor = { schema_version: 1, provider: agentType, model, binary, args };
  return { agentType, descriptor };
}

describe('formatWorkerPermissionLines', () => {
  it('reports per-provider counts, copilot deny lists, and NOT enforced for other providers', () => {
    const copilotArgs = [
      '--allow-all-tools', '--allow-all-paths', '--allow-all-urls', '--no-ask-user',
      '--model', 'claude-opus-4.8',
      '--deny-tool=shell(git push)',
      // resolveWorkerPermissionFlags emits the bare pattern (copilot --help: --deny-url=https://host).
      '--deny-url=https://*.internal.example',
    ];
    const lines = formatWorkerPermissionLines([
      launch('copilot', '/usr/bin/copilot', copilotArgs, 'claude-opus-4.8'),
      launch('codex', '/usr/bin/codex', ['--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5.5']),
      launch('copilot', '/usr/bin/copilot', copilotArgs, 'claude-opus-4.8'),
      launch('claude', '/usr/bin/claude', ['--dangerously-skip-permissions', '-p', 'do the task']),
      launch('copilot', '/usr/bin/copilot', copilotArgs, 'claude-opus-4.8'),
    ]);

    expect(lines).toEqual([
      '[omg team] copilot workers (x3): --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user; '
        + 'deny: shell(git push), url(https://*.internal.example)',
      '[omg team] codex workers (x1): permissions.workerDenyTools NOT enforced '
        + '(vendor flags: --dangerously-bypass-approvals-and-sandbox)',
      '[omg team] claude workers (x1): permissions.workerDenyTools NOT enforced '
        + '(vendor flags: --dangerously-skip-permissions)',
    ]);
  });

  it('prints (none) for a copilot worker without deny flags and a provider without vendor flags', () => {
    expect(formatWorkerPermissionLines([
      launch('copilot', '/usr/bin/copilot', ['--allow-all-tools']),
      launch('gemini', '/usr/bin/gemini', ['--model', 'gemini-3']),
    ])).toEqual([
      '[omg team] copilot workers (x1): --allow-all-tools; deny: (none)',
      '[omg team] gemini workers (x1): permissions.workerDenyTools NOT enforced (vendor flags: (none))',
    ]);
  });
});

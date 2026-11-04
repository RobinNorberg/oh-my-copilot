/**
 * The team skill is served unchanged to Claude Code and GitHub Copilot CLI.
 * Its Copilot path must drive `omg team`, not Claude Code's implicit agent
 * team, and every `omg team` command and flag it names must exist.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTeamArgs } from '../../src/cli/commands/team.js';

const skill = readFileSync(new URL('../../skills/team/SKILL.md', import.meta.url), 'utf8');
const teamCli = readFileSync(new URL('../../src/cli/commands/team.ts', import.meta.url), 'utf8');

const start = skill.indexOf('## On GitHub Copilot CLI');
const end = skill.indexOf('\n## ', start + 1);
const copilot = skill.slice(start, end);

describe('team skill Copilot CLI path', () => {
  it('routes Copilot CLI to its own section before any Claude Code team setup', () => {
    expect(start).toBeGreaterThan(0);
    const route = skill.indexOf('[On GitHub Copilot CLI](#on-github-copilot-cli)');
    expect(route).toBeGreaterThan(0);
    expect(route).toBeLessThan(skill.search(/TeamCreate|CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/));
  });

  it('does not instruct Claude Code agent-team setup', () => {
    for (const claudeOnly of [/CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/, /TeamCreate|TeamDelete/, /teammateMode/, /state_write\(/]) {
      expect(copilot).not.toMatch(claudeOnly);
    }
  });

  it('gates the Claude Code team steps', () => {
    for (const heading of ['## Architecture', '### Phase 3: Initialize Team State', '### Phase 5: Spawn Teammates', '### Shutdown Protocol (BLOCKING)']) {
      const at = skill.indexOf(heading);
      expect(at).toBeGreaterThan(end);
      expect(skill.slice(at, at + heading.length + 120)).toContain('Claude Code host only');
    }
  });

  it('covers the omg team lifecycle and the Warp rule', () => {
    for (const command of ['omg team status', 'omg team shutdown', '--transport sdk', 'Warp']) {
      expect(copilot).toContain(command);
    }
  });

  it('names only flags that omg team parses', () => {
    const flags = copilot.replace(/`npm i [^`]*`/g, '').match(/--[a-z][a-z-]*/g) ?? [];
    expect(flags.length).toBeGreaterThan(0);
    for (const flag of new Set(flags)) expect(teamCli).toContain(`'${flag}'`);
  });

  it('gives start examples that parse', () => {
    const examples = copilot.match(/```bash\n([\s\S]*?)\n\s*```/)?.[1].split('\n') ?? [];
    expect(examples.length).toBeGreaterThan(0);
    for (const line of examples) {
      const tokens = [...line.replace(/\s+#.*$/, '').matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
      expect(tokens.slice(0, 2)).toEqual(['omg', 'team']);
      expect(() => parseTeamArgs(tokens.slice(2), 'copilot')).not.toThrow();
    }
  });
});

/**
 * The team skill is served unchanged to Claude Code and GitHub Copilot CLI.
 * Its Copilot path must drive `omg team`, not Claude Code's implicit agent
 * team, and every `omg team` command and flag it names must exist.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseTeamArgs } from '../../src/cli/commands/team.js';

const skill = readFileSync(new URL('../../skills/team/SKILL.md', import.meta.url), 'utf8');
const teamCli = readFileSync(new URL('../../src/cli/commands/team.ts', import.meta.url), 'utf8');

const start = skill.indexOf('## On GitHub Copilot CLI');
const end = skill.indexOf('\n## ', start + 1);
const copilot = skill.slice(start, end);

// The source of `omg team <sub>`'s branch in teamCommand.
function subcommandHandler(sub: string): string {
  const at = teamCli.indexOf(`if (subcommand === '${sub}') {`);
  expect(at).toBeGreaterThan(0);
  return teamCli.slice(at, teamCli.indexOf('\n  }\n', at));
}

const startExamples = (copilot.match(/```bash\n([\s\S]*?)\n\s*```/)?.[1].split('\n') ?? []).map((line) => {
  const [command, comment = ''] = line.split(/\s+#\s*/, 2);
  const tokens = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  return { tokens, comment };
});

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

  it('gates every section after the Copilot section as Claude Code only', () => {
    expect(copilot).toContain('Every section after this one, from Architecture to the end of the file, is Claude Code only');
    const lines = skill.slice(end + 1).split('\n');
    let fenced = false;
    let headings = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*```/.test(lines[i])) fenced = !fenced;
      if (fenced || !lines[i].startsWith('## ')) continue;
      headings++;
      const next = lines.slice(i + 1).find((line) => line.trim() !== '');
      expect(next, lines[i]).toContain('Claude Code host only');
    }
    expect(headings).toBeGreaterThan(10);
    for (const heading of ['### Phase 3: Initialize Team State', '### Phase 5: Spawn Teammates', '### Shutdown Protocol (BLOCKING)']) {
      const at = skill.indexOf(heading);
      expect(at).toBeGreaterThan(end);
      expect(skill.slice(at, at + heading.length + 120)).toContain('Claude Code host only');
    }
  });

  it('covers the omg team lifecycle, cancel and the Warp rule', () => {
    for (const text of ['omg team status', 'omg team shutdown', '`omg team shutdown <team-name> --force`', '--transport sdk', 'Warp', '`TERM_PROGRAM` is `WarpTerminal`']) {
      expect(copilot).toContain(text);
    }
  });

  it('names status and shutdown flags that their handlers read', () => {
    let checked = 0;
    for (const [, sub, rest] of copilot.matchAll(/`omg team (status|shutdown)\b([^`]*)`/g)) {
      for (const flag of rest.match(/--[a-z][a-z-]*/g) ?? []) {
        expect(subcommandHandler(sub), `omg team ${sub} ${flag}`).toContain(`'${flag}'`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('names only start flags that parseTeamArgs consumes', () => {
    expect(copilot).toContain('`omg team --help`');
    expect(teamCli).toMatch(/HELP_TOKENS = new Set\(\[[^\]]*'--help'/);
    const prose = copilot
      .replace(/`npm i [^`]*`/g, '')
      .replace(/`omg team (status|shutdown|--help)\b[^`]*`/g, '');
    const flags = new Set(prose.match(/--[a-z][a-z-]*/g) ?? []);
    expect(flags.size).toBeGreaterThan(0);
    for (const flag of flags) {
      // An unconsumed flag stays positional next to --task and is rejected.
      const args = flag === '--task' ? ['--task', 'review'] : [flag, ...(flag === '--transport' ? ['sdk'] : []), '--task', 'review'];
      expect(() => parseTeamArgs(args, 'copilot'), flag).not.toThrow();
      expect(parseTeamArgs(args, 'copilot').task, flag).toBe('review');
    }
    expect(parseTeamArgs(['--transport', 'tmux', '--task', 'review'], 'copilot').transport).toBe('pane');
    expect(parseTeamArgs(['--transport', 'psmux', '--task', 'review'], 'copilot').transport).toBe('pane');
  });

  it('gives start examples whose worker counts match the parser', () => {
    expect(startExamples.length).toBeGreaterThan(0);
    for (const { tokens, comment } of startExamples) {
      expect(tokens.slice(0, 2)).toEqual(['omg', 'team']);
      const parsed = parseTeamArgs(tokens.slice(2), 'copilot');
      const count = comment.match(/^(\d+) workers/)?.[1];
      if (count) expect(parsed.workerCount, tokens.join(' ')).toBe(Number(count));
    }
    expect(startExamples.filter(({ comment }) => /^\d+ workers/.test(comment)).length).toBeGreaterThanOrEqual(3);
  });

  it('pins the start claims the skill makes', () => {
    const defaultCount = copilot.match(/Without `N:` the team gets (\d+) workers/)?.[1];
    expect(parseTeamArgs(['refactor the auth module'], 'copilot').workerCount).toBe(Number(defaultCount));

    expect(copilot).toContain('Any other word, such as `executor` or `debugger`, is a role for workers of the host CLI');
    // A role-only spec takes the host CLI (getHostCliType), not team.ops.defaultAgentType.
    vi.stubEnv('COPILOT_CLI', '1');
    try {
      const roleOnly = parseTeamArgs(['3:executor', 'fix the build'], 'claude');
      expect(roleOnly.workerSpecs).toEqual(Array.from({ length: 3 }, () => ({ agentType: 'copilot', role: 'executor' })));
    } finally {
      vi.unstubAllEnvs();
    }

    expect(copilot).toContain('a one-word task needs --task');
    expect(parseTeamArgs(['--task', 'review'], 'copilot').task).toBe('review');
    expect(() => parseTeamArgs(['review'], 'copilot')).toThrow(/--task/);
  });
});

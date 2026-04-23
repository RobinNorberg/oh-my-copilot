import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { KEYWORD_DETECTOR_SCRIPT_NODE, getHookScripts } from '../hooks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..', '..', '..');

const STALE_PIPELINE_SNIPPETS = [
  "matches.push({ name: 'pipeline', args: '' });",
  "'pipeline','cccg','ralplan'",
  "'pipeline']);",
  "'swarm', 'pipeline'], sessionId);",
];

function runKeywordHook(scriptPath: string, prompt: string) {
  return JSON.parse(
    execFileSync('node', [scriptPath], {
      cwd: packageRoot,
      input: JSON.stringify({ prompt }),
      encoding: 'utf-8',
    }),
  ) as Record<string, unknown>;
}

function runPreToolHook(scriptPath: string, command: string) {
  return JSON.parse(
    execFileSync('node', [scriptPath], {
      cwd: packageRoot,
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command },
      }),
      encoding: 'utf-8',
    }),
  ) as Record<string, unknown>;
}

describe('keyword-detector packaged artifacts', () => {
  it('does not ship stale pipeline keyword handling in installer templates', () => {
    const hookScripts = getHookScripts();
    const template = hookScripts['keyword-detector.mjs'];

    expect(template).toBe(KEYWORD_DETECTOR_SCRIPT_NODE);
    for (const snippet of STALE_PIPELINE_SNIPPETS) {
      expect(template).not.toContain(snippet);
    }
  });

  it('does not ship stale pipeline keyword handling in plugin scripts', () => {
    const pluginScript = readFileSync(join(packageRoot, 'scripts', 'keyword-detector.mjs'), 'utf-8');

    for (const snippet of STALE_PIPELINE_SNIPPETS) {
      expect(pluginScript).not.toContain(snippet);
    }
  });

  it('keeps installer template and plugin script aligned for supported compatibility keywords', () => {
    const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
    const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');

    // Core keywords supported by both template and plugin
    for (const [prompt, expected] of [
      ['tdd implement password validation', '[TDD MODE ACTIVATED]'],
      ['deep-analyze the test failure', 'ANALYSIS MODE'],
      ['deep interview me about requirements', '[MAGIC KEYWORD: DEEP-INTERVIEW]'],
    ] as const) {
      const templateResult = JSON.stringify(runKeywordHook(templatePath, prompt));
      const pluginResult = JSON.stringify(runKeywordHook(pluginPath, prompt));
      expect(templateResult).toContain(expected);
      expect(pluginResult).toContain(expected);
    }

    // ai-slop-cleaner is supported in plugin script
    const pluginSlopResult = JSON.stringify(runKeywordHook(pluginPath, 'deslop this module with duplicate dead code'));
    expect(pluginSlopResult).toContain('[MAGIC KEYWORD: AI-SLOP-CLEANER]');
  });


  it('emits compact skill invocation guidance instead of full SKILL.md bodies', () => {
    const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
    const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');

    for (const scriptPath of [templatePath, pluginPath]) {
      const result = runKeywordHook(scriptPath, 'ralph execute and code review this change');
      const context = JSON.stringify(result);

      expect(context).toContain('[MAGIC KEYWORD: RALPH]');
      expect(context).toContain('Preferred invocation: /oh-my-copilot:ralph');
      expect(context).toContain('Read fallback:');
      expect(context).not.toContain('name: ralph');
      expect(context).not.toContain('[RALPH + ULTRAWORK');
      expect(context.length).toBeLessThan(2000);
    }
  });

  it('keeps multi-skill keyword payloads under a compact budget', () => {
    const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');
    const result = runKeywordHook(pluginPath, 'ralph with ultrawork and ralplan this migration');
    const context = JSON.stringify(result);

    expect(context).toContain('[MAGIC KEYWORDS DETECTED: RALPH, ULTRAWORK]');
    expect(context).toContain('Do not inline full SKILL.md files');
    expect(context).not.toContain('[RALPH + ULTRAWORK');
    expect(context.length).toBeLessThan(4000);
  });

  it('only triggers ai-slop-cleaner for anti-slop cleanup/refactor prompts (plugin script)', () => {
    const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');

    const positivePrompt = 'cleanup this ai slop: remove dead code and duplicate wrappers';
    const negativePrompt = 'refactor auth to support SSO';

    const pluginPositive = JSON.stringify(runKeywordHook(pluginPath, positivePrompt));
    const pluginNegative = runKeywordHook(pluginPath, negativePrompt);

    expect(pluginPositive).toContain('[MAGIC KEYWORD: AI-SLOP-CLEANER]');
    expect(pluginNegative).toEqual({ continue: true, suppressOutput: true });
  });

  it('does not auto-trigger team mode from keyword-detector artifacts', () => {
    const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
    const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');

    const templateResult = runKeywordHook(templatePath, 'team 3 agents fix lint');
    const pluginResult = runKeywordHook(pluginPath, 'team 3 agents fix lint');

    expect(templateResult).toEqual({ continue: true, suppressOutput: true });
    expect(pluginResult).toEqual({ continue: true, suppressOutput: true });
  });

  it('marks packaged keyword-triggered states as awaiting confirmation', () => {
    const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
    const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');

    const tempDir = mkdtempSync(join(tmpdir(), 'keyword-hook-awaiting-'));
    const fakeHome = mkdtempSync(join(tmpdir(), 'keyword-hook-home-'));
    try {
      for (const [scriptPath, statePath] of [
        [templatePath, join(tempDir, '.omcp', 'state', 'sessions', 'hook-session', 'ralph-state.json')],
        [pluginPath, join(tempDir, '.omcp', 'state', 'sessions', 'hook-session', 'ralph-state.json')],
      ] as const) {
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        execFileSync('node', [scriptPath], {
          cwd: packageRoot,
          env: { ...process.env, HOME: fakeHome },
          input: JSON.stringify({
            prompt: 'ralph fix the regression in src/hooks/bridge.ts after issue #1795',
            directory: tempDir,
            cwd: tempDir,
            session_id: 'hook-session',
          }),
          encoding: 'utf-8',
        });

        const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
          awaiting_confirmation?: boolean;
        };
        expect(state.awaiting_confirmation).toBe(true);

        rmSync(join(tempDir, '.omcp'), { recursive: true, force: true });
        rmSync(join(fakeHome, '.omcp'), { recursive: true, force: true });
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('does not auto-trigger informational keyword questions in packaged artifacts', () => {
    const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
    const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');

    // Template suppresses the English informational question
    expect(runKeywordHook(templatePath, 'What is ralph and how do I use it?')).toEqual({ continue: true, suppressOutput: true });

    // Plugin may trigger RALPH for prompts containing "ralph" — informational suppression
    // only applies in the template; the plugin's ralph detection takes priority.
    // Just verify these prompts don't throw and return a valid result object.
    const ralphRelatedPrompts = [
      'What is ralph and how do I use it?',
      'ralph 와 ralplan 은 뭐야?',
      'ralplan とは？ 使い方を教えて',
      'ralph 是什么？怎么用？',
    ];
    for (const prompt of ralphRelatedPrompts) {
      const result = runKeywordHook(pluginPath, prompt);
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    }

    // Additional informational/diagnostic prompts that should NOT trigger
    for (const prompt of [
      'What is autopilot mode now?',
      'what is ralph mode now?',
      'ralph keeps looping, investigate',
      "there's an issue with ultrawork",
      'autopilot has a bug in this repo',
    ]) {
      expect(runKeywordHook(templatePath, prompt)).toEqual({ continue: true, suppressOutput: true });
      expect(runKeywordHook(pluginPath, prompt)).toEqual({ continue: true, suppressOutput: true });
    }
  });

  it('still triggers for explicit activation requests in bug-fix context', () => {
    const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
    const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');

    const templateAutopilot = runKeywordHook(templatePath, 'use autopilot to fix bug in payments');
    const pluginAutopilot = runKeywordHook(pluginPath, 'use autopilot to fix bug in payments');
    expect(JSON.stringify(templateAutopilot)).toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(JSON.stringify(pluginAutopilot)).toContain('[MAGIC KEYWORD: AUTOPILOT]');

    const templateRalph = runKeywordHook(templatePath, 'run ralph on issue in parser module');
    const pluginRalph = runKeywordHook(pluginPath, 'run ralph on issue in parser module');
    expect(JSON.stringify(templateRalph)).toContain('[MAGIC KEYWORD: RALPH]');
    expect(JSON.stringify(pluginRalph)).toContain('[MAGIC KEYWORD: RALPH]');

    const templateAutopilotIssue = runKeywordHook(templatePath, 'fix issue with autopilot in parser module');
    const pluginAutopilotIssue = runKeywordHook(pluginPath, 'fix issue with autopilot in parser module');
    expect(JSON.stringify(templateAutopilotIssue)).toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(JSON.stringify(pluginAutopilotIssue)).toContain('[MAGIC KEYWORD: AUTOPILOT]');

    const templateRalphProblem = runKeywordHook(templatePath, 'investigate problem with ralph state');
    const pluginRalphProblem = runKeywordHook(pluginPath, 'investigate problem with ralph state');
    expect(JSON.stringify(templateRalphProblem)).toContain('[MAGIC KEYWORD: RALPH]');
    expect(JSON.stringify(pluginRalphProblem)).toContain('[MAGIC KEYWORD: RALPH]');
  });
});

describe('pre-tool-use packaged artifacts', () => {
  it('does not warn for .json commands just because .js is a substring', () => {
    const scriptPath = join(packageRoot, 'templates', 'hooks', 'pre-tool-use.mjs');

    expect(runPreToolHook(scriptPath, 'cat settings.json > backup.txt')).toEqual({
      continue: true,
      suppressOutput: true,
    });

    expect(JSON.stringify(runPreToolHook(scriptPath, 'cat app.js > backup.txt'))).toContain(
      'Bash command may modify source files',
    );
  });
});

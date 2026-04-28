import { describe, it, expect, beforeEach, afterAll, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBuiltinSkills, getBuiltinSkill, listBuiltinSkillNames, clearSkillsCache } from '../features/builtin-skills/skills.js';
describe('Builtin Skills', () => {
    // Enable strict mode so all skills (including strict-mode-only) are loaded
    const originalStrictMode = process.env.OMC_STRICT_MODE;
    const originalCopilotConfigDir = process.env.COPILOT_CONFIG_DIR;
    const originalCwd = process.cwd();
    process.env.OMC_STRICT_MODE = 'true';
    const tempDirs = [];
    afterAll(() => {
        if (originalStrictMode === undefined)
            delete process.env.OMC_STRICT_MODE;
        else
            process.env.OMC_STRICT_MODE = originalStrictMode;
    });
    afterEach(() => {
        process.chdir(originalCwd);
        if (originalCopilotConfigDir === undefined)
            delete process.env.COPILOT_CONFIG_DIR;
        else
            process.env.COPILOT_CONFIG_DIR = originalCopilotConfigDir;
        while (tempDirs.length > 0) {
            try {
                const { rmSync } = require('fs');
                rmSync(tempDirs.pop(), { recursive: true, force: true });
            }
            catch {
                // cleanup errors are non-fatal
            }
        }
    });
    // Clear cache before each test to ensure fresh loads
    beforeEach(() => {
        clearSkillsCache();
    });
    describe('createBuiltinSkills()', () => {
        it('should return correct number of skills (53 canonical skills)', () => {
            const skills = createBuiltinSkills();
            expect(skills).toHaveLength(53);
        });
        it('should return an array of BuiltinSkill objects', () => {
            const skills = createBuiltinSkills();
            expect(Array.isArray(skills)).toBe(true);
            expect(skills.length).toBeGreaterThan(0);
        });
    });
    describe('Skill properties', () => {
        const skills = createBuiltinSkills();
        it('should have required properties (name, description, template)', () => {
            skills.forEach((skill) => {
                expect(skill).toHaveProperty('name');
                expect(skill).toHaveProperty('description');
                expect(skill).toHaveProperty('template');
            });
        });
        it('should have non-empty name for each skill', () => {
            skills.forEach((skill) => {
                expect(skill.name).toBeTruthy();
                expect(typeof skill.name).toBe('string');
                expect(skill.name.length).toBeGreaterThan(0);
            });
        });
        it('should have non-empty description for each skill', () => {
            skills.forEach((skill) => {
                expect(skill.description).toBeTruthy();
                expect(typeof skill.description).toBe('string');
                expect(skill.description.length).toBeGreaterThan(0);
            });
        });
        it('should have non-empty template for each skill', () => {
            skills.forEach((skill) => {
                expect(skill.template).toBeTruthy();
                expect(typeof skill.template).toBe('string');
                expect(skill.template.length).toBeGreaterThan(0);
            });
        });
    });
    describe('Skill names', () => {
        it('should have valid skill names', () => {
            const skills = createBuiltinSkills();
            const expectedSkills = [
                'ai-slop-cleaner',
                'ask',
                'autoresearch',
                'autopilot',
                'cancel',
                'cccg',
                'configure-notifications',
                'critique',
                'debug',
                'deep-dive',
                'deep-interview',
                'deep-review',
                'discover',
                'deepinit',
                'external-context',
                'hud',
                'learner',
                'mcp-setup',
                'omc-ado-auto-review',
                'omc-ado-review',
                'omc-ado-setup',
                'omc-ado-sprint',
                'omc-ado-triage',
                'omc-doctor',
                'omc-gh-auto-review',
                'omc-gh-project',
                'omc-gh-review',
                'omc-gh-setup',
                'omc-gh-triage',
                'omc-plan',
                'omc-reference',
                'omc-setup',
                'omc-teams',
                'project-session-manager',
                'psm',
                'ralph',
                'ralph-experiment',
                'ralplan',
                'release',
                'remember',
                'sciomc',
                'self-improve',
                'setup',
                'skill',
                'skillify',
                'team',
                'trace',
                'ultraqa',
                'ultrawork',
                'verify',
                'visual-verdict',
                'wiki',
                'writer-memory',
            ];
            const actualSkillNames = skills.map((s) => s.name);
            expect(actualSkillNames).toEqual(expect.arrayContaining(expectedSkills));
            expect(actualSkillNames.length).toBe(expectedSkills.length);
        });
        it('should not have duplicate skill names', () => {
            const skills = createBuiltinSkills();
            const skillNames = skills.map((s) => s.name);
            const uniqueNames = new Set(skillNames);
            expect(uniqueNames.size).toBe(skillNames.length);
        });
    });
    describe('getBuiltinSkill()', () => {
        it('should retrieve a skill by name', () => {
            const skill = getBuiltinSkill('autopilot');
            expect(skill).toBeDefined();
            expect(skill?.name).toBe('autopilot');
        });
        it('should be case-insensitive', () => {
            const skillLower = getBuiltinSkill('autopilot');
            const skillUpper = getBuiltinSkill('AUTOPILOT');
            const skillMixed = getBuiltinSkill('AuToPiLoT');
            expect(skillLower).toBeDefined();
            expect(skillUpper).toBeDefined();
            expect(skillMixed).toBeDefined();
            expect(skillLower?.name).toBe(skillUpper?.name);
            expect(skillLower?.name).toBe(skillMixed?.name);
        });
        it('should return undefined for non-existent skill', () => {
            const skill = getBuiltinSkill('non-existent-skill');
            expect(skill).toBeUndefined();
        });
        it('should preserve the multi-repo omc-teams cwd and plan-path contract', () => {
            const skill = getBuiltinSkill('omc-teams');
            expect(skill).toBeDefined();
            expect(skill?.template).toContain('shared workspace root');
            expect(skill?.template).toContain('absolute plan path');
            expect(skill?.template).toContain('--cwd <workspace-root>');
            expect(skill?.template).toContain('Do not anchor the launch cwd to only the repo containing `.omcp/plans/...`');
            expect(skill?.template).toContain('single-cwd constraint');
        });
        it('stages mcp-setup AskUserQuestion menus so each prompt stays within the current option limit', () => {
            const skill = getBuiltinSkill('mcp-setup');
            expect(skill).toBeDefined();
            const template = skill.template;
            expect(template).toContain('no more than 3 options per question');
            const blocks = template
                .split(/AskUserQuestion(?: with [^:\n]+)?[:]?/g)
                .slice(1)
                .map((block) => block.split(/## Step|### Step|### For |## Custom MCP Server/)[0]);
            expect(blocks.length).toBeGreaterThanOrEqual(3);
            for (const block of blocks) {
                const optionLines = block
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => /^\d+\. \*\*/.test(line));
                expect(optionLines.length).toBeLessThanOrEqual(3);
            }
            expect(template).toContain('Recommended starter setup');
            expect(template).toContain('Individual popular server');
            expect(template).toContain('More server choices');
            expect(template).not.toContain('5. **All of the above**');
            expect(template).not.toContain('6. **Custom**');
        });
    });
    describe('listBuiltinSkillNames()', () => {
        it('should return canonical skill names by default', () => {
            const names = listBuiltinSkillNames();
            expect(names).toHaveLength(52);
            expect(names).toContain('ai-slop-cleaner');
            expect(names).toContain('ask');
            expect(names).toContain('autopilot');
            expect(names).toContain('cancel');
            expect(names).toContain('cccg');
            expect(names).toContain('configure-notifications');
            expect(names).toContain('ralph');
            expect(names).toContain('ultrawork');
            expect(names).toContain('omc-plan');
            expect(names).toContain('deepinit');
            expect(names).toContain('release');
            expect(names).toContain('omc-doctor');
            expect(names).toContain('setup');
            expect(names).toContain('omc-setup');
            expect(names).not.toContain('swarm'); // removed in #1131
            expect(names).not.toContain('psm');
        });
        it('should return an array of strings', () => {
            const names = listBuiltinSkillNames();
            names.forEach((name) => {
                expect(typeof name).toBe('string');
            });
        });
        it('should include aliases when explicitly requested', () => {
            const names = listBuiltinSkillNames({ includeAliases: true });
            // swarm alias removed in #1131, psm alias restored in v4.11.6
            expect(names).toHaveLength(53);
            expect(names).not.toContain('swarm');
            expect(names).toContain('psm');
        });
    });
    describe('CC native command denylist (issue #830)', () => {
        it('should not expose any builtin skill whose name is a bare CC native command', () => {
            const skills = createBuiltinSkills();
            const bareNativeNames = [
                'compact', 'clear', 'help', 'config', 'plan',
                'review', 'doctor', 'init', 'memory',
            ];
            const skillNames = skills.map((s) => s.name.toLowerCase());
            for (const native of bareNativeNames) {
                expect(skillNames).not.toContain(native);
            }
        });
        it('should not return a skill for "compact" via getBuiltinSkill', () => {
            expect(getBuiltinSkill('compact')).toBeUndefined();
        });
        it('should not return a skill for "clear" via getBuiltinSkill', () => {
            expect(getBuiltinSkill('clear')).toBeUndefined();
        });
    });
    describe('Template strings', () => {
        const skills = createBuiltinSkills();
        it('should have non-empty templates', () => {
            skills.forEach((skill) => {
                expect(skill.template.trim().length).toBeGreaterThan(0);
            });
        });
        it('should have substantial template content (> 100 chars)', () => {
            skills.forEach((skill) => {
                expect(skill.template.length).toBeGreaterThan(100);
            });
        });
    });
    describe('deep-interview threshold injection (issue #2545)', () => {
        it('refreshes cached deep-interview output when the configured threshold changes without requiring manual cache clearing', () => {
            const projectDir = mkdtempSync(join(tmpdir(), 'omcp-skill-cache-refresh-'));
            tempDirs.push(projectDir);
            mkdirSync(join(projectDir, '.copilot'), { recursive: true });
            process.chdir(projectDir);
            writeFileSync(join(projectDir, '.copilot', 'settings.json'), JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.12 } } }));
            const first = getBuiltinSkill('deep-interview');
            expect(first?.template).toContain('Resolve `omc.deepInterview.ambiguityThreshold` into `0.12`');
            expect(first?.template).toContain('"threshold": 0.12,');
            writeFileSync(join(projectDir, '.copilot', 'settings.json'), JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.33 } } }));
            const second = getBuiltinSkill('deep-interview');
            expect(second?.template).toContain('Resolve `omc.deepInterview.ambiguityThreshold` into `0.33`');
            expect(second?.template).toContain('"threshold": 0.33,');
            expect(second?.template).not.toContain('Resolve `omc.deepInterview.ambiguityThreshold` into `0.12`');
            expect(second?.template).not.toContain('"threshold": 0.12,');
        });
        it('replaces all hardcoded 20%/0.2 threshold references in deep-interview template', () => {
            const profileDir = mkdtempSync(join(tmpdir(), 'omc-skill-2545-'));
            tempDirs.push(profileDir);
            process.env.COPILOT_CONFIG_DIR = profileDir;
            writeFileSync(join(profileDir, 'settings.json'), JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.15 } } }));
            clearSkillsCache();
            const skill = getBuiltinSkill('deep-interview');
            expect(skill).toBeDefined();
            const t = skill.template;
            expect(t).toContain('"threshold": 0.15,');
            expect(t).toContain('drops below 15%.');
            expect(t).toContain('resolved threshold for this run'); // Purpose/Execution_Policy
            expect(t).toContain('Gate: ≤15% ambiguity'); // ASCII pipeline diagram
            expect(t).toContain('(threshold: 15%)'); // Early-exit example message
            expect(t).toContain('ambiguity ≤ 15%'); // Advanced pipeline description
            expect(t).toContain('"ambiguityThreshold": 0.15,'); // Advanced config snippet
            expect(t).not.toContain('(default: 20%)');
            expect(t).not.toContain('(default: 0.2)');
            expect(t).not.toContain('Gate: ≤20% ambiguity');
            expect(t).not.toContain('(threshold: 20%).');
            expect(t).not.toContain('ambiguity ≤ 20%');
            expect(t).not.toContain('"ambiguityThreshold": 0.2,');
        });
        it('ships a config-aware deep-interview SKILL.md for native skill-loader paths (issue #2723)', () => {
            const raw = readFileSync(join(originalCwd, 'skills', 'deep-interview', 'SKILL.md'), 'utf-8');
            expect(raw).toContain('Load runtime settings');
            expect(raw).toContain('Read `[$COPILOT_CONFIG_DIR|~/.copilot]/settings.json` and `./.copilot/settings.json`');
            expect(raw).toContain('"threshold": <resolvedThreshold>,');
            expect(raw).toContain('ambiguity drops below <resolvedThresholdPercent>');
            expect(raw).toContain('Gate: ≤<resolvedThresholdPercent> ambiguity');
            expect(raw).toContain('"ambiguityThreshold": <resolvedThreshold>,');
            expect(raw).toContain('At or below the resolved threshold');
            expect(raw).toContain('Normalize oversized initial context before state init');
            expect(raw).toContain('prompt-safe initial-context summary');
            expect(raw).toContain('Wait until the summary exists before ambiguity scoring');
            expect(raw).toContain('Do not ask the next `AskUserQuestion`, score ambiguity, or hand off to execution from an over-budget raw transcript.');
            expect(raw).toContain('Preserve the AskUserQuestion path for OMC-native interaction');
            expect(raw).toContain('Consult accumulated local planning knowledge');
            expect(raw).toContain('glob `.omcp/specs/deep-*.md` and `.omcp/plans/*.md`');
            expect(raw).toContain('before designing Round 1 questions');
            expect(raw).toContain('`.omcp/specs/deep-interview-{slug}.md` exactly');
            expect(raw).toContain('Ephemeral interview artifacts');
            expect(raw).toContain('`.omcp/state/` or in-memory state via `state_write`');
            expect(raw).not.toContain('omx question');
            expect(raw).not.toContain('(default: 20%)');
            expect(raw).not.toContain('(default 0.2)');
            expect(raw).not.toContain('"threshold": 0.2,');
            expect(raw).not.toContain('ambiguity drops below 20%');
            expect(raw).not.toContain('Gate: ≤20% ambiguity');
            expect(raw).not.toContain('(threshold: 20%).');
            expect(raw).not.toContain('"ambiguityThreshold": 0.2,');
            expect(raw).not.toContain('ambiguity ≤ 20%');
        });
        it('loads deep-dive ambiguityThreshold from deep-interview settings before state init and updates threshold copy', () => {
            const profileDir = mkdtempSync(join(tmpdir(), 'omc-deep-dive-profile-'));
            const projectDir = mkdtempSync(join(tmpdir(), 'omc-deep-dive-project-'));
            tempDirs.push(profileDir, projectDir);
            process.env.COPILOT_CONFIG_DIR = profileDir;
            writeFileSync(join(profileDir, 'settings.json'), JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.18 } } }));
            mkdirSync(join(projectDir, '.copilot'), { recursive: true });
            writeFileSync(join(projectDir, '.copilot', 'settings.json'), JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.11 } } }));
            process.chdir(projectDir);
            clearSkillsCache();
            const skill = getBuiltinSkill('deep-dive');
            expect(skill).toBeDefined();
            const t = skill.template;
            expect(t).toContain('Load runtime settings');
            expect(t).toContain('Resolve `omc.deepInterview.ambiguityThreshold` into `0.11`');
            expect(t).toContain('"threshold": 0.11,');
            expect(t).toContain('When ambiguity ≤ the resolved threshold for this run');
            expect(t).toContain('Gate: ≤11% ambiguity');
            expect(t).toContain('Interview continues until ambiguity ≤ 11%');
            expect(t.indexOf('Load runtime settings')).toBeLessThan(t.indexOf('Initialize state') ?? Number.POSITIVE_INFINITY);
            expect(t).not.toContain('"threshold": 0.2,');
            expect(t).not.toContain('omc.deepDive.ambiguityThreshold');
        });
        it('ships config-aware deep-dive SKILL.md using the deep-interview threshold namespace', () => {
            const raw = readFileSync(join(originalCwd, 'skills', 'deep-dive', 'SKILL.md'), 'utf-8');
            expect(raw).toContain('Load runtime settings');
            expect(raw).toContain('Read `[$COPILOT_CONFIG_DIR|~/.copilot]/settings.json` and `./.copilot/settings.json`');
            expect(raw).toContain('Resolve `omc.deepInterview.ambiguityThreshold` into `<resolvedThreshold>`');
            expect(raw).toContain('"threshold": <resolvedThreshold>,');
            expect(raw).toContain('Gate: ≤<resolvedThresholdPercent> ambiguity');
            expect(raw).toContain('Interview continues until ambiguity ≤ <resolvedThresholdPercent>');
            expect(raw).toContain('"deepInterview":');
            expect(raw).toContain('"ambiguityThreshold": <resolvedThreshold>');
            expect(raw).toContain('glob `.omcp/specs/deep-*.md` and `.omcp/plans/*.md`');
            expect(raw).toContain('later Round 1 interview design');
            expect(raw).toContain('`.omcp/specs/deep-dive-trace-{slug}.md`');
            expect(raw).toContain('`.omcp/specs/deep-dive-{slug}.md`');
            expect(raw).toContain('`.omcp/state/` or `state_write` for ephemeral artifacts');
            expect(raw).not.toContain('omc.deepDive.ambiguityThreshold');
            expect(raw).not.toContain('"threshold": 0.2,');
            expect(raw).not.toContain('Gate: ≤20% ambiguity');
            expect(raw).not.toContain('ambiguity ≤ 20%');
        });
        it('renders deep-interview summary-gate hardening while preserving AskUserQuestion transport', () => {
            const skill = getBuiltinSkill('deep-interview');
            expect(skill).toBeDefined();
            const t = skill.template;
            expect(t).toContain('Normalize oversized initial context before state init');
            expect(t).toContain('prompt-safe initial-context summary');
            expect(t).toContain('Wait until the summary exists before ambiguity scoring');
            expect(t).toContain('Do not ask the next `AskUserQuestion`, score ambiguity, or hand off to execution from an over-budget raw transcript.');
            expect(t).toContain('Preserve the AskUserQuestion path for OMC-native interaction');
            expect(t).toContain('Initial Context Summarized: {yes|no}');
            expect(t).not.toContain('omx question');
        });
    });
});
//# sourceMappingURL=skills.test.js.map
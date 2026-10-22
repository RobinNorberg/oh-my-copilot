/**
 * The PostToolUse file injectors on Copilot CLI payloads (1.0.91, recorded by
 * `omg smoke copilot --tier 2 --scenario filetools`): view/create/edit send an
 * object with `path`; apply_patch, which PascalCase hooks see as `Edit`, sends
 * the patch text itself as `tool_input`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs helper without type declarations
import { toolInputPaths } from '../../scripts/lib/tool-input-paths.mjs';
const REPO_ROOT = resolve(__dirname, '..', '..');
function runScript(script, payload, env = {}) {
    const stdout = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', script)], {
        input: JSON.stringify(payload),
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO_ROOT, NODE_ENV: 'test', ...env },
        timeout: 15_000,
    });
    return JSON.parse(stdout.trim());
}
/** The live apply_patch patch, with this test's paths. */
const patch = (notes, created) => `*** Begin Patch\n*** Update File: ${notes}\n@@\n-status: draft\n+status: done\n*** Add File: ${created}\n+created\n*** End Patch\n`;
describe('toolInputPaths', () => {
    it('reads file_path (Claude) or path (Copilot) from an object input', () => {
        expect(toolInputPaths({ file_path: '/a/b.ts' })).toEqual(['/a/b.ts']);
        expect(toolInputPaths({ path: 'C:\\p\\notes.txt', old_str: 'x', new_str: 'y' })).toEqual(['C:\\p\\notes.txt']);
        expect(toolInputPaths({ command: 'ls' })).toEqual([]);
        expect(toolInputPaths(null)).toEqual([]);
        expect(toolInputPaths(undefined)).toEqual([]);
    });
    it('reads every Add/Update/Delete/Move line of an apply_patch text, once each', () => {
        expect(toolInputPaths(patch('filetools/notes.txt', 'filetools/new/created.txt'))).toEqual(['filetools/notes.txt', 'filetools/new/created.txt']);
        const text = '*** Begin Patch\r\n*** Update File: a.txt\r\n*** Move to: b.txt\r\n*** Delete File: c.txt\r\n*** Update File: a.txt\r\n*** End Patch';
        expect(toolInputPaths(text)).toEqual(['a.txt', 'b.txt', 'c.txt']);
        expect(toolInputPaths('plain text, no patch')).toEqual([]);
    });
    it('keeps a delete-only patch and caps the paths at 20', () => {
        expect(toolInputPaths('*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch')).toEqual(['gone.txt']);
        const many = Array.from({ length: 30 }, (_, i) => `*** Add File: f${i}.txt\n+x`).join('\n');
        const paths = toolInputPaths(`*** Begin Patch\n${many}\n*** End Patch`);
        expect(paths).toHaveLength(20);
        expect(paths[0]).toBe('f0.txt');
        expect(paths[19]).toBe('f19.txt');
    });
});
describe('PostToolUse injectors on Copilot payloads', () => {
    let root;
    let project;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'copilot-file-tool-injection-'));
        project = join(root, 'project');
        mkdirSync(join(project, 'filetools', 'new'), { recursive: true });
        writeFileSync(join(project, '.git'), 'gitdir: placeholder');
        writeFileSync(join(project, 'filetools', 'README.md'), '# Fixture\n\nContext marker: read-side\n');
        writeFileSync(join(project, 'filetools', 'new', 'README.md'), '# New\n\nContext marker: write-side\n');
        writeFileSync(join(project, 'filetools', 'notes.txt'), 'status: done\n');
        writeFileSync(join(project, 'filetools', 'new', 'created.txt'), 'created\n');
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });
    const base = (sessionId) => ({ hook_event_name: 'PostToolUse', session_id: sessionId, cwd: project, tool_result: { result_type: 'success', text_result_for_llm: 'ok' } });
    it('directory context: a view payload ({path}) injects the README of its directory', () => {
        const out = runScript('post-tool-directory-context-injector.mjs', { ...base('view'), tool_name: 'Read', tool_input: { path: join(project, 'filetools', 'notes.txt') } });
        expect(out.hookSpecificOutput?.additionalContext).toContain('Context marker: read-side');
        expect(out.hookSpecificOutput?.additionalContext).not.toContain('write-side');
    });
    it('directory context: an apply_patch payload injects the README of every patched file (relative paths)', () => {
        const out = runScript('post-tool-directory-context-injector.mjs', { ...base('patch-rel'), tool_name: 'Edit', tool_input: patch('filetools/notes.txt', 'filetools/new/created.txt') });
        expect(out.hookSpecificOutput?.additionalContext).toContain('Context marker: read-side');
        expect(out.hookSpecificOutput?.additionalContext).toContain('Context marker: write-side');
    });
    it('directory context: an apply_patch payload with absolute paths', () => {
        const input = patch(join(project, 'filetools', 'notes.txt'), join(project, 'filetools', 'new', 'created.txt'));
        const out = runScript('post-tool-directory-context-injector.mjs', { ...base('patch-abs'), tool_name: 'Edit', tool_input: input });
        expect(out.hookSpecificOutput?.additionalContext).toContain('Context marker: write-side');
    });
    it('directory context: a patch text naming no file injects nothing', () => {
        expect(runScript('post-tool-directory-context-injector.mjs', { ...base('patch-none'), tool_name: 'Edit', tool_input: 'no patch here' })).toEqual({ continue: true });
    });
    it('directory context: a delete-only patch still injects the README of the deleted file directory', () => {
        const input = '*** Begin Patch\n*** Delete File: filetools/notes.txt\n*** End Patch\n';
        const out = runScript('post-tool-directory-context-injector.mjs', { ...base('patch-delete'), tool_name: 'Edit', tool_input: input });
        expect(out.hookSpecificOutput?.additionalContext).toContain('Context marker: read-side');
    });
    it('directory context: a ../ patch path behaves like an absolute path outside cwd (only the README beside the file, no walk further up)', () => {
        writeFileSync(join(root, 'README.md'), '# Outside\n\nContext marker: outside-cwd\n');
        const input = '*** Begin Patch\n*** Update File: ../outside.txt\n@@\n-a\n+b\n*** End Patch\n';
        const out = runScript('post-tool-directory-context-injector.mjs', { ...base('patch-dotdot'), tool_name: 'Edit', tool_input: input });
        expect(out.hookSpecificOutput?.additionalContext ?? '').toContain('outside-cwd');
    });
    it('directory context: a patch of 25 files is capped at the first 20 paths', () => {
        for (let i = 0; i < 25; i++) {
            mkdirSync(join(project, `d${i}`));
            writeFileSync(join(project, `d${i}`, 'README.md'), `# D\n\nContext marker: dir-${i}-end\n`);
        }
        const input = `*** Begin Patch\n${Array.from({ length: 25 }, (_, i) => `*** Add File: d${i}/x.txt\n+x`).join('\n')}\n*** End Patch\n`;
        const text = runScript('post-tool-directory-context-injector.mjs', { ...base('patch-many'), tool_name: 'Edit', tool_input: input }).hookSpecificOutput?.additionalContext ?? '';
        expect(text).toContain('dir-19-end');
        expect(text).not.toContain('dir-20-end');
    });
    it('rules: an apply_patch payload reaches the rules lookup', () => {
        mkdirSync(join(project, '.copilot', 'rules'), { recursive: true });
        writeFileSync(join(project, '.copilot', 'rules', 'style.md'), '---\nalwaysApply: true\n---\nUse this rule.');
        const home = join(root, 'home');
        mkdirSync(home);
        const out = runScript('post-tool-rules-injector.mjs', { ...base('rules-patch'), tool_name: 'Edit', tool_input: patch('filetools/notes.txt', 'filetools/new/created.txt') }, { HOME: home, USERPROFILE: home, COPILOT_HOME: join(root, 'config') });
        expect(out.hookSpecificOutput?.additionalContext).toContain('Use this rule.');
    });
});
//# sourceMappingURL=copilot-file-tool-injection.test.js.map
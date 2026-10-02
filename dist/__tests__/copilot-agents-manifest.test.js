import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
/**
 * Copilot CLI loads the fork's agents from the generated copilot/agents/ (root
 * plugin.json `agents`, which REPLACES default agents/ discovery). agents/*.md
 * stays upstream-identical; scripts/copilot/build-agents.mjs remaps the
 * Claude-only frontmatter (model alias, disallowedTools, level).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SOURCE_DIR = join(REPO_ROOT, 'agents');
const OUT_DIR = join(REPO_ROOT, 'copilot', 'agents');
const generator = import(pathToFileURL(join(REPO_ROOT, 'scripts', 'copilot', 'build-agents.mjs')).href);
const READ_ONLY_AGENTS = [
    'analyst', 'architect', 'code-reviewer', 'critic', 'devils-advocate',
    'document-specialist', 'explore', 'scientist', 'security-reviewer', 'verifier',
];
const EXPECTED_TOOLS = [
    'view', 'rg', 'grep', 'glob', 'bash', 'powershell', 'web_fetch',
    'task', 'skill', 'ask_user', 'update_todo', 't/*',
];
const WRITE_TOOLS = ['create', 'edit', 'apply_patch', 'str_replace_editor', 'write'];
/** Agents that search or read docs only and therefore skip repository custom instructions. */
const NO_CUSTOM_INSTRUCTIONS = ['document-specialist', 'explore'];
// Checked against the model ids listed by `copilot help config` on Copilot CLI 1.0.88.
const ALLOWED_MODEL_IDS = new Set([
    'claude-opus-5', 'claude-opus-4.8', 'gpt-5.5',
    'claude-sonnet-5', 'claude-sonnet-4.6',
    'claude-haiku-4.5', 'gpt-5.4-mini', 'gpt-5-mini',
    'claude-fable-5.1', 'claude-fable-5',
]);
const listMd = (dir) => readdirSync(dir).filter(f => f.endsWith('.md')).sort();
const sourceFiles = listMd(SOURCE_DIR);
const generatedFiles = listMd(OUT_DIR);
function split(text) {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!match)
        throw new Error('missing frontmatter');
    const fields = new Map();
    for (const line of match[1].split('\n')) {
        const idx = line.indexOf(':');
        fields.set(line.slice(0, idx), line.slice(idx + 1).trim());
    }
    return { fields, body: text.slice(match[0].length) };
}
const generated = new Map(generatedFiles.map(f => [f, split(readFileSync(join(OUT_DIR, f), 'utf8'))]));
const source = new Map(sourceFiles.map(f => [f, split(readFileSync(join(SOURCE_DIR, f), 'utf8'))]));
describe('copilot/agents generated from agents/', () => {
    it('is in sync with the generator (run: node scripts/copilot/build-agents.mjs --write)', async () => {
        const { renderCopilotAgents } = await generator;
        const rendered = renderCopilotAgents();
        expect([...rendered.keys()]).toEqual(generatedFiles);
        for (const [fileName, text] of rendered) {
            expect(readFileSync(join(OUT_DIR, fileName), 'utf8'), fileName).toBe(text);
        }
    });
    it('has exactly one counterpart per agents/*.md', () => {
        expect(sourceFiles.length).toBeGreaterThan(0);
        expect(generatedFiles).toEqual(sourceFiles);
    });
    it('copies bodies byte-for-byte and keeps name/description', () => {
        for (const fileName of sourceFiles) {
            const src = source.get(fileName);
            const out = generated.get(fileName);
            expect(out.body, fileName).toBe(src.body);
            expect(out.fields.get('name'), fileName).toBe(src.fields.get('name'));
            expect(out.fields.get('description'), fileName).toBe(src.fields.get('description'));
        }
    });
    it('leaves no Claude-only frontmatter keys', () => {
        for (const [fileName, { fields }] of generated) {
            for (const key of ['model', 'level', 'disallowedTools']) {
                expect(fields.has(key), `${fileName} ${key}`).toBe(false);
            }
        }
    });
    it('gives read-only agents the exact native allowlist and no write tools', () => {
        const readOnly = sourceFiles
            .filter(f => source.get(f).fields.has('disallowedTools'))
            .map(f => f.replace(/\.md$/, ''));
        expect(readOnly).toEqual(READ_ONLY_AGENTS);
        for (const name of READ_ONLY_AGENTS) {
            const { fields } = generated.get(`${name}.md`);
            const tools = JSON.parse(fields.get('tools') ?? 'null');
            expect(tools, name).toEqual(EXPECTED_TOOLS);
            for (const writeTool of WRITE_TOOLS)
                expect(tools, name).not.toContain(writeTool);
            expect(tools, name).not.toContain('web_search');
        }
    });
    it('builds allowlists by subtracting mapped ids from FULL_TOOLS', async () => {
        const { FULL_TOOLS, DISALLOWED_TOOL_MAP } = await generator;
        expect(FULL_TOOLS).not.toContain('web_search');
        for (const [claudeTool, ids] of Object.entries(DISALLOWED_TOOL_MAP)) {
            expect(ids.length, claudeTool).toBeGreaterThan(0);
            for (const id of ids)
                expect(FULL_TOOLS, `${claudeTool} -> ${id}`).toContain(id);
        }
        expect(FULL_TOOLS.filter(tool => !WRITE_TOOLS.includes(tool))).toEqual(EXPECTED_TOOLS);
    });
    it('gives reviewer and write-capable agents custom instructions, except explore/document-specialist', () => {
        for (const [fileName, { fields }] of generated) {
            const name = fileName.replace(/\.md$/, '');
            if (NO_CUSTOM_INSTRUCTIONS.includes(name)) {
                expect(fields.has('include-custom-instructions'), name).toBe(false);
            }
            else {
                expect(fields.get('include-custom-instructions'), name).toBe('true');
            }
        }
        for (const reviewer of ['code-reviewer', 'security-reviewer', 'critic', 'verifier', 'architect']) {
            expect(generated.get(`${reviewer}.md`).fields.get('include-custom-instructions'), reviewer).toBe('true');
        }
    });
    it('gives write-capable agents no tools restriction', () => {
        const writeCapable = sourceFiles.filter(f => !READ_ONLY_AGENTS.includes(f.replace(/\.md$/, '')));
        expect(writeCapable.length).toBeGreaterThan(0);
        for (const fileName of writeCapable) {
            expect(generated.get(fileName).fields.has('tools'), fileName).toBe(false);
        }
    });
    it('maps model aliases to a models fallback list from the table', async () => {
        const { MODEL_TABLE } = await generator;
        for (const ids of Object.values(MODEL_TABLE)) {
            expect(ids.length).toBeGreaterThanOrEqual(2);
            for (const id of ids)
                expect(ALLOWED_MODEL_IDS.has(id), id).toBe(true);
        }
        for (const fileName of sourceFiles) {
            const alias = source.get(fileName).fields.get('model');
            const models = generated.get(fileName).fields.get('models');
            if (alias && MODEL_TABLE[alias]) {
                expect(JSON.parse(models), fileName).toEqual(MODEL_TABLE[alias]);
            }
            else {
                expect(models, fileName).toBeUndefined();
            }
        }
    });
    it('throws on unknown frontmatter keys and unmapped disallowed tools', async () => {
        const { buildCopilotAgent } = await generator;
        expect(() => buildCopilotAgent('---\nname: x\ncolor: red\n---\nbody\n')).toThrow(/unknown frontmatter key "color"/);
        expect(() => buildCopilotAgent('---\nname: x\ndisallowedTools: Glob\n---\nbody\n')).toThrow(/unmapped disallowed tool "Glob"/);
        expect(() => buildCopilotAgent('no frontmatter\n')).toThrow(/missing/);
    });
    it('removes Bash from the allowlist when upstream disallows it', async () => {
        const { buildCopilotAgent } = await generator;
        const out = split(buildCopilotAgent('---\nname: x\nmodel: unknown\ndisallowedTools: Bash\n---\nbody\n'));
        expect(JSON.parse(out.fields.get('tools'))).not.toContain('powershell');
        expect(out.fields.has('models')).toBe(false);
        expect(out.body).toBe('body\n');
    });
    it('is wired through the root plugin.json agents path', () => {
        const plugin = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin.json'), 'utf8'));
        expect(plugin.agents).toBe('./copilot/agents/');
        const target = join(REPO_ROOT, plugin.agents);
        expect(existsSync(target) && statSync(target).isDirectory()).toBe(true);
    });
});
//# sourceMappingURL=copilot-agents-manifest.test.js.map
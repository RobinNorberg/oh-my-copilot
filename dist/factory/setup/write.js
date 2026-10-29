/**
 * Step 6 of `omg factory setup` (factory forges design §4, §8.6): edits to
 * the `factory` subtree of `.copilot/omg.jsonc` (project scope) or the user
 * config at its default location (user scope), made with jsonc-parser
 * `modify` + `applyEdits` so comments and every other key stay as they are.
 * `forge.azureDevOps.trustedAuthors` always goes to the user config, the only
 * layer resolveForgeConfig reads it from. assertFactoryOnly re-parses each
 * result and refuses a write that changed anything outside `factory`, so
 * `ship.*` safety keys can never move.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { SetupError } from './guard.js';
export function buildSection(repo, intake, progress, team) {
    const forge = repo.kind === 'github'
        ? { kind: 'github', github: { repo: `${repo.owner}/${repo.name}`, host: repo.host } }
        : { kind: 'azure-devops', azureDevOps: { org: repo.owner, project: repo.project, repo: repo.name, ...(team ? { team } : {}) } };
    return {
        forge,
        intake: { source: intake.source, ...(repo.kind === 'azure-devops' ? { itemTypes: [...intake.itemTypes] } : {}) },
        progress: { enabled: progress.enabled, stages: progress.stages },
    };
}
/**
 * The (path, value) edits of a section. Objects the wizard answers as a whole
 * (the intake source, item types, progress stages) are replaced; the forge
 * identity is set key by key so other keys there (trustedAuthors, apiVersion)
 * stay.
 */
export function sectionEdits(section) {
    const edits = [];
    for (const [key, value] of Object.entries(section.forge)) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            for (const [k, v] of Object.entries(value))
                edits.push([['factory', 'forge', key, k], v]);
        }
        else
            edits.push([['factory', 'forge', key], value]);
    }
    edits.push([['factory', 'intake', 'source'], section.intake.source]);
    if (section.intake.itemTypes)
        edits.push([['factory', 'intake', 'itemTypes'], section.intake.itemTypes]);
    edits.push([['factory', 'progress', 'enabled'], section.progress.enabled]);
    edits.push([['factory', 'progress', 'stages'], section.progress.stages]);
    return edits;
}
export function trustedAuthorsEdit(authors) {
    return [['factory', 'forge', 'azureDevOps', 'trustedAuthors'], [...authors]];
}
function parseStrict(text, path) {
    if (text.trim() === '')
        return {};
    const errors = [];
    const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0)
        throw new SetupError(5, `cannot edit ${path}: it is not valid JSONC (offset ${errors[0].offset}); fix it by hand first`);
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new SetupError(5, `cannot edit ${path}: the top level is not an object`);
    return value;
}
/** Apply edits to JSONC text, keeping comments and formatting. */
export function applyFactoryEdits(text, edits, path = 'config') {
    parseStrict(text, path);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    let out = text.trim() === '' ? '{}' : text;
    for (const [jsonPath, value] of edits) {
        if (jsonPath[0] !== 'factory')
            throw new SetupError(1, `omg factory setup writes only factory.*, not ${jsonPath.join('.')}`);
        out = applyEdits(out, modify(out, jsonPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } }));
    }
    if (text.trim() === '' && !out.endsWith(eol))
        out += eol;
    return out;
}
const canonical = (v) => Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
        : v;
/** Throws unless `before` and `after` differ only under the top-level `factory` key. */
export function assertFactoryOnly(before, after, path = 'config') {
    const strip = (text) => {
        const { factory: _factory, ...rest } = parseStrict(text, path);
        return JSON.stringify(canonical(rest));
    };
    if (strip(before) !== strip(after))
        throw new SetupError(1, `refusing to write ${path}: the edit changed keys outside factory.*`);
}
/** A line diff (`-`/`+`, unchanged lines with two spaces), small files only. */
export function lineDiff(before, after) {
    const a = before === '' ? [] : before.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const b = after.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--)
        for (let j = b.length - 1; j >= 0; j--)
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            out.push(`  ${a[i]}`);
            i++;
            j++;
        }
        else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j]))
            out.push(`+ ${b[j++]}`);
        else
            out.push(`- ${a[i++]}`);
    }
    return out.join('\n');
}
const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
/** The writes for one setup, with diffs; nothing is written here. Unchanged files are left out. */
export function planWrites(input) {
    const targets = new Map();
    targets.set(input.scope, sectionEdits(input.section));
    if (input.trustedAuthors && input.trustedAuthors.length > 0)
        targets.set('user', [...(targets.get('user') ?? []), trustedAuthorsEdit(input.trustedAuthors)]);
    const out = [];
    for (const [scope, edits] of targets) {
        const path = scope === 'project' ? input.projectPath : input.userPath;
        const before = readText(path);
        const after = applyFactoryEdits(before, edits, path);
        assertFactoryOnly(before, after, path);
        if (after !== before)
            out.push({ path, scope, before, after, diff: lineDiff(before, after) });
    }
    return out;
}
export function applyWrites(planned) {
    for (const w of planned) {
        // Re-check right before the write: the file must still be what the diff was made from.
        if (readText(w.path) !== w.before)
            throw new SetupError(1, `${w.path} changed while the wizard ran; run omg factory setup again`);
        mkdirSync(dirname(w.path), { recursive: true });
        writeFileSync(w.path, w.after, 'utf8');
    }
    return planned.map((w) => w.path);
}
/** The parsed config a planned write would leave (for validation through resolveForgeConfig). */
export function parsedAfter(planned, path) {
    const w = planned.find((p) => p.path === path);
    const text = w ? w.after : readText(path);
    return text.trim() === '' ? undefined : parseStrict(text, path);
}
//# sourceMappingURL=write.js.map
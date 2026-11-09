/**
 * Step 6 of `omg factory setup` (factory forges design §4, §8.6): edits to
 * the `factory` subtree of `.copilot/omg.jsonc` and the user config at its
 * default location, made with jsonc-parser `modify` + `applyEdits` so
 * comments and every other key stay as they are.
 *
 * The forge identity, intake and progress are per repository, so they always
 * go to the project file, whatever `--scope` says: the user config is one
 * file for every repository and its `forge.*` has the highest trust, so a
 * repository's identity there would break (forge-mismatch) or redirect every
 * other repository. The user config gets only the user-only keys, today
 * `forge.azureDevOps.trustedAuthors` (the only layer resolveForgeConfig
 * reads it from). assertFactoryOnly re-parses each result and refuses a
 * write that changed anything but the keys its scope owns, so `ship.*`
 * safety keys can never move.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { backlogFileId } from '../../forge/local/backlog.js';
import { applyEdits, modify, parse, parseTree, type JSONPath, type Node, type ParseError } from 'jsonc-parser';
import { DEFAULT_LOCAL_BACKLOG_DIR } from '../../forge/config.js';
import { renderBacklogFile } from '../../forge/local/index.js';
import type { ForgeIntakeConfig, ForgeProgressConfig, ForgeRepo, IntakeSource } from '../../forge/types.js';
import { SetupError } from './guard.js';

export type SetupScope = 'project' | 'user';

/** The `factory` keys the wizard owns; nothing else under `factory` is touched. */
export interface SetupSection {
  forge: Record<string, unknown>;
  intake: { source: IntakeSource; itemTypes?: string[] };
  /** Absent on the local forge: it records the stage itself and syncs no board, so the key would only be ignored (F21). */
  progress?: Pick<ForgeProgressConfig, 'enabled' | 'stages'>;
  /** Azure DevOps: the build definition heal reads as CI (factory.heal.pipeline; read from <base> once committed). */
  heal?: { pipeline: { definitionId: number } };
  /** The local forge: the detected base branch when no config names one (F20); the one key outside `factory` setup writes. */
  ship?: { base: string };
}

export function buildSection(repo: ForgeRepo, intake: Pick<ForgeIntakeConfig, 'source' | 'itemTypes'> & { source: IntakeSource }, progress: ForgeProgressConfig, team?: string): SetupSection {
  const forge: Record<string, unknown> = repo.kind === 'github'
    ? { kind: 'github', github: { repo: `${repo.owner}/${repo.name}`, host: repo.host } }
    : repo.kind === 'local'
      // The gate is a command: it counts only from the user config or the committed base file, so the wizard does not write it.
      ? { kind: 'local', local: { backlogDir: DEFAULT_LOCAL_BACKLOG_DIR } }
      : { kind: 'azure-devops', azureDevOps: { org: repo.owner, project: repo.project!, repo: repo.name, ...(team ? { team } : {}) } };
  return {
    forge,
    intake: { source: intake.source, ...(repo.kind === 'azure-devops' ? { itemTypes: [...intake.itemTypes] } : {}) },
    ...(repo.kind === 'local' ? {} : { progress: { enabled: progress.enabled, stages: progress.stages } }),
  };
}

/**
 * The (path, value) edits of a section. Objects the wizard answers as a whole
 * (the intake source, item types, progress stages) are replaced; the forge
 * identity is set key by key so other keys there (trustedAuthors, apiVersion)
 * stay.
 */
export function sectionEdits(section: SetupSection): Array<[JSONPath, unknown]> {
  const edits: Array<[JSONPath, unknown]> = [];
  for (const [key, value] of Object.entries(section.forge)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) edits.push([['factory', 'forge', key, k], v]);
    } else edits.push([['factory', 'forge', key], value]);
  }
  edits.push([['factory', 'intake', 'source'], section.intake.source]);
  if (section.intake.itemTypes) edits.push([['factory', 'intake', 'itemTypes'], section.intake.itemTypes]);
  if (section.progress) {
    edits.push([['factory', 'progress', 'enabled'], section.progress.enabled]);
    edits.push([['factory', 'progress', 'stages'], section.progress.stages]);
  }
  if (section.heal) edits.push([['factory', 'heal', 'pipeline'], section.heal.pipeline]);
  if (section.ship) edits.push([SHIP_BASE, section.ship.base]);
  return edits;
}

const TRUSTED_AUTHORS: JSONPath = ['factory', 'forge', 'azureDevOps', 'trustedAuthors'];
/** ship.base: the branch runs start from and the human merges into (not a safety key; trustedBases stays user-only). */
const SHIP_BASE: JSONPath = ['ship', 'base'];
const isShipBase = (p: JSONPath): boolean => p.length === 2 && p[0] === 'ship' && p[1] === 'base';
const hasShipBase = (config: Record<string, unknown>): boolean => {
  const ship = config.ship;
  return ship !== null && typeof ship === 'object' && 'base' in ship;
};

export function trustedAuthorsEdit(authors: readonly string[]): [JSONPath, unknown] {
  return [TRUSTED_AUTHORS, [...authors]];
}

/** The subtrees each scope may change; everything else must parse the same before and after. */
const OWNED: Record<SetupScope, readonly JSONPath[]> = {
  project: [['factory', 'forge'], ['factory', 'intake'], ['factory', 'progress'], ['factory', 'heal', 'pipeline']],
  user: [TRUSTED_AUTHORS],
};

const BOM = String.fromCharCode(0xfeff);

/** Duplicate keys in an object node; a duplicate makes `modify` edit one copy while the engine reads the other. */
function duplicateKey(node: Node | undefined): string | undefined {
  const seen = new Set<string>();
  for (const prop of node?.type === 'object' ? node.children ?? [] : []) {
    const key = prop.children?.[0]?.value as string;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return undefined;
}

function parseStrict(text: string, path: string): Record<string, unknown> {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  if (body.trim() === '') return {};
  const errors: ParseError[] = [];
  const options = { allowTrailingComma: true, disallowComments: false };
  const value = parse(body, errors, options);
  if (errors.length > 0) throw new SetupError(5, `cannot edit ${path}: it is not valid JSONC (offset ${errors[0].offset}); fix it by hand first`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SetupError(5, `cannot edit ${path}: the top level is not an object`);
  const tree = parseTree(body, [], options);
  const factory = tree?.children?.find((p) => p.children?.[0]?.value === 'factory')?.children?.[1];
  const dup = duplicateKey(tree) ?? duplicateKey(factory);
  if (dup !== undefined) throw new SetupError(5, `cannot edit ${path}: the key ${JSON.stringify(dup)} appears twice; fix it by hand first`);
  const f = (value as Record<string, unknown>).factory;
  if (f !== undefined && (f === null || typeof f !== 'object' || Array.isArray(f))) throw new SetupError(5, `cannot edit ${path}: factory is not an object; fix it by hand first`);
  return value as Record<string, unknown>;
}

/** Apply edits to JSONC text, keeping comments, formatting and a leading BOM. */
export function applyFactoryEdits(text: string, edits: ReadonlyArray<[JSONPath, unknown]>, path = 'config'): string {
  const parsed = parseStrict(text, path);
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = text.slice(bom.length);
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  let out = body.trim() === '' ? '{}' : body;
  for (const [jsonPath, value] of edits) {
    // ship.base only where the file names none (F20: the local forge's detected base); an existing one is never changed.
    const addsBase = isShipBase(jsonPath) && !hasShipBase(parsed);
    if (jsonPath[0] !== 'factory' && !addsBase) throw new SetupError(1, `omg factory setup writes only factory.* (and ship.base where none is set), not ${jsonPath.join('.')}`);
    try {
      out = applyEdits(out, modify(out, jsonPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } }));
    } catch (error) {
      throw new SetupError(5, `cannot edit ${path} at ${jsonPath.join('.')}: ${(error as Error).message}; fix it by hand first`);
    }
  }
  if (body.trim() === '' && !out.endsWith(eol)) out += eol;
  return bom + out;
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
      : v;

/** Delete `path` from `root`, then the objects on the way that it left empty. */
function without(root: Record<string, unknown>, path: JSONPath): void {
  const chain: Array<Record<string, unknown>> = [root];
  for (const key of path.slice(0, -1)) {
    const next = chain[chain.length - 1][key as string];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return;
    chain.push(next as Record<string, unknown>);
  }
  delete chain[chain.length - 1][path[path.length - 1] as string];
  for (let i = chain.length - 1; i > 0 && Object.keys(chain[i]).length === 0; i--) delete chain[i - 1][path[i - 1] as string];
}

/** Throws unless `before` and `after` differ only in the subtrees `scope` owns. */
export function assertFactoryOnly(before: string, after: string, scope: SetupScope, path = 'config'): void {
  // A project file without ship.base may gain one (F20); one that has it must keep it.
  const baseAdded = scope === 'project' && !hasShipBase(parseStrict(before, path));
  const strip = (text: string) => {
    const value = structuredClone(parseStrict(text, path));
    for (const owned of OWNED[scope]) without(value, owned);
    if (baseAdded) without(value, SHIP_BASE);
    return JSON.stringify(canonical(value));
  };
  if (strip(before) !== strip(after)) throw new SetupError(1, `refusing to write ${path}: the edit changed keys outside ${OWNED[scope].map((p) => p.join('.')).join(', ')}`);
}

/** A line diff (`-`/`+`, unchanged lines with two spaces), small files only. */
export function lineDiff(before: string, after: string): string {
  const a = before === '' ? [] : before.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const b = after.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
    else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) out.push(`+ ${b[j++]}`);
    else out.push(`- ${a[i++]}`);
  }
  return out.join('\n');
}

export interface PlannedWrite {
  path: string;
  scope: SetupScope;
  before: string;
  after: string;
  diff: string;
}

export interface WritePlanInput {
  projectPath: string;
  userPath: string;
  section: SetupSection;
  /** ADO only; the one thing written to the user config. */
  trustedAuthors?: readonly string[];
}

const readText = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/** Refuses a project config, or its `.copilot` directory, that is a symlink or junction: the write would land elsewhere. */
function assertNotLinked(path: string): void {
  for (const p of [dirname(path), path]) {
    let linked = false;
    try {
      linked = lstatSync(p).isSymbolicLink();
    } catch {
      continue;
    }
    if (linked) throw new SetupError(5, `refusing to write ${path}: ${p} is a symlink or junction`);
  }
}

/** The writes for one setup, with diffs; nothing is written here. Unchanged files are left out. */
export function planWrites(input: WritePlanInput): PlannedWrite[] {
  const targets = new Map<SetupScope, Array<[JSONPath, unknown]>>([['project', sectionEdits(input.section)]]);
  if (input.trustedAuthors && input.trustedAuthors.length > 0) targets.set('user', [trustedAuthorsEdit(input.trustedAuthors)]);
  const out: PlannedWrite[] = [];
  for (const [scope, edits] of targets) {
    const path = scope === 'project' ? input.projectPath : input.userPath;
    if (scope === 'project') assertNotLinked(path);
    const before = readText(path);
    const after = applyFactoryEdits(before, edits, path);
    assertFactoryOnly(before, after, scope, path);
    if (after !== before) out.push({ path, scope, before, after, diff: lineDiff(before, after) });
  }
  return out;
}

/** The sample item `--forge local` adds to an empty backlog: closed, so no run picks it up before it is edited. */
export const SAMPLE_BACKLOG_FILE = '1-example.md';
export const SAMPLE_BACKLOG_TEXT = renderBacklogFile(
  { title: 'Example: one change the factory can make', state: 'closed', labels: [], dependsOn: [] },
  [
    'One file per item: `<id>-<slug>.md` in this directory. Describe the change here, set `state: open`,',
    'and commit the file on the base branch: `omg factory run` reads items at the base commit only.',
    '',
    '## Acceptance',
    '- [ ] `npm test` passes',
  ].join('\n'),
);

/**
 * The sample backlog item for the local forge, when `<root>/<backlogDir>` has
 * no backlog file yet (`<n>-<slug>.md`); undefined otherwise. Written by applyWrites.
 */
export function planBacklogSample(root: string, backlogDir: string): PlannedWrite | undefined {
  const dir = join(root, ...backlogDir.split('/'));
  let p = root;
  for (const seg of backlogDir.split('/')) {
    p = join(p, seg);
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new SetupError(5, `refusing to write the sample backlog item: ${p} is a symlink or junction`);
  }
  if (existsSync(dir) && readdirSync(dir).some((name) => backlogFileId(name) !== undefined)) return undefined;
  const path = join(dir, SAMPLE_BACKLOG_FILE);
  return { path, scope: 'project', before: '', after: SAMPLE_BACKLOG_TEXT, diff: lineDiff('', SAMPLE_BACKLOG_TEXT) };
}

export function applyWrites(planned: readonly PlannedWrite[]): string[] {
  for (const w of planned) {
    // Re-check right before the write: the file must still be what the diff was made from.
    if (w.scope === 'project') assertNotLinked(w.path);
    if (readText(w.path) !== w.before) throw new SetupError(1, `${w.path} changed while the wizard ran; run omg factory setup again`);
    mkdirSync(dirname(w.path), { recursive: true });
    writeFileSync(w.path, w.after, 'utf8');
  }
  return planned.map((w) => w.path);
}

/** The parsed config a planned write would leave (for validation through resolveForgeConfig). */
export function parsedAfter(planned: readonly PlannedWrite[], path: string): unknown {
  const w = planned.find((p) => p.path === path);
  const text = w ? w.after : readText(path);
  return (text.startsWith(BOM) ? text.slice(1) : text).trim() === '' ? undefined : parseStrict(text, path);
}

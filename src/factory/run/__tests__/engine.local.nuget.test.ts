/**
 * The NuGet restore step of a dotnet gate on the local forge engine
 * (nuget-restore.ts): fake lanes, a real repository and prepare checkout,
 * the test sandbox. No dotnet, network, gh or copilot runs.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dotnetSandboxEnv, sandboxNugetConfig } from '../../../copilot-run/dotnet-sandbox.js';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localCheckRecordPath } from '../../../forge/local/index.js';
import { runFactoryEngine } from '../engine.js';
import { cleanFactoryRun } from '../clean.js';
import { DEFINITION_TREE_STUBS, restoreApprovalNote } from '../nuget-restore.js';
import { readFactoryState, requestFactoryCancel, updateFactoryState } from '../state.js';
import { EngineLedger } from '../ledger.js';
import type { SandboxRunner, SandboxRunRequest, SandboxRunResult } from '../sandbox-exec.js';
import { attestedSandbox, commitFile, gitIn, review, type LaneScript } from './fake-lanes.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';
import { sealedNext, steps } from './gate-next-expect.js';

let w: LocalWorld;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

const MULTI_RUN_MS = 300_000;
const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n';
const BUMPED = CSPROJ.replace('</PropertyGroup>', '</PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="Humanizer.Core" Version="2.14.1" />\n  </ItemGroup>');
const OWNER = { pid: 4242, hostname: 'test-host', isAlive: () => false };
const SANDBOXED ={ factory: { run: { gateInstall: 'sandboxed' } } };
/** NuGet's offline lines from a real sandboxed gate run (the paths shortened). */
const OFFLINE = [
  'C:\\work\\src\\App\\App.csproj : error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json. [C:\\work\\App.sln]',
  'C:\\work\\src\\App\\App.csproj : error NU1301:   No such host is known. (api.nuget.org:443) [C:\\work\\App.sln]',
  '  Failed to restore C:\\work\\src\\App\\App.csproj (in 5,79 sec).',
].join('\n');
const PRIVATE = 'C:\\work\\src\\App\\App.csproj : error NU1301: Unable to load the service index for source https://pkgs.example.test/feed/nuget/v3/index.json.';
const MISSING = 'C:\\work\\src\\App\\App.csproj : error NU1102: Unable to find package Humanizer.Core with version (>= 99.0.0)\n  - Found 25 version(s) in nuget.org [ Nearest version: 3.0.1 ]';

function baseProject(): void {
  writeFileSync(join(w.root, '.gitignore'), '.omg/\nbin/\nobj/\n');
  mkdirSync(join(w.root, 'src', 'App'), { recursive: true });
  writeFileSync(join(w.root, 'App.sln'), 'Microsoft Visual Studio Solution File\n');
  writeFileSync(join(w.root, 'src', 'App', 'App.csproj'), CSPROJ);
  gitIn(w.root, 'add', '.');
  gitIn(w.root, 'commit', '-q', '-m', 'project');
}

interface Recorder {
  reqs: SandboxRunRequest[];
  /** Each restore's working dir as it was when the restore ran: [repository path, content], sorted. */
  trees: Array<Array<[string, string]>>;
  sandbox: SandboxRunner;
}

/** Every file under `dir` as [posix path, content], sorted. */
function filesUnder(dir: string, at = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const e of readdirSync(join(dir, at), { withFileTypes: true })) {
    const rel = at ? `${at}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(dir, rel));
    else out.push([rel, readFileSync(join(dir, rel), 'utf8')]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * The test sandbox, every request recorded. The gate answers `gates` in turn (the last repeats); a gate run leaves
 * restore output in obj/ as dotnet does. The restore step records its tree, answers `restore` and writes a package
 * into its dir. A calibration answers `calibrate` when given.
 */
function recorder(gates: Array<{ status: number; output: string }>, restore: SandboxRunResult = { ran: true, status: 0, output: 'Restored src/App/App.csproj', timedOut: false }, calibrate?: SandboxRunResult): Recorder {
  const reqs: SandboxRunRequest[] = [];
  const trees: Recorder['trees'] = [];
  const inner = attestedSandbox(() => w.exec, () => w.gate);
  let gateRuns = 0;
  const sandbox: SandboxRunner = async (req) => {
    reqs.push(req);
    if (req.purpose === 'restore') {
      trees.push(filesUnder(req.cwd));
      if (restore.ran && restore.status === 0 && req.nugetPackages) mkdirSync(join(req.nugetPackages.dir, 'humanizer.core', '2.14.1'), { recursive: true });
      return restore;
    }
    if (req.purpose === 'calibrate' && calibrate) return calibrate;
    if (req.purpose === 'gate') {
      const g = gates[Math.min(gateRuns++, gates.length - 1)];
      mkdirSync(join(req.cwd, 'src', 'App', 'obj'), { recursive: true });
      writeFileSync(join(req.cwd, 'src', 'App', 'obj', 'project.assets.json'), '{}\n');
      return { ran: true, status: g.status, output: g.output, timedOut: false };
    }
    return inner(req);
  };
  return { reqs, trees, sandbox };
}

/** The engine's stubs at the definition tree's root (nuget-restore.ts DEFINITION_TREE_STUBS), as [path, content]. */
const STUBS: Array<[string, string]> = DEFINITION_TREE_STUBS.map(([p, c]) => [p, c]);
const purposes = (r: Recorder) => r.reqs.map((q) => q.purpose).filter((p) => p !== 'calibrate' && p !== 'prepare');
const nugetDir = () => join(w.root, '.omg', 'state', 'factory-gates', 'nuget', `issue-${LOCAL_ISSUE}`);
const treeDir = () => join(w.root, '.omg', 'state', 'factory-gates', 'nuget-defs', `issue-${LOCAL_ISSUE}`);

describe('a dotnet gate that cannot restore its NuGet packages is never a code failure', () => {
  it('packages cached: the gate passes and no restore step or packages dir is made', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 0, output: 'Passed!' }]);
    const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(purposes(r)).toEqual(['gate']);
    expect(r.reqs.find((q) => q.purpose === 'gate')!.nugetPackages).toBeUndefined();
    expect(existsSync(nugetDir())).toBe(false);
  }, MULTI_RUN_MS);

  it('gateInstall "park" (the default): parks at gate-install-needed naming NuGet and the setting; no ci-fix lane, no FAILURE record', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }]);
    const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(sealedNext(w.root, LOCAL_ISSUE, out)).toEqual([steps(LOCAL_ISSUE).status, steps(LOCAL_ISSUE).resume, steps(LOCAL_ISSUE).cancel]);
    expect(out.gate?.reason).toMatch(/could not restore its NuGet packages on [0-9a-f]{12} \(NU1301\), which says nothing about the code, so no ci-fix lane was started\. The OS sandbox has no network.*set factory\.run\.gateInstall "sandboxed" in your user config.*then rerun omg factory run/);
    expect(lanes.started).toHaveLength(2);
    expect(purposes(r)).toEqual(['gate']);
    const head = readFactoryState(w.root, LOCAL_ISSUE)!.head!;
    expect(existsSync(localCheckRecordPath(w.stateDir, w.root, head))).toBe(false);
  }, MULTI_RUN_MS);

  it('gateInstall "sandboxed": clean, then dotnet restore with only NuGet reachable into the run\'s packages dir, then the gate again offline on it', async () => {
    w = localWorld(['dotnet', 'test', 'App.sln', '-c', 'Release']);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }, { status: 0, output: 'Passed!' }]);
    const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(lanes.started).toHaveLength(2);
    // The offline gate left obj/: the sandboxed clean empties it before the networked step, never after.
    expect(purposes(r)).toEqual(['gate', 'clean', 'restore', 'gate']);
    const restore = r.reqs.find((q) => q.purpose === 'restore')!;
    expect(restore).toMatchObject({ network: 'nuget', argv: ['dotnet', 'restore', 'App.sln'], nugetPackages: { dir: nugetDir(), writable: true } });
    // Never in the prepare checkout: the definition tree, holding the head's pinned definition files only, gone after.
    expect(restore.cwd).toBe(treeDir());
    expect(restore.cwd).not.toBe(r.reqs[0].cwd);
    // The head's two pinned files, and the engine's stubs at the root (the head has none of them there).
    expect(r.trees).toEqual([[['App.sln', 'Microsoft Visual Studio Solution File\n'], ...STUBS, ['src/App/App.csproj', CSPROJ]].sort((a, b) => (a[0] < b[0] ? -1 : 1))]);
    expect(existsSync(treeDir())).toBe(false);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.nugetRestore).toEqual({ head: readFactoryState(w.root, LOCAL_ISSUE)!.head, definition: expect.stringMatching(/^[0-9a-f]{64}$/), outcome: 'passed', exit: 0 });
    // The gates: the first with your cache only, the second reads the run's dir (read-only) with your cache behind it.
    const gates = r.reqs.filter((q) => q.purpose === 'gate');
    expect(gates[0].nugetPackages).toBeUndefined();
    expect(gates[1].nugetPackages).toEqual({ dir: nugetDir(), writable: false });
    expect(gates.every((g) => g.network === undefined)).toBe(true);
    expect(readdirSync(nugetDir())).toEqual(['humanizer.core']);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.history.some((h) => /^dotnet restore ran in the OS sandbox with only api\.nuget\.org reachable in the engine's definition tree of [0-9a-f]{12} \(2 pinned definition file\(s\), nothing else/.test(h.note))).toBe(true);
    // The packages dir goes with the run: cancel, then clean.
    requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
    expect((await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandbox: r.sandbox }))).phase).toBe('cancelled');
    const cleaned = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner: OWNER });
    expect(cleaned.removed).toContain(nugetDir());
    expect(existsSync(nugetDir())).toBe(false);
  }, MULTI_RUN_MS);

  it('a package bump parks at gate-definition-changed first; only after --allow-gate-change does the networked restore run', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }, { status: 0, output: 'Passed!' }]);
    const parked = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/App.csproj', BUMPED)]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(parked.gate?.name, parked.message).toBe('gate-definition-changed');
    expect(r.reqs.filter((q) => q.purpose === 'restore' || q.purpose === 'gate')).toEqual([]);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED, allowGateChange: true }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.gateChangeApproved).toMatch(/^[0-9a-f]{64}$/);
    expect(purposes(r)).toEqual(['gate', 'clean', 'restore', 'gate']);
  }, MULTI_RUN_MS);

  it('the networked restore never runs on definition files that are not pinned at the gate head (checked at restore time)', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }]);
    const exec = w.exec;
    const baseSha = gitIn(w.root, 'rev-parse', 'HEAD');
    // After the first gate run, the head's tree names a project file nobody approved (the base's tree reads as it is).
    const lying: typeof w.exec = (cmd, args, opts) => {
      const out = exec(cmd, args, opts);
      if (cmd !== 'git' || !args.includes('ls-tree') || !args.includes('--full-tree') || args.includes(baseSha) || !r.reqs.some((q) => q.purpose === 'gate')) return out;
      return { ...out, stdout: out.stdout.replace(/ [0-9a-f]{40}\tsrc\/App\/App\.csproj\0/, ` ${'1'.repeat(40)}\tsrc/App/App.csproj\0`) };
    };
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED, exec: lying }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toMatch(/the sandboxed dotnet restore did not run: the gate's definition files at [0-9a-f]{12} are neither main's nor the change accepted with --allow-gate-change/);
    expect(r.reqs.some((q) => q.purpose === 'restore')).toBe(false);
  }, MULTI_RUN_MS);

  it('a restore that fails with network (a version that does not exist) parks with NuGet\'s output; no ci-fix lane', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }], { ran: true, status: 1, output: MISSING, timedOut: false });
    const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toMatch(/with only api\.nuget\.org reachable failed \(exit 1\): a package or version the project files name may not exist on nuget\.org \(NU1102\)\. That needs a human, not a ci-fix lane/);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.gate?.detail).toMatch(/NU1102: Unable to find package Humanizer\.Core/);
    expect(lanes.started).toHaveLength(2);
    expect(purposes(r)).toEqual(['gate', 'clean', 'restore']);
  }, MULTI_RUN_MS);

  it('the gate still failing to restore after a restore for this head parks (one restore per head)', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }]);
    const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toMatch(/even after the sandboxed dotnet restore for this head ran/);
    expect(purposes(r)).toEqual(['gate', 'clean', 'restore', 'gate']);
    expect(lanes.started).toHaveLength(2);
  }, MULTI_RUN_MS);

  it('a private feed parks saying private feeds are not supported, with no restore step', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 1, output: PRIVATE }]);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toMatch(/private or local NuGet feeds are not supported in the sandbox yet \(https:\/\/pkgs\.example\.test\/feed\/nuget\/v3\/index\.json\)/);
    expect(r.reqs.some((q) => q.purpose === 'restore')).toBe(false);
  }, MULTI_RUN_MS);

  it('a real compile failure after a good restore is a normal code failure (base calibration, then a ci-fix lane)', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 1, output: 'src/App/Greet.cs(1,1): error CS1002: ; expected' }]);
    const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name).not.toBe('gate-install-needed');
    expect(r.reqs.some((q) => q.purpose === 'calibrate')).toBe(true);
    expect(r.reqs.some((q) => q.purpose === 'restore')).toBe(false);
    // The third lane is the ci-fix lane (unscripted here, so the run stops there).
    expect(lanes.started.length).toBeGreaterThanOrEqual(3);
  }, MULTI_RUN_MS);

  it('a node gate whose output names a NuGet error is judged as before (no restore, no NuGet park)', async () => {
    w = localWorld(['node', '--test']);
    const r = recorder([{ status: 1, output: OFFLINE }]);
    const lanes = lanesFor(w, [commitFile('src/greet.js', 'export const greet = () => "hi";\n'), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name).not.toBe('gate-install-needed');
    expect(r.reqs.some((q) => q.purpose === 'restore' || q.purpose === 'clean')).toBe(false);
    expect(r.reqs.some((q) => q.purpose === 'calibrate')).toBe(true);
  }, MULTI_RUN_MS);
});

/** A restore-phase NuGet line as the PR's own MSBuild code (an imported file no pin covers) prints it in the offline gate. */
const FAKE_RESTORE_LINE = 'C:\\work\\src\\App\\App.csproj : error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json.';
const IMPORTING_PROPS = '<Project>\n  <Import Project="$(MSBuildThisFileDirectory)build/common.msbuild" />\n</Project>\n';
const EVIL_MSBUILD = '<Project>\n  <Target Name="Evil" BeforeTargets="_GenerateRestoreGraph">\n    <Exec Command="echo RAN_EXEC_IN_RESTORE" />\n  </Target>\n</Project>\n';

describe('the networked restore evaluates only pinned definition files (H1)', () => {
  it('a head that changes only an unpinned imported file: the restore step never runs (M2: the engine cannot tell its sources)', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    mkdirSync(join(w.root, 'build'));
    writeFileSync(join(w.root, 'Directory.Build.props'), IMPORTING_PROPS);
    writeFileSync(join(w.root, 'build', 'common.msbuild'), '<Project />\n');
    gitIn(w.root, 'add', '.');
    gitIn(w.root, 'commit', '-q', '-m', 'an imported msbuild file');
    const r = recorder([{ status: 1, output: FAKE_RESTORE_LINE }]);
    const lanes = lanesFor(w, [commitFile('build/common.msbuild', EVIL_MSBUILD), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    // Not a definition change (no gate-definition-changed). Round 3 (M2): the imported .msbuild is absent from the
    // definition tree and could set the restore sources, so the restore step parks before it writes a tree.
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toContain('the build imports a file that is not a pinned definition file (Directory.Build.props: $(MSBuildThisFileDirectory)build/common.msbuild)');
    expect(r.reqs.some((q) => q.purpose === 'restore')).toBe(false);
    expect(r.trees).toHaveLength(0);
    expect(existsSync(treeDir())).toBe(false);
  }, MULTI_RUN_MS);

  it('the tree is written from git objects: an uncommitted edit of a pinned file in your checkout never reaches it', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }, { status: 0, output: 'Passed!' }]);
    const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]);
    // The working copy of the repository the blobs are read from says something else than any commit.
    writeFileSync(join(w.root, 'src', 'App', 'App.csproj'), '<Project><!-- WORKING COPY --></Project>\n');
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(r.trees[0]).toContainEqual(['src/App/App.csproj', CSPROJ]);
    expect(JSON.stringify(r.trees)).not.toMatch(/WORKING COPY/);
  }, MULTI_RUN_MS);
});

describe('the restore decision is not steered by the PR\'s output (M3)', () => {
  it('a test that prints error NU1301 after the test run started is a code failure: base calibration, no restore', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const output = ['  App -> C:\\work\\src\\App\\bin\\Debug\\net10.0\\App.dll', 'Test run for C:\\work\\tests\\bin\\Debug\\net10.0\\Tests.dll (.NETCoreApp,Version=v10.0)', 'Starting test execution, please wait...', FAKE_RESTORE_LINE, 'Failed!  - Failed:     1, Passed:     0, Skipped:     0, Total:     1'].join('\n');
    const r = recorder([{ status: 1, output }]);
    const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name).not.toBe('gate-install-needed');
    expect(r.reqs.some((q) => q.purpose === 'restore')).toBe(false);
    expect(r.reqs.some((q) => q.purpose === 'calibrate')).toBe(true);
  }, MULTI_RUN_MS);

  it('a real restore error that long output pushed out of the record\'s tail still parks (whole output), never a ci-fix lane', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const noise = Array.from({ length: 400 }, (_, i) => `  Build FAILED summary line ${i} ${'x'.repeat(40)}`).join('\n');
    const r = recorder([{ status: 1, output: `${OFFLINE}\n\nBuild FAILED.\n${noise}` }]);
    const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(lanes.started).toHaveLength(2);
    expect(r.reqs.some((q) => q.purpose === 'calibrate')).toBe(false);
  }, MULTI_RUN_MS);

  it('"restore tried" is in the run state: a rerun after the park does not open the network again', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }]);
    const first = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(first.gate?.name, first.message).toBe('gate-install-needed');
    expect(purposes(r).filter((p) => p === 'restore')).toHaveLength(1);
    // A new engine process (the human's rerun): the gate fails restoring again and parks without a second restore.
    const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(again.gate?.name, again.message).toBe('gate-install-needed');
    expect(again.gate?.reason).toMatch(/even after the sandboxed dotnet restore for this head ran/);
    expect(purposes(r).filter((p) => p === 'restore')).toHaveLength(1);
  }, MULTI_RUN_MS);
});

describe('the run\'s packages folder (M1)', () => {
  it('a folder an earlier run of the same slug left is never read and starts empty before the restore writes it', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    mkdirSync(join(nugetDir(), 'poisoned.pkg', '1.0.0'), { recursive: true });
    writeFileSync(join(nugetDir(), 'poisoned.pkg', '1.0.0', 'evil.targets'), '<Project />\n');
    const r = recorder([{ status: 1, output: OFFLINE }, { status: 0, output: 'Passed!' }]);
    const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('merge');
    const gates = r.reqs.filter((q) => q.purpose === 'gate');
    expect(gates[0].nugetPackages).toBeUndefined();
    expect(gates[1].nugetPackages).toEqual({ dir: nugetDir(), writable: false });
    expect(readdirSync(nugetDir())).toEqual(['humanizer.core']);
  }, MULTI_RUN_MS);

  it('a base calibration never reads the run\'s folder, and a base that cannot restore from your cache parks at gate-install-needed', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const compile = 'C:\\work\\src\\App\\Greet.cs(1,1): error CS1002: ; expected [C:\\work\\src\\App\\App.csproj]';
    const r = recorder([{ status: 1, output: OFFLINE }, { status: 1, output: compile }], undefined, { ran: true, status: 1, output: OFFLINE, timedOut: false });
    const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toMatch(/on the base [0-9a-f]{12} itself it could not restore its NuGet packages \(NU1301\) from your NuGet global packages folder/);
    const cal = r.reqs.filter((q) => q.purpose === 'calibrate');
    expect(cal.length).toBeGreaterThan(0);
    expect(cal.every((q) => q.nugetPackages === undefined)).toBe(true);
    expect(lanes.started).toHaveLength(2);
  }, MULTI_RUN_MS);
});

describe('the approval message (M2)', () => {
  it('with gateInstall "sandboxed" the gate-definition-changed park says the approval also lets the engine restore with nuget.org reachable', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const sandboxed = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/App.csproj', BUMPED)]), { gateSandbox: recorder([{ status: 0, output: 'Passed!' }]).sandbox, runUserConfig: SANDBOXED }));
    expect(sandboxed.gate?.name, sandboxed.message).toBe('gate-definition-changed');
    // The host's own text (restoreApprovalNote, both platforms' texts tested in nuget-restore.test.ts).
    expect(sandboxed.gate?.reason?.endsWith(restoreApprovalNote(process.platform))).toBe(true);
    expect(sandboxed.gate?.reason?.endsWith(process.platform === 'win32' ? 'api.nuget.org reachable, and the MSBuild targets in these files run during that restore; on Windows loopback and your local network are reachable from it too' : 'api.nuget.org reachable, and the MSBuild targets in these files run during that restore')).toBe(true);
  }, MULTI_RUN_MS);

  it('with "park" it says nothing about a restore', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const parked = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/App.csproj', BUMPED)]), { gateSandbox: recorder([{ status: 0, output: 'Passed!' }]).sandbox }));
    expect(parked.gate?.name, parked.message).toBe('gate-definition-changed');
    expect(parked.gate?.reason).not.toMatch(/dotnet restore/);
  }, MULTI_RUN_MS);
});

describe('the run\'s packages folder belongs to one definition (H1 -> H2)', () => {
  it('an approved bump restores at H1; a fix lane back at the base files (H2) never reads that folder, which is emptied first', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    // H1 offline: restore needed; H1 after the restore: a test the PR wrote fails (the base passes), so a ci-fix lane runs;
    // that lane goes back to the base's project file (H2), whose gate passes.
    const failing = { status: 1, output: 'Test run for C:\\work\\Tests.dll\nFailed!  - Failed:     1, Passed:     0, Skipped:     0, Total:     1' };
    const r = recorder([{ status: 1, output: OFFLINE }, failing, { status: 0, output: 'Passed!' }], undefined, { ran: true, status: 0, output: 'Passed!', timedOut: false });
    const parked = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/App.csproj', BUMPED)]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(parked.gate?.name, parked.message).toBe('gate-definition-changed');
    const lanes = lanesFor(w, [review('approve'), commitFile('src/App/App.csproj', CSPROJ), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox, runUserConfig: SANDBOXED, allowGateChange: true }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(purposes(r).filter((p) => p === 'restore')).toHaveLength(1);
    // H1's second gate reads the folder H1's restore wrote; H2 (the base's definition again) never does.
    const gates = r.reqs.filter((q) => q.purpose === 'gate');
    expect(gates.map((g) => g.nugetPackages ?? null)).toEqual([null, { dir: nugetDir(), writable: false }, null]);    expect(existsSync(nugetDir())).toBe(false);
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(state.nugetRestore).toBeUndefined();
    expect(state.history.some((h) => /^emptied the run's NuGet packages folder before the dotnet gate on [0-9a-f]{12}: it was restored for the definition files of [0-9a-f]{12}, which [0-9a-f]{12} does not have$/.test(h.note))).toBe(true);
  }, MULTI_RUN_MS);
});

describe('"restore tried" records what happened (the outcome, not the start)', () => {
  it('a restore that failed with the network is tried again on the rerun (a feed that failed only for now), and the state says it failed', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }], { ran: true, status: 1, output: OFFLINE, timedOut: false });
    const first = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(first.gate?.name, first.message).toBe('gate-install-needed');
    expect(first.gate?.reason).toMatch(/with only api\.nuget\.org reachable failed \(exit 1\).*then rerun omg factory run \S+, which runs the restore again/);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.nugetRestore).toMatchObject({ outcome: 'failed', exit: 1 });
    const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(again.gate?.name, again.message).toBe('gate-install-needed');
    expect(again.gate?.reason).not.toMatch(/even after/);
    expect(purposes(r).filter((p) => p === 'restore')).toHaveLength(2);
  }, MULTI_RUN_MS);

  it('a restore the sandbox could not start says nothing was restored, records not-run, and the rerun tries it again', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }], { ran: false, reason: 'the sandbox runtime is missing' });
    const first = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(first.gate?.name, first.message).toBe('gate-install-needed');
    expect(first.gate?.reason).toMatch(/could not run in the OS sandbox \(the sandbox runtime is missing\), so nothing was restored;.*\(a rerun tries the restore again\)/);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.nugetRestore).toMatchObject({ outcome: 'not-run' });
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.nugetRestore!.exit).toBeUndefined();
    const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(again.gate?.reason).not.toMatch(/even after/);
    expect(purposes(r).filter((p) => p === 'restore')).toHaveLength(2);
  }, MULTI_RUN_MS);

  it('a state from the previous release (head and definition, no outcome) does not stop the restore', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }], { ran: false, reason: 'the sandbox runtime is missing' });
    await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    // What the previous release wrote before the sandbox started (and never updated): head and definition only; a write
    // the engine made, recorded in its ledger.
    const ledger = EngineLedger.open(w.ledgerDir, w.root, LOCAL_ISSUE);
    updateFactoryState(w.root, LOCAL_ISSUE, (s) => ({ ...s!, nugetRestore: { head: s!.nugetRestore!.head, definition: s!.nugetRestore!.definition } }), { onWrite: (p, c) => ledger.record(p, c) });
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.nugetRestore!.outcome).toBeUndefined();
    const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(again.gate?.reason, again.message).toMatch(/could not run in the OS sandbox/);
    expect(purposes(r).filter((p) => p === 'restore')).toHaveLength(2);
  }, MULTI_RUN_MS);
});

describe('the restore runs the gate that will run (L3: sealed ?? gate)', () => {
  it('on a rerun the restore is derived from the sealed gate argv (projects, -p:, -r), and a changed configured gate is refused before any restore', async () => {
    const gate = ['dotnet', 'test', 'App.sln', '-p:NuGetAudit=false', '-r', 'win-x64'];
    w = localWorld(gate);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }, { status: 1, output: OFFLINE }, { status: 0, output: 'Passed!' }]);
    // gateInstall "park" first: the gate runs once (sealing its argv) and parks; then "sandboxed" on the rerun.
    const first = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox }));
    expect(first.gate?.name, first.message).toBe('gate-install-needed');
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.localGate).toEqual(gate);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(r.reqs.find((q) => q.purpose === 'restore')!.argv).toEqual(['dotnet', 'restore', 'App.sln', '-p:NuGetAudit=false', '-r', 'win-x64']);
    // Another configured gate than the sealed one never reaches the restore: the run refuses it.
    rmSync(w.dir, { recursive: true, force: true });
    w = localWorld(gate);
    baseProject();
    const r2 = recorder([{ status: 1, output: OFFLINE }]);
    await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r2.sandbox }));
    const base = localOpts(w, lanesFor(w, []), { gateSandbox: r2.sandbox, runUserConfig: SANDBOXED });
    const other = { ...w.config, local: { ...w.config.local!, gate: ['dotnet', 'test', 'Other.sln'] } };
    const refused = await runFactoryEngine({ ...base, forge: { ...base.forge!, config: other } });
    expect(refused.gate?.name, refused.message).toBe('gates');
    expect(refused.gate?.reason).toMatch(/refuses the local gate `dotnet test Other\.sln`: this run recorded `dotnet test App\.sln -p:NuGetAudit=false -r win-x64`/);
    expect(r2.reqs.some((q) => q.purpose === 'restore')).toBe(false);
  }, MULTI_RUN_MS);
});

describe('a repository with a committed root nuget.config (the shared layout)', () => {
  const ROOT_CONFIG = '<?xml version="1.0" encoding="utf-8"?>\n<configuration>\n  <packageSources>\n    <clear />\n    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />\n  </packageSources>\n</configuration>\n';
  /** What the Windows sandbox printed when NuGet's walk up from a checkout under <repo>/.omg reached your working tree's own file. */
  const DENIED = "C:\\Program Files\\dotnet\\sdk\\10.0.101\\NuGet.targets(780,5): error : Failed to read NuGet.Config due to unauthorized access. Path: 'C:\\repo\\NuGet.Config'. [C:\\repo\\.omg\\team\\factory-run\\worktrees\\issue-7\\src\\App\\App.csproj]\nC:\\Program Files\\dotnet\\sdk\\10.0.101\\NuGet.targets(780,5): error :   Access to the path 'C:\\repo\\NuGet.Config' is denied.\n";
  const dotnetReqs = (r: Recorder) => r.reqs.filter((q) => q.exe === 'dotnet' || /dotnet(?:\.exe)?$/i.test(q.exe));

  it('the restore tree holds the head\'s own nuget.config (no stub of that name), no request asks for NuGet\'s hierarchy, and the note says which file NuGet read', async () => {
    w = localWorld(['dotnet', 'test']);
    writeFileSync(join(w.root, 'NuGet.Config'), ROOT_CONFIG);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }, { status: 0, output: 'Passed!' }]);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(purposes(r)).toEqual(['gate', 'clean', 'restore', 'gate']);
    const tree = r.trees[0];
    expect(tree.find(([p]) => p === 'NuGet.Config')).toEqual(['NuGet.Config', ROOT_CONFIG]);
    expect(tree.some(([p]) => p === 'nuget.config')).toBe(false);
    expect(dotnetReqs(r).length).toBeGreaterThan(0);
    expect(r.reqs.every((q) => q.nugetHierarchy === undefined)).toBe(true);
    const note = readFactoryState(w.root, LOCAL_ISSUE)!.history.find((h) => h.note.startsWith('dotnet restore ran in the OS sandbox'))!.note;
    expect(note).toMatch(/which stop MSBuild's walk up out of the tree; NuGet read only the tree's root nuget\.config \(the head's own\);/);
    expect(note).not.toMatch(/NuGet's walk/);
  }, MULTI_RUN_MS);

  it('no root config: the engine\'s nuget.org-only stub, and the note says so', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }, { status: 0, output: 'Passed!' }]);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.history.some((h) => /NuGet read only the tree's root nuget\.config \(the engine's, nuget\.org only\)/.test(h.note))).toBe(true);
  }, MULTI_RUN_MS);

  it('a gate NuGet could not read its config for parks at gate-install-needed naming the file: no restore step, no ci-fix lane, no FAILURE record', async () => {
    w = localWorld(['dotnet', 'test']);
    writeFileSync(join(w.root, 'nuget.config'), ROOT_CONFIG);
    baseProject();
    const r = recorder([{ status: 1, output: DENIED }]);
    const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toContain('NuGet could not read the NuGet config "C:\\repo\\NuGet.Config" (no package was tried, so this says nothing about the code)');
    expect(out.gate?.reason).toContain('a sandboxed dotnet command reads one NuGet config, the root nuget.config of its checkout');
    expect(purposes(r)).toEqual(['gate']);
    expect(lanes.started).toHaveLength(2);
    const head = readFactoryState(w.root, LOCAL_ISSUE)!.head!;
    expect(existsSync(localCheckRecordPath(w.stateDir, w.root, head))).toBe(false);
  }, MULTI_RUN_MS);

  it('a trusted base that pins a nuget.config below its root: every dotnet request reads NuGet\'s own hierarchy, and the park names the lower file and the private layout', async () => {
    w = localWorld(['dotnet', 'test']);
    writeFileSync(join(w.root, 'nuget.config'), ROOT_CONFIG);
    mkdirSync(join(w.root, 'src', 'App'), { recursive: true });
    writeFileSync(join(w.root, 'src', 'App', 'nuget.config'), '<configuration />\n');
    baseProject();
    const r = recorder([{ status: 1, output: DENIED }]);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toContain('the repository pins a nuget.config below its root (src/App/nuget.config');
    expect(out.gate?.reason).toContain('factory.run.layout "private"');
    const gates = r.reqs.filter((q) => q.purpose === 'gate');
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every((q) => q.nugetHierarchy?.includes('src/App/nuget.config'))).toBe(true);
  }, MULTI_RUN_MS);

  it('H2: a pinned project that sets RestoreSources: no request lets the engine add nuget.org', async () => {
    w = localWorld(['dotnet', 'test']);
    writeFileSync(join(w.root, 'nuget.config'), '<configuration><packageSources><add key="corp" value="C:\\corp" /></packageSources></configuration>\n');
    baseProject();
    writeFileSync(join(w.root, 'src', 'App', 'App.csproj'), CSPROJ.replace('</PropertyGroup>', '  <RestoreSources>C:\\corp</RestoreSources>\n  </PropertyGroup>'));
    gitIn(w.root, 'commit', '-q', '-am', 'restore sources');
    const r = recorder([{ status: 0, output: 'Passed!' }]);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(dotnetReqs(r).length).toBeGreaterThan(0);
    expect(dotnetReqs(r).every((q) => q.nugetNoAddSource === true && q.nugetHierarchy === undefined)).toBe(true);
  }, MULTI_RUN_MS);

  it('M2 (round 3): an Exists-guarded import of a file that is not pinned: nothing is added and the restore step parks before it writes a tree', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    writeFileSync(join(w.root, 'Directory.Build.props'), '<Project>\n  <Import Project="eng/Sources.msbuild" Condition="Exists(\'eng/Sources.msbuild\')" />\n</Project>\n');
    mkdirSync(join(w.root, 'eng'), { recursive: true });
    writeFileSync(join(w.root, 'eng', 'Sources.msbuild'), '<Project><PropertyGroup><RestoreSources>C:\\corp</RestoreSources></PropertyGroup></Project>\n');
    gitIn(w.root, 'add', '-A');
    gitIn(w.root, 'commit', '-q', '-m', 'unpinned import');
    const r = recorder([{ status: 1, output: OFFLINE }]);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toContain('the build imports a file that is not a pinned definition file (Directory.Build.props: eng/Sources.msbuild), so the engine cannot tell which package sources the repository uses');
    expect(out.gate?.reason).toContain('move those settings into a .props file');
    expect(r.reqs.some((q) => q.purpose === 'restore')).toBe(false);
    expect(r.trees).toHaveLength(0);
    expect(dotnetReqs(r).every((q) => q.nugetNoAddSource === true)).toBe(true);
  }, MULTI_RUN_MS);

  it('M2 (round 3): an ordinary import of a pinned .props file restores as before', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    writeFileSync(join(w.root, 'Directory.Build.props'), '<Project>\n  <Import Project="$(MSBuildThisFileDirectory)eng\\Versions.props" />\n</Project>\n');
    mkdirSync(join(w.root, 'eng'), { recursive: true });
    writeFileSync(join(w.root, 'eng', 'Versions.props'), '<Project />\n');
    gitIn(w.root, 'add', '-A');
    gitIn(w.root, 'commit', '-q', '-m', 'versions import');
    const r = recorder([{ status: 1, output: OFFLINE }, { status: 0, output: 'Passed!' }]);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(purposes(r)).toEqual(['gate', 'clean', 'restore', 'gate']);
    expect(dotnetReqs(r).every((q) => q.nugetNoAddSource === undefined)).toBe(true);
  }, MULTI_RUN_MS);

  it('H1 (round 3): a root config that only adds a local folder feed: a package only on nuget.org parks saying the file lists no nuget.org source', async () => {
    w = localWorld(['dotnet', 'test']);
    writeFileSync(join(w.root, 'nuget.config'), '<configuration><packageSources><add key="corp" value="C:\\corp" /></packageSources></configuration>\n');
    baseProject();
    const r = recorder([{ status: 1, output: 'C:\\repo\\src\\App\\App.csproj : error NU1101: Unable to find package Humanizer.Core. No packages exist with this id in source(s): corp\n' }]);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toContain("the repository's root nuget.config lists no nuget.org source, and the sandbox reads that file alone");
    expect(out.gate?.reason).toContain('<add key="nuget.org" value="https://api.nuget.org/v3/index.json" />');
    expect(r.reqs.some((q) => q.purpose === 'restore')).toBe(false);
  }, MULTI_RUN_MS);

  it('M1: a root config that maps packages to the nuget.org key it does not define keeps NuGet\'s hierarchy, and the park says so', async () => {
    w = localWorld(['dotnet', 'test']);
    writeFileSync(join(w.root, 'nuget.config'), '<configuration><packageSources><add key="corp" value="https://corp.example.test/v3/index.json" /></packageSources><packageSourceMapping><packageSource key="nuget.org"><package pattern="*" /></packageSource></packageSourceMapping></configuration>\n');
    baseProject();
    const r = recorder([{ status: 1, output: DENIED }]);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toContain('maps packages to the source key(s) nuget.org, which it does not define');
    expect(out.gate?.reason).toContain('factory.run.layout "private"');
    expect(dotnetReqs(r).every((q) => q.nugetHierarchy?.includes('source key(s) nuget.org'))).toBe(true);
    expect(purposes(r)).toEqual(['gate']);
  }, MULTI_RUN_MS);

  it('M2: a lower nuget.config the head adds is named in the approval park, and once approved the gate and the restore read NuGet\'s hierarchy', async () => {
    w = localWorld(['dotnet', 'test']);
    writeFileSync(join(w.root, 'nuget.config'), ROOT_CONFIG);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }, { status: 0, output: 'Passed!' }]);
    const lower = '<configuration><packageSources><clear /><add key="corp" value="https://corp.example.test/v3/index.json" /></packageSources></configuration>\n';
    const parked = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/nuget.config', lower)]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(parked.gate?.name, parked.message).toBe('gate-definition-changed');
    expect(parked.gate?.reason).toContain('adds, changes or removes a nuget.config below the repository root (src/App/nuget.config)');
    expect(parked.gate?.reason).toContain("read NuGet's own config hierarchy");
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED, allowGateChange: true }));
    expect(out.gate?.name, out.message).toBe('merge');
    const run = r.reqs.filter((q) => q.purpose === 'gate' || q.purpose === 'restore');
    expect(run.map((q) => q.purpose)).toEqual(['gate', 'restore', 'gate']);
    expect(run.every((q) => q.nugetHierarchy?.includes('src/App/nuget.config'))).toBe(true);
  }, MULTI_RUN_MS);

  it('M3: MSBuild project SDKs from NuGet with a nuget.config above the checkout park before the gate, naming the SDK and the private layout', async () => {
    w = localWorld(['dotnet', 'build', 'A/A.proj']);
    writeFileSync(join(w.root, 'nuget.config'), ROOT_CONFIG);
    baseProject();
    mkdirSync(join(w.root, 'A'));
    writeFileSync(join(w.root, 'A', 'A.proj'), '<Project Sdk="Microsoft.Build.NoTargets/3.7.56"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n');
    gitIn(w.root, 'add', '.');
    gitIn(w.root, 'commit', '-q', '-m', 'sdk');
    const r = recorder([{ status: 0, output: 'Build succeeded.' }]);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toContain('MSBuild project SDKs resolved from NuGet (A/A.proj: Microsoft.Build.NoTargets/3.7.56)');
    expect(out.gate?.reason).toContain('ignores RestoreConfigFile');
    expect(out.gate?.reason).toContain('factory.run.layout "private"');
    expect(r.reqs.filter((q) => q.purpose === 'gate')).toEqual([]);
  }, MULTI_RUN_MS);
});

describe('NU1603: a version NuGet replaced never passes silently', () => {
  const NU1603 = 'C:\\w\\src\\App\\App.csproj : warning NU1603: App depends on Newtonsoft.Json (>= 13.0.2) but Newtonsoft.Json 13.0.2 was not found. Newtonsoft.Json 13.0.3 was resolved instead.\n  Restored C:\\w\\src\\App\\App.csproj (in 400 ms).\n  App -> C:\\w\\src\\App\\bin\\App.dll\nPassed!';

  it('a passing gate with NU1603: not counted; with "sandboxed" the restore runs, and the clean gate after it passes', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 0, output: NU1603 }, { status: 0, output: 'Passed!' }]);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(purposes(r)).toEqual(['gate', 'clean', 'restore', 'gate']);
  }, MULTI_RUN_MS);

  it('with "park": parks naming NU1603 and NuGet\'s message; no record counts the gate', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 0, output: NU1603 }]);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toContain('NuGet took others (NU1603: App depends on Newtonsoft.Json (>= 13.0.2)');
    const head = readFactoryState(w.root, LOCAL_ISSUE)!.head!;
    expect(existsSync(localCheckRecordPath(w.stateDir, w.root, head))).toBe(false);
  }, MULTI_RUN_MS);

  it('a networked restore that exits 0 with NU1603 is a failed restore and parks', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const r = recorder([{ status: 1, output: OFFLINE }], { ran: true, status: 0, output: NU1603.split('\n')[0], timedOut: false });
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: r.sandbox, runUserConfig: SANDBOXED }));
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toContain('failed (exit 0, NU1603)');
    expect(out.gate?.reason).toContain('the gate runs offline, where NuGet cannot repeat that resolution');
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.nugetRestore?.outcome).toBe('failed');
  }, MULTI_RUN_MS);
});

describe('a nuget.config below the root that only nuget.org could bypass (PR 611 round 4)', () => {
  const LOWER = '<configuration><packageSources><clear /><add key="corp" value="C:\corp-feed" /></packageSources></configuration>\n';
  const SETTINGS_ONLY = '<configuration><config><add key="x" value="y" /></config></configuration>\n';
  const LIB = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Humanizer.Core" Version="2.14.1" /></ItemGroup></Project>\n';
  const COMPILE = 'src/App/Greet.cs(1,1): error CS1002: ; expected';
  interface Seen { purpose: string; env: Record<string, string>; fallback: boolean }

  /** What a sandboxed dotnet command in `cwd` gets: the builder sandbox-exec.ts and job.ts call (sandboxNugetConfig), with the request's or lane's fields. */
  function effective(cwd: string, hierarchy: string | undefined, noAdd: boolean | undefined, fromGit?: boolean): Omit<Seen, 'purpose'> {
    const prof = mkdtempSync(join(w.dir, 'prof-'));
    const cfg = sandboxNugetConfig(cwd, prof, process.platform, { hierarchy, noAdd: noAdd === true, fromGit: fromGit === true });
    return { env: dotnetSandboxEnv(prof, {}, prof, process.platform, undefined, cfg).env, fallback: existsSync(join(prof, 'nuget', 'nuget.config')) };
  }

  /** The repository: src/App plus Lib/Lib.csproj (a package only on nuget.org); Lib/nuget.config on the base when `lowerOnBase`. */
  function project(rootConfig: string | null, lowerOnBase: boolean): void {
    if (rootConfig) writeFileSync(join(w.root, 'nuget.config'), rootConfig);
    mkdirSync(join(w.root, 'Lib'), { recursive: true });
    writeFileSync(join(w.root, 'Lib', 'Lib.csproj'), LIB);
    if (lowerOnBase) writeFileSync(join(w.root, 'Lib', 'nuget.config'), LOWER);
    baseProject();
  }

  /** Expect hierarchy mode: no RestoreConfigFile, no nuget.org added, no nuget.org-only file written. */
  const hierarchyOnly = (seen: Seen[]) => {
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s, s.purpose).toMatchObject({ fallback: false });
      expect(s.env.RestoreConfigFile, s.purpose).toBeUndefined();
      expect(s.env.RestoreAdditionalProjectSources, s.purpose).toBeUndefined();
    }
  };

  for (const rootConfig of [null, SETTINGS_ONLY]) {
    const rootLabel = rootConfig ? 'a settings-only root config' : 'no root config';
    for (const where of ['base', 'approved head'] as const) {
      it(`${rootLabel}, the lower config on the ${where}: the offline gate, the networked restore and the ci-fix lane all keep NuGet's hierarchy`, async () => {
        w = localWorld(['dotnet', 'test']);
        project(rootConfig, where === 'base');
        const seen: Seen[] = [];
        const r = recorder([{ status: 1, output: OFFLINE }, { status: 1, output: COMPILE }]);
        const inner = r.sandbox;
        const sandbox: SandboxRunner = async (req) => {
          if (req.purpose === 'gate' || req.purpose === 'restore') seen.push({ purpose: req.purpose, ...effective(req.cwd, req.nugetHierarchy, req.nugetNoAddSource, req.nugetFromGit) });
          return inner(req);
        };
        const fix: LaneScript = (ctx) => {
          seen.push({ purpose: 'lane', ...effective(ctx.worktree, ctx.input.dotnet ? ctx.input.dotnetNugetHierarchy : 'not a dotnet lane', ctx.input.dotnetNugetNoAddSource) });
          return commitFile('src/App/Greet.cs', 'namespace App; // fixed\n')(ctx);
        };
        if (where === 'base') {
          await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve'), fix]), { gateSandbox: sandbox, runUserConfig: SANDBOXED }));
        } else {
          const parked = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('Lib/nuget.config', LOWER)]), { gateSandbox: sandbox, runUserConfig: SANDBOXED }));
          expect(parked.gate?.name, parked.message).toBe('gate-definition-changed');
          expect(parked.gate?.reason).toContain('(Lib/nuget.config)');
          await runFactoryEngine(localOpts(w, lanesFor(w, [review('approve'), fix]), { gateSandbox: sandbox, runUserConfig: SANDBOXED, allowGateChange: true }));
        }
        expect(seen.map((s) => s.purpose).slice(0, 4)).toEqual(['gate', 'restore', 'gate', 'lane']);
        hierarchyOnly(seen);
        expect(r.reqs.filter((q) => q.purpose === 'gate' || q.purpose === 'restore').every((q) => q.nugetHierarchy?.includes('Lib/nuget.config'))).toBe(true);
      }, MULTI_RUN_MS);
    }
  }

  it('round 5 (msb-settings): an approved head adds RestoreSources in Lib/Directory.Build.props under a settings-only root config: the gate, the restore step and the ci-fix lane never add nuget.org', async () => {
    w = localWorld(['dotnet', 'test']);
    project(SETTINGS_ONLY, false);
    const seen: Seen[] = [];
    const r = recorder([{ status: 1, output: OFFLINE }, { status: 1, output: COMPILE }]);
    const inner = r.sandbox;
    const sandbox: SandboxRunner = async (req) => {
      if (req.purpose === 'gate' || req.purpose === 'restore') seen.push({ purpose: req.purpose, ...effective(req.cwd, req.nugetHierarchy, req.nugetNoAddSource, req.nugetFromGit) });
      return inner(req);
    };
    const fix: LaneScript = (ctx) => {
      seen.push({ purpose: 'lane', ...effective(ctx.worktree, ctx.input.dotnetNugetHierarchy, ctx.input.dotnetNugetNoAddSource) });
      return commitFile('src/App/Greet.cs', 'namespace App; // fixed\n')(ctx);
    };
    const parked = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('Lib/Directory.Build.props', '<Project><PropertyGroup><RestoreSources>C:\\corp-feed</RestoreSources></PropertyGroup></Project>\n')]), { gateSandbox: sandbox, runUserConfig: SANDBOXED }));
    expect(parked.gate?.name, parked.message).toBe('gate-definition-changed');
    await runFactoryEngine(localOpts(w, lanesFor(w, [review('approve'), fix]), { gateSandbox: sandbox, runUserConfig: SANDBOXED, allowGateChange: true }));
    expect(seen.map((s) => s.purpose)).toContain('lane');
    for (const s of seen) {
      expect(s.env.RestoreConfigFile, s.purpose).toMatch(/nuget\.config$/);
      expect(s.env.RestoreAdditionalProjectSources, s.purpose).toBeUndefined();
    }
    // Every engine request carries its git decision, so the sandbox layer skips its tree scan; all but the base
    // calibration (the base alone sets no RestoreSources, and it runs offline) run on the head and add nothing.
    const dotnet = r.reqs.filter((q) => q.exe === 'dotnet' || /dotnet(?:\.exe)?$/i.test(q.exe));
    expect(dotnet.map((q) => [q.purpose, q.nugetFromGit === true])).toEqual(dotnet.map((q) => [q.purpose, true]));
    expect(dotnet.filter((q) => q.purpose !== 'calibrate').map((q) => [q.purpose, q.nugetNoAddSource === true])).toEqual(dotnet.filter((q) => q.purpose !== 'calibrate').map((q) => [q.purpose, true]));
  }, MULTI_RUN_MS);
});

/**
 * The NuGet restore step of a dotnet gate on the local forge engine
 * (nuget-restore.ts): fake lanes, a real repository and prepare checkout,
 * the test sandbox. No dotnet, network, gh or copilot runs.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localCheckRecordPath } from '../../../forge/local/index.js';
import { runFactoryEngine } from '../engine.js';
import { cleanFactoryRun } from '../clean.js';
import { readFactoryState, requestFactoryCancel } from '../state.js';
import type { SandboxRunner, SandboxRunRequest, SandboxRunResult } from '../sandbox-exec.js';
import { attestedSandbox, commitFile, gitIn, review } from './fake-lanes.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';

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
    expect(r.trees).toEqual([[['App.sln', 'Microsoft Visual Studio Solution File\n'], ['src/App/App.csproj', CSPROJ]]]);
    expect(existsSync(treeDir())).toBe(false);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.nugetRestore).toEqual({ head: readFactoryState(w.root, LOCAL_ISSUE)!.head, definition: expect.stringMatching(/^[0-9a-f]{64}$/) });
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
  it('a head that changes only an unpinned imported file: the restore tree holds exactly the head\'s pattern-matched files, none of the changed ones', async () => {
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
    // Not a definition change (no gate-definition-changed); the restore ran once, in the tree, and the gate that still
    // prints the line parks.
    expect(out.gate?.name, out.message).toBe('gate-install-needed');
    expect(out.gate?.reason).toMatch(/even after the sandboxed dotnet restore for this head ran/);
    expect(purposes(r)).toEqual(['gate', 'clean', 'restore', 'gate']);
    const head = readFactoryState(w.root, LOCAL_ISSUE)!.head!;
    const pinned = gitIn(w.root, 'ls-tree', '-r', '--name-only', head).split('\n').map((l) => l.trim()).filter((p) => /(?:\.sln|\.csproj|\.props)$/.test(p)).sort();
    expect(r.trees).toHaveLength(1);
    expect(r.trees[0].map(([p]) => p)).toEqual(pinned);
    expect(r.trees[0].map(([p]) => p)).toEqual(['App.sln', 'Directory.Build.props', 'src/App/App.csproj']);
    expect(r.trees[0].some(([p, text]) => p.startsWith('build/') || text.includes('RAN_EXEC_IN_RESTORE'))).toBe(false);
    expect(r.reqs.find((q) => q.purpose === 'restore')!.cwd).toBe(treeDir());
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
    expect(sandboxed.gate?.reason).toMatch(/\. With factory\.run\.gateInstall "sandboxed", approving with --allow-gate-change also lets the engine run dotnet restore on these definition files with api\.nuget\.org reachable$/);
  }, MULTI_RUN_MS);

  it('with "park" it says nothing about a restore', async () => {
    w = localWorld(['dotnet', 'test']);
    baseProject();
    const parked = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/App.csproj', BUMPED)]), { gateSandbox: recorder([{ status: 0, output: 'Passed!' }]).sandbox }));
    expect(parked.gate?.name, parked.message).toBe('gate-definition-changed');
    expect(parked.gate?.reason).not.toMatch(/dotnet restore/);
  }, MULTI_RUN_MS);
});

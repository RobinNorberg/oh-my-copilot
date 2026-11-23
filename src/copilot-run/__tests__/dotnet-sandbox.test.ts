/**
 * dotnet-sandbox.ts: which commands count as dotnet, the -m:1 rewrite, the
 * NuGet packages folder lookup and the env a sandboxed dotnet gets.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DOTNET_SINGLE_NODE_FLAG, dotnetNugetConfig, dotnetSandboxArgs, dotnetSandboxEnv, isDotnetExe, isMtpGlobalJson, isNugetHost, msbuildEscape, NUGET_CONFIG_READ_MAX, NUGET_ORG_ONLY_CONFIG, NUGET_ORG_SOURCE, nugetConfigVerdict, nugetPackagesDir, nugetPackagesGrant, readRegularFileBounded, rootNugetConfig } from '../dotnet-sandbox.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omg-dotnet-sandbox-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('isDotnetExe', () => {
  it('is the dotnet host by name or path, in any case, and nothing else', () => {
    for (const exe of ['dotnet', 'dotnet.exe', 'DOTNET.EXE', 'C:\\Program Files\\dotnet\\dotnet.exe', '/usr/share/dotnet/dotnet']) expect(isDotnetExe(exe), exe).toBe(true);
    for (const exe of [undefined, '', 'node', 'C:\\tools\\dotnet-test.exe', '/usr/bin/dotnetx', 'npm', 'dotnet.cmd']) expect(isDotnetExe(exe), String(exe)).toBe(false);
  });
});

describe('dotnetSandboxArgs', () => {
  it('adds -m:1 to an MSBuild subcommand, before any --', () => {
    expect(dotnetSandboxArgs(['test'])).toEqual(['test', DOTNET_SINGLE_NODE_FLAG]);
    expect(dotnetSandboxArgs(['build', '-c', 'Release'])).toEqual(['build', '-c', 'Release', '-m:1']);
    expect(dotnetSandboxArgs(['test', '--', 'RunConfiguration.MaxCpuCount=2'])).toEqual(['test', '-m:1', '--', 'RunConfiguration.MaxCpuCount=2']);
    expect(dotnetSandboxArgs(['Restore'])).toEqual(['Restore', '-m:1']);
  });

  it('appends -m:1 after an explicit node count too (MSBuild\'s last switch wins), and leaves other subcommands and option-first argv alone', () => {
    for (const flag of ['-m', '-m:4', '/m', '-maxcpucount', '-maxCpuCount:2', '/maxcpucount:1', '--maxcpucount:4', '--m:2']) expect(dotnetSandboxArgs(['build', flag])).toEqual(['build', flag, '-m:1']);
    // After `--` a -m is the app's or the test's, not MSBuild's.
    expect(dotnetSandboxArgs(['test', '--', '-m:4'])).toEqual(['test', '-m:1', '--', '-m:4']);
    for (const args of [[], ['--info'], ['format'], ['tool', 'restore'], ['exec', 'x.dll'], ['--diagnostics', 'build']]) expect(dotnetSandboxArgs(args)).toEqual(args);
  });

  it('never touches dotnet run (the flag would reach the program\'s argv)', () => {
    for (const args of [['run'], ['run', '--project', 'src/App'], ['RUN', '--no-build', '--', 'x'], ['run', '-c', 'Release']]) expect(dotnetSandboxArgs(args)).toEqual(args);
  });

  it('dotnet test <file>.dll|.exe (VSTest, no MSBuild, rejects -m:1) is left alone; a project or a .dll after -- is not', () => {
    for (const args of [['test', 'bin/App.Tests.dll'], ['test', 'out\\App.Tests.DLL', '--logger', 'trx'], ['test', '-c', 'Release', 'App.Tests.exe']]) expect(dotnetSandboxArgs(args)).toEqual(args);
    expect(dotnetSandboxArgs(['test', 'tests/App.Tests.csproj'])).toEqual(['test', 'tests/App.Tests.csproj', '-m:1']);
    expect(dotnetSandboxArgs(['test', '--', 'x.dll'])).toEqual(['test', '-m:1', '--', 'x.dll']);
    expect(dotnetSandboxArgs(['build', 'x.dll'])).toEqual(['build', 'x.dll', '-m:1']);
  });

  it('F6: an option\'s value is not a test file (--diag log.exe, --logger "trx;LogFileName=a.dll", --settings x.dll), and an option with its own value takes none', () => {
    for (const args of [['test', '--diag', 'log.exe'], ['test', '--logger', 'trx;LogFileName=a.dll'], ['test', '-l', 'x.dll'], ['test', '--results-directory', 'r.exe'], ['test', '--settings', 'x.dll'], ['test', '-a', 'adapters.dll']]) {
      expect(dotnetSandboxArgs(args), args.join(' ')).toEqual([...args, '-m:1']);
    }
    // `--diag:log.exe` carries its value: the next word is positional again.
    expect(dotnetSandboxArgs(['test', '--diag:log.txt', 'App.Tests.dll'])).toEqual(['test', '--diag:log.txt', 'App.Tests.dll']);
    expect(dotnetSandboxArgs(['test', '--diag', 'log.txt', 'App.Tests.dll'])).toEqual(['test', '--diag', 'log.txt', 'App.Tests.dll']);
  });

  it('F3: in Microsoft.Testing.Platform mode dotnet test gets no -m:1 (it rejects it); build still does', () => {
    expect(dotnetSandboxArgs(['test'], { mtp: true })).toEqual(['test']);
    expect(dotnetSandboxArgs(['test', '--project', 'Tests'], { mtp: true })).toEqual(['test', '--project', 'Tests']);
    expect(dotnetSandboxArgs(['build'], { mtp: true })).toEqual(['build', '-m:1']);
    expect(dotnetSandboxArgs(['test'], { mtp: false })).toEqual(['test', '-m:1']);
  });

  it('isMtpGlobalJson: global.json test.runner Microsoft.Testing.Platform, comments allowed; anything else is VSTest', () => {
    expect(isMtpGlobalJson('{ "test": { "runner": "Microsoft.Testing.Platform" } }')).toBe(true);
    expect(isMtpGlobalJson('﻿// pin\n{ "sdk": { "version": "10.0.101" }, /* mtp */ "test": { "runner": "microsoft.testing.platform" }, }')).toBe(true);
    for (const t of [undefined, '', '{}', '{ "test": { "runner": "VSTest" } }', '{ "test": "Microsoft.Testing.Platform" }', 'not json', '{ "sdk": { "runner": "Microsoft.Testing.Platform" } }']) {
      expect(isMtpGlobalJson(t), String(t)).toBe(false);
    }
  });

  it('isNugetHost: api.nuget.org or *.nuget.org only', () => {
    for (const h of ['api.nuget.org', '*.nuget.org', ' API.NuGet.org ']) expect(isNugetHost(h), h).toBe(true);
    for (const h of ['nuget.org.evil.test', 'registry.npmjs.org', 'pkgs.dev.azure.com', '']) expect(isNugetHost(h), h).toBe(false);
  });
});

describe('nugetPackagesDir', () => {
  it('NUGET_PACKAGES when absolute, else ~/.nuget/packages; only an existing directory', () => {
    const home = join(dir, 'home');
    expect(nugetPackagesDir({}, home)).toBeNull();
    mkdirSync(join(home, '.nuget', 'packages'), { recursive: true });
    expect(nugetPackagesDir({}, home)).toBe(join(home, '.nuget', 'packages'));
    const own = join(dir, 'cache');
    mkdirSync(own);
    expect(nugetPackagesDir({ NUGET_PACKAGES: own }, home)).toBe(own);
    expect(nugetPackagesDir({ nuget_packages: own }, home)).toBe(own);
    // A relative value would resolve against whatever the cwd is: the home default instead.
    expect(nugetPackagesDir({ NUGET_PACKAGES: 'cache' }, home)).toBe(join(home, '.nuget', 'packages'));
    // A missing dir or a file is no grant.
    expect(nugetPackagesDir({ NUGET_PACKAGES: join(dir, 'missing') }, home)).toBeNull();
    writeFileSync(join(dir, 'file'), '');
    expect(nugetPackagesDir({ NUGET_PACKAGES: join(dir, 'file') }, home)).toBeNull();
  });

  it('F9: a NUGET_PACKAGES that is the home dir, above it, a filesystem root, or inside or above an OMC root is refused with a note', () => {
    const home = join(dir, 'home');
    const omg = join(home, '.omg');
    mkdirSync(join(omg, 'state', 'cache'), { recursive: true });
    const own = join(dir, 'cache');
    mkdirSync(own);
    const grant = (p: string) => nugetPackagesGrant({ NUGET_PACKAGES: p }, home, [omg]);
    for (const [p, why] of [[home, /your home dir or a dir above it/], [dir, /your home dir or a dir above it/], [`${home}${process.platform === 'win32' ? '\\' : '/'}`, /home dir/],
      [join(omg, 'state', 'cache'), /inside or above the OMC config or state dir/], [omg, /OMC/], [process.platform === 'win32' ? 'C:\\' : '/', /a filesystem root/]] as const) {
      const out = grant(p);
      expect(out.dir, p).toBeNull();
      expect(out.note, p).toMatch(why);
      expect(out.note).toMatch(/is not granted to the sandbox/);
    }
    expect(grant(own)).toEqual({ dir: own });
    // Case-folded on Windows only.
    if (process.platform === 'win32') expect(grant(home.toUpperCase()).dir).toBeNull();
    // dotnetSandboxEnv names no folder and passes the note on.
    const env = dotnetSandboxEnv(join(dir, 'profile'), { NUGET_PACKAGES: home }, home, 'linux');
    expect(env.env.NUGET_PACKAGES).toBeUndefined();
    expect(env.readonly).toEqual([]);
    expect(env.notes).toHaveLength(1);
  });
});

describe('dotnetSandboxEnv', () => {
  it('win32: APPDATA in the job profile, the packages folder named and granted read-only', () => {
    const home = join(dir, 'home');
    mkdirSync(join(home, '.nuget', 'packages'), { recursive: true });
    const profile = join(dir, 'job', 'profile');
    const out = dotnetSandboxEnv(profile, { APPDATA: join(home, 'AppData', 'Roaming') }, home, 'win32');
    expect(out.env.APPDATA).toBe(join(profile, 'AppData', 'Roaming'));
    expect(out.env.NUGET_PACKAGES).toBe(join(home, '.nuget', 'packages'));
    expect(out.readonly).toEqual([join(home, '.nuget', 'packages')]);
    expect(out.env).toMatchObject({ UseSharedCompilation: 'false', EnableSourceControlManagerQueries: 'false', MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_USE_MSBUILD_SERVER: '0', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' });
    // Nothing of the real %APPDATA% (NuGet.Config, which can hold feed credentials) is named.
    expect(JSON.stringify(out)).not.toContain(JSON.stringify(join(home, 'AppData')).slice(1, -1));
  });

  it('a run packages folder: NUGET_PACKAGES names it, your cache becomes the read-only NUGET_FALLBACK_PACKAGES; writable only for the restore step', () => {
    const home = join(dir, 'home');
    const cache = join(home, '.nuget', 'packages');
    mkdirSync(cache, { recursive: true });
    const run = join(dir, 'gates', 'nuget', 'issue-7');
    const restore = dotnetSandboxEnv(join(dir, 'profile'), {}, home, 'win32', { dir: run, writable: true });
    expect(restore.env).toMatchObject({ NUGET_PACKAGES: run, NUGET_FALLBACK_PACKAGES: cache });
    expect(restore.readonly).toEqual([cache]);
    expect(restore.readwrite).toEqual([run]);
    const gate = dotnetSandboxEnv(join(dir, 'profile'), {}, home, 'win32', { dir: run, writable: false });
    expect(gate.env).toMatchObject({ NUGET_PACKAGES: run, NUGET_FALLBACK_PACKAGES: cache });
    expect(gate.readonly).toEqual([cache, run]);
    expect(gate.readwrite).toEqual([]);
    // Without the real cache: the run's folder alone, no fallback.
    const bare = dotnetSandboxEnv(join(dir, 'profile'), {}, join(dir, 'nohome'), 'linux', { dir: run, writable: true });
    expect(bare.env.NUGET_PACKAGES).toBe(run);
    expect(bare.env.NUGET_FALLBACK_PACKAGES).toBeUndefined();
    // No run folder: as before, nothing writable.
    expect(dotnetSandboxEnv(join(dir, 'profile'), {}, home, 'win32').readwrite).toEqual([]);
  });

  it('elsewhere: no APPDATA; no packages folder, no grant', () => {
    const out = dotnetSandboxEnv(join(dir, 'profile'), {}, join(dir, 'home'), 'linux');
    expect(out.env.APPDATA).toBeUndefined();
    expect(out.env.NUGET_PACKAGES).toBeUndefined();
    expect(out.readonly).toEqual([]);
  });
});

describe('one NuGet config for a sandboxed dotnet (RestoreConfigFile)', () => {
  const clearOrg = '<configuration><packageSources><clear /><add key="nuget.org" value="https://api.nuget.org/v3/index.json" /></packageSources></configuration>';

  it('dotnetSandboxEnv: RestoreConfigFile names the one file, and nuget.org is an additional source only when asked', () => {
    const file = join(dir, 'co', 'nuget.config');
    const one = dotnetSandboxEnv(join(dir, 'profile'), {}, join(dir, 'home'), 'win32', undefined, { file, addNugetOrg: false });
    expect(one.env.RestoreConfigFile).toBe(file);
    expect(one.env.RestoreAdditionalProjectSources).toBeUndefined();
    const plus = dotnetSandboxEnv(join(dir, 'profile'), {}, join(dir, 'home'), 'linux', undefined, { file, addNugetOrg: true });
    expect(plus.env).toMatchObject({ RestoreConfigFile: file, RestoreAdditionalProjectSources: NUGET_ORG_SOURCE });
    // NuGet's own hierarchy (a base that pins a lower nuget.config): neither variable.
    const walk = dotnetSandboxEnv(join(dir, 'profile'), {}, join(dir, 'home'), 'win32');
    expect(walk.env.RestoreConfigFile).toBeUndefined();
    expect(walk.env.RestoreAdditionalProjectSources).toBeUndefined();
    // The file is read by NuGet in the sandbox, from the checkout: nothing more is granted for it.
    expect(one.readonly).toEqual(walk.readonly);
  });

  it('rootNugetConfig: NuGet\'s names in its order; a dir of that name is none; in doubt, ambiguous', () => {
    const co = join(dir, 'co');
    mkdirSync(co);
    expect(rootNugetConfig(co, 'win32')).toEqual({ none: true });
    expect(rootNugetConfig(join(dir, 'missing'), 'linux')).toEqual({ none: true });
    writeFileSync(join(co, 'NUGET.CONFIG'), clearOrg);
    // Windows opens NuGet.Config in any case; Linux never probes NUGET.CONFIG; macOS depends on the volume.
    expect(rootNugetConfig(co, 'win32')).toEqual({ file: join(co, 'NUGET.CONFIG') });
    expect(rootNugetConfig(co, 'linux')).toEqual({ none: true });
    expect('ambiguous' in rootNugetConfig(co, 'darwin')).toBe(true);
    const lin = join(dir, 'lin');
    mkdirSync(lin);
    writeFileSync(join(lin, 'NuGet.Config'), clearOrg);
    expect(rootNugetConfig(lin, 'linux')).toEqual({ file: join(lin, 'NuGet.Config') });
    expect(rootNugetConfig(lin, 'darwin')).toEqual({ file: join(lin, 'NuGet.Config') });
    // A dir named nuget.config does not exist for NuGet's File.Exists: none, or the next name.
    const sub = join(dir, 'sub');
    mkdirSync(join(sub, 'nuget.config'), { recursive: true });
    expect(rootNugetConfig(sub, 'win32')).toEqual({ none: true });
    expect(rootNugetConfig(sub, 'linux')).toEqual({ none: true });
  });

  it('rootNugetConfig: two names that differ in case, or a link, are ambiguous (fakes for each platform)', () => {
    // Two entries of one dir: only a case-sensitive file system holds both; the readdir is what is judged.
    const two = join(dir, 'two');
    mkdirSync(two);
    writeFileSync(join(two, 'nuget.config'), clearOrg);
    let both = true;
    try { writeFileSync(join(two, 'NuGet.Config'), clearOrg, { flag: 'wx' }); } catch { both = false; }
    if (both) for (const p of ['win32', 'darwin', 'linux'] as const) expect('ambiguous' in rootNugetConfig(two, p)).toBe(true);
    else expect(rootNugetConfig(two, 'win32')).toEqual({ file: join(two, 'nuget.config') });
    const link = join(dir, 'link');
    mkdirSync(link);
    let linked = true;
    try { symlinkSync(join(two, 'nuget.config'), join(link, 'nuget.config'), 'file'); } catch { linked = false; }
    if (linked) for (const p of ['win32', 'darwin', 'linux'] as const) expect('ambiguous' in rootNugetConfig(link, p)).toBe(true);
  });

  it('dotnetNugetConfig: the checkout\'s root file, else nuget.org only in the job profile (never in the checkout)', () => {
    const co = join(dir, 'co');
    const profile = join(dir, 'job', 'profile');
    mkdirSync(co);
    const none = dotnetNugetConfig(co, profile, 'win32');
    expect(none).toEqual({ file: join(profile, 'nuget', 'nuget.config'), addNugetOrg: false });
    expect(readFileSync(join(profile, 'nuget', 'nuget.config'), 'utf8')).toBe(NUGET_ORG_ONLY_CONFIG);
    expect(NUGET_ORG_ONLY_CONFIG).toContain(`value="${NUGET_ORG_SOURCE}"`);
    writeFileSync(join(co, 'nuget.config'), clearOrg);
    expect(dotnetNugetConfig(co, profile, 'win32')).toEqual({ file: join(co, 'nuget.config'), addNugetOrg: false });
    // A root file that relies on nuget.org from the user config: added, unless the engine says the repository sets
    // its restore sources in MSBuild (H2).
    writeFileSync(join(co, 'nuget.config'), '<configuration><config><add key="dependencyVersion" value="Lowest" /></config></configuration>');
    expect(dotnetNugetConfig(co, profile, 'win32')).toEqual({ file: join(co, 'nuget.config'), addNugetOrg: true });
    expect(dotnetNugetConfig(co, profile, 'win32', { noAdd: true })).toEqual({ file: join(co, 'nuget.config'), addNugetOrg: false });
    // M1: a mapping to a key the file does not define keeps NuGet's own hierarchy.
    writeFileSync(join(co, 'nuget.config'), '<configuration><packageSources><add key="corp" value="https://corp.example.test/v3/index.json" /></packageSources><packageSourceMapping><packageSource key="nuget.org"><package pattern="*" /></packageSource><packageSource key="corp"><package pattern="Corp.*" /></packageSource></packageSourceMapping></configuration>');
    const mapped = dotnetNugetConfig(co, profile, 'win32');
    expect('hierarchy' in mapped && mapped.hierarchy).toContain('maps packages to the source key(s) nuget.org, which it does not define');
    // A file that cannot be read as a regular file (a dir of that name elsewhere is none; an unreadable one adds nothing).
    rmSync(join(co, 'nuget.config'));
    writeFileSync(join(co, 'nuget.config'), Buffer.alloc(NUGET_CONFIG_READ_MAX + 1, 0x20));
    expect(dotnetNugetConfig(co, profile, 'win32')).toEqual({ file: join(co, 'nuget.config'), addNugetOrg: false });
  });

  it('L2: the env value is MSBuild-escaped; a path with ";" keeps NuGet\'s hierarchy', () => {
    expect(msbuildEscape("C:\\a%41b @(x) $(y) 'q' *?")).toBe('C:\\a%2541b %40(x) %24(y) %27q%27 %2A%3F');
    const odd = join(dir, 'a%41b @(x) c');
    mkdirSync(odd);
    writeFileSync(join(odd, 'nuget.config'), clearOrg);
    const one = dotnetNugetConfig(odd, join(dir, 'p'), 'win32');
    const env = dotnetSandboxEnv(join(dir, 'profile'), {}, join(dir, 'home'), 'win32', undefined, one).env;
    expect(env.RestoreConfigFile).toBe(msbuildEscape(join(odd, 'nuget.config')));
    expect(env.RestoreConfigFile).toContain('a%2541b %40(x) c');
    const semi = join(dir, 'a;b');
    mkdirSync(semi);
    writeFileSync(join(semi, 'nuget.config'), clearOrg);
    const walk = dotnetNugetConfig(semi, join(dir, 'p'), 'win32');
    expect('hierarchy' in walk && walk.hierarchy).toContain('";"');
    const out = dotnetSandboxEnv(join(dir, 'profile'), {}, join(dir, 'home'), 'win32', undefined, walk);
    expect(out.env.RestoreConfigFile).toBeUndefined();
    expect(out.notes.join('\n')).toContain('NuGet reads its own config hierarchy');
  });

  it('L3: readRegularFileBounded reads a regular file within the cap, never a dir, a link or a larger file', () => {
    const f = join(dir, 'f.config');
    writeFileSync(f, 'abc');
    expect(readRegularFileBounded(f, 10)?.toString()).toBe('abc');
    expect(readRegularFileBounded(f, 2)).toBeNull();
    expect(readRegularFileBounded(dir, 10)).toBeNull();
    expect(readRegularFileBounded(join(dir, 'missing'), 10)).toBeNull();
    let linked = true;
    try { symlinkSync(f, join(dir, 'l.config'), 'file'); } catch { linked = false; }
    if (linked) expect(readRegularFileBounded(join(dir, 'l.config'), 10)).toBeNull();
  });
});

/** A root nuget.config shape, its bytes, and whether `dotnet nuget list source` in its dir (a fresh default user config
 * behind it, .NET SDK 10.0.101, Windows; review variants.sh) listed https://api.nuget.org/v3/index.json enabled. */
const P = '<add key="priv" value="http://127.0.0.1:9/v3/index.json" />';
const shape = (s: string): Buffer => Buffer.from(s, 'utf8');
const NUGET_SAYS: Array<[string, Buffer, boolean]> = [
  ['plain feed', shape(`<configuration><packageSources>${P}</packageSources></configuration>`), true],
  ['<clear />', shape(`<configuration><packageSources><clear />${P}</packageSources></configuration>`), false],
  ['<Clear />', shape(`<configuration><packageSources><Clear />${P}</packageSources></configuration>`), false],
  ['<CLEAR/>', shape(`<configuration><packageSources><CLEAR/>${P}</packageSources></configuration>`), false],
  ['<PackageSources> section', shape(`<configuration><PackageSources><clear />${P}</PackageSources></configuration>`), true],
  ['PI holding <!--', shape(`<configuration><packageSources><?x <!-- ?><clear />${P}<!-- --></packageSources></configuration>`), false],
  ['CDATA holding <!--', shape(`<configuration><packageSources><![CDATA[<!--]]><clear />${P}<!-- --></packageSources></configuration>`), false],
  ['UTF-16 with BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`<?xml version="1.0" encoding="utf-16"?><configuration><packageSources><clear />${P}</packageSources></configuration>`, 'utf16le')]), false],
  ['UTF-16 without BOM', Buffer.from(`<configuration><packageSources><clear />${P}</packageSources></configuration>`, 'utf16le'), false],
  ['nuget.org key to a mirror', shape('<configuration><packageSources><add key="nuget.org" value="http://127.0.0.1:9/mirror/index.json" /></packageSources></configuration>'), false],
  ['disabled nuget.org True', shape(`<configuration><packageSources>${P}</packageSources><disabledPackageSources><add key="nuget.org" value="True" /></disabledPackageSources></configuration>`), false],
  ['<DisabledPackageSources>', shape(`<configuration><packageSources>${P}</packageSources><DisabledPackageSources><add key="nuget.org" value="true" /></DisabledPackageSources></configuration>`), true],
  ['<clear></clear>', shape(`<configuration><packageSources><clear></clear>${P}</packageSources></configuration>`), false],
  ['UTF-8 BOM, clear', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), shape(`<configuration><packageSources><clear />${P}</packageSources></configuration>`)]), false],
  ['UTF-8 BOM, plain', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), shape(`<configuration><packageSources>${P}</packageSources></configuration>`)]), true],
  ['DOCTYPE entity', shape(`<?xml version="1.0"?><!DOCTYPE configuration [<!ENTITY c "<clear/>">]><configuration><packageSources>&c;${P}</packageSources></configuration>`), false],
  ['> in an attribute', shape(`<configuration><packageSources>${P}</packageSources><disabledPackageSources><add key="nuget.org" note="a>b" value="true" /></disabledPackageSources></configuration>`), false],
  ['<ADD> disabling nuget.org', shape(`<configuration><packageSources>${P}</packageSources><disabledPackageSources><ADD key="nuget.org" value="true" /></disabledPackageSources></configuration>`), false],
  ['Key= Value= (invalid)', shape(`<configuration><packageSources>${P}</packageSources><disabledPackageSources><add Key="nuget.org" Value="true" /></disabledPackageSources></configuration>`), false],
  ['NuGet.org key disabled', shape(`<configuration><packageSources>${P}</packageSources><disabledPackageSources><add key="NuGet.org" value="true" /></disabledPackageSources></configuration>`), true],
  ['remove nuget.org', shape(`<configuration><packageSources><remove key="nuget.org" />${P}</packageSources></configuration>`), true],
  ['<clear\\n/>', shape(`<configuration><packageSources><clear\n/>${P}</packageSources></configuration>`), false],
  ['char ref nuget&#46;org disabled', shape(`<configuration><packageSources>${P}</packageSources><disabledPackageSources><add key="nuget&#46;org" value="true" /></disabledPackageSources></configuration>`), false],
  ['mapping to nuget.org, cleared', shape(`<configuration><packageSources><clear />${P}</packageSources><packageSourceMapping><packageSource key="nuget.org"><package pattern="*" /></packageSource></packageSourceMapping></configuration>`), false],
  ['mapping to priv, no clear', shape(`<configuration><packageSources>${P}</packageSources><packageSourceMapping><packageSource key="priv"><package pattern="Corp.*" /></packageSource></packageSourceMapping></configuration>`), true],
  ['config section only', shape('<configuration><config><add key="globalPackagesFolder" value="pk" /></config></configuration>'), true],
  ['<Configuration> root', shape(`<Configuration><packageSources>${P}</packageSources></Configuration>`), true],
  ['clear + nuget.org', shape('<?xml version="1.0" encoding="utf-8"?>\n<configuration><packageSources><clear /><add key="nuget.org" value="https://api.nuget.org/v3/index.json" /></packageSources></configuration>'), true],
  ['commented clear', shape(`<configuration><packageSources><!-- <clear /> -->${P}</packageSources></configuration>`), true],
  ['empty file (invalid)', shape(''), false],
  ['a second public feed', shape('<configuration><packageSources><add key="dotnet-tools" value="https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-tools/nuget/v3/index.json" /></packageSources></configuration>'), true],
  ['xmlns + clear', shape(`<configuration xmlns="urn:x"><packageSources><clear />${P}</packageSources></configuration>`), false],
  [' nuget.org  key disabled', shape(`<configuration><packageSources>${P}</packageSources><disabledPackageSources><add key=" nuget.org " value="true" /></disabledPackageSources></configuration>`), true],
  ['mapping to NUGET.ORG', shape(`<configuration><packageSources>${P}</packageSources><packageSourceMapping><packageSource key="NUGET.ORG"><package pattern="*" /></packageSource></packageSourceMapping></configuration>`), true],
];

describe('H1: nugetConfigVerdict adds nuget.org only when NuGet certainly uses it (fail closed)', () => {
  it.each(NUGET_SAYS)('%s: never "add" where NuGet would not use nuget.org', (_name, bytes, nugetOrgEnabled) => {
    const v = nugetConfigVerdict(bytes);
    if (v.addNugetOrg) expect(nugetOrgEnabled).toBe(true);
    else expect(v.why).toBeTruthy();
  });

  it('adds for the common shapes that only add a feed or set config, and nothing else', () => {
    const adds = NUGET_SAYS.filter(([, b]) => nugetConfigVerdict(b).addNugetOrg).map(([n]) => n).sort();
    expect(adds).toEqual(['UTF-8 BOM, plain', 'a second public feed', 'commented clear', 'config section only', 'plain feed'].sort());
  });

  it('every shape the review listed is "do not add"', () => {
    const no = (s: string | Buffer) => nugetConfigVerdict(typeof s === 'string' ? Buffer.from(s) : s).addNugetOrg;
    expect(no('<configuration><packageSources><Clear /><add key="corp" value="C:\\corp" /></packageSources></configuration>')).toBe(false);
    expect(no('<configuration><packageSources><add key="nuget.org" value="https://corp-mirror.example.test/v3/index.json" /></packageSources></configuration>')).toBe(false);
    expect(no(`<configuration><packageSources><?pi <!-- ?><clear />${P}<!-- --></packageSources></configuration>`)).toBe(false);
    expect(no(`<configuration><disabledPackageSources><ADD key="nuget.org" value="true"/></disabledPackageSources><packageSources>${P}</packageSources></configuration>`)).toBe(false);
    expect(no(`<configuration><packageSources>${P}</packageSources><x note="a>b" /></configuration>`)).toBe(true);
    expect(no('<configuration><packageSources><add key="x" value="&#110;uget.org" /></packageSources></configuration>')).toBe(false);
    expect(no('<configuration><packageSources><add key="x" value=unquoted /></packageSources></configuration>')).toBe(false);
    expect(no('<configuration><packageSources><add key="x" value="https://example.test/v3" />')).toBe(false);
    expect(no('<configuration/><configuration/>')).toBe(false);
    expect(no(Buffer.from([0x3c, 0xc3, 0x28, 0x3e]))).toBe(false);
  });

  it('M1: unmappedKeys names a mapping key the file does not define (unless it clears its sources)', () => {
    const v = (s: string) => nugetConfigVerdict(Buffer.from(s)).unmappedKeys;
    expect(v(`<configuration><packageSources>${P}</packageSources><packageSourceMapping><packageSource key="nuget.org"><package pattern="*" /></packageSource><packageSource key="priv"><package pattern="Corp.*" /></packageSource></packageSourceMapping></configuration>`)).toEqual(['nuget.org']);
    expect(v(`<configuration><packageSources>${P}</packageSources><packageSourceMapping><packageSource key="priv"><package pattern="*" /></packageSource></packageSourceMapping></configuration>`)).toEqual([]);
    expect(v(`<configuration><packageSources><clear />${P}</packageSources><packageSourceMapping><packageSource key="nuget.org"><package pattern="*" /></packageSource></packageSourceMapping></configuration>`)).toEqual([]);
  });

  it('L1: linear on crafted input at the size cap (each under 200 ms)', () => {
    const rep = (s: string) => Buffer.from(s.repeat(Math.ceil(NUGET_CONFIG_READ_MAX / s.length)).slice(0, NUGET_CONFIG_READ_MAX));
    for (const s of ['<!--', '<packageSources>', '<packageSources ', '<add ', '<a x="', '<?x ', '<a><a>', '&amp;']) {
      const t = performance.now();
      nugetConfigVerdict(rep(s));
      expect(performance.now() - t, s).toBeLessThan(200);
    }
  });
});

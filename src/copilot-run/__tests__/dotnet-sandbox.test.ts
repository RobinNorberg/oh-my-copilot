/**
 * dotnet-sandbox.ts: which commands count as dotnet, the -m:1 rewrite, the
 * NuGet packages folder lookup and the env a sandboxed dotnet gets.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DOTNET_SINGLE_NODE_FLAG, dotnetSandboxArgs, dotnetSandboxEnv, isDotnetExe, isMtpGlobalJson, isNugetHost, nugetPackagesDir, nugetPackagesGrant } from '../dotnet-sandbox.js';

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

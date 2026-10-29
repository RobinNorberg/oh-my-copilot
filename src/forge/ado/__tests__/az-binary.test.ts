import { win32 } from 'path';
import { describe, expect, it } from 'vitest';
import { AZ_PYTHON_PREFIX, AzBinaryError, resolveAzEntry, type AzBinaryDeps } from '../az-binary.js';

const MSI = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2';
const REPO = 'C:\\Code\\widgets';
/** The files of a real MSI install rooted at `root`. */
const msi = (root: string) => [`${root}\\wbin\\az.cmd`, `${root}\\python.exe`, `${root}\\Lib\\site-packages\\azure\\cli\\__main__.py`];
/** An injected fs: exactly these files exist. */
const files = (...paths: string[]) => {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p: string) => set.has(p.toLowerCase());
};
/** An injected realpath: identity, except the listed aliases (8.3 short names, junctions) and missing paths (throws). */
const realpaths = (aliases: Record<string, string> = {}, missing: string[] = []) => (p: string): string => {
  const r = win32.resolve(p);
  if (missing.some((m) => r.toLowerCase() === m.toLowerCase())) throw new Error(`ENOENT: ${p}`);
  const hit = Object.keys(aliases).find((a) => r.toLowerCase() === a.toLowerCase() || r.toLowerCase().startsWith(`${a.toLowerCase()}\\`));
  return hit ? aliases[hit] + r.slice(hit.length) : r;
};
const win = (path: string, isFile: AzBinaryDeps['isFile'], key = 'Path', untrustedRoots: readonly string[] = [REPO], realpath = realpaths()): AzBinaryDeps => ({
  platform: 'win32',
  env: { [key]: path },
  isFile,
  realpath,
  untrustedRoots,
});

describe('resolveAzEntry', () => {
  it('POSIX runs az directly', () => {
    const isAz = (...paths: string[]) => (p: string) => paths.includes(p);
    const posix = (PATH: string, isFile: AzBinaryDeps['isFile'], realpath: AzBinaryDeps['realpath'] = (p) => p, roots = ['/home/me/repo']): AzBinaryDeps =>
      ({ platform: 'linux', env: { PATH }, isFile, realpath, untrustedRoots: roots });
    expect(resolveAzEntry(posix('/usr/local/bin:/usr/bin', isAz('/usr/bin/az')))).toEqual({ command: '/usr/bin/az', prefix: [], env: {} });
    // The real path spawns, so what was checked is what runs.
    const brew = (p: string) => (p === '/opt/homebrew/bin/az' ? '/opt/homebrew/Cellar/azure-cli/2.66.0/bin/az' : p);
    expect(resolveAzEntry({ ...posix('/opt/homebrew/bin', isAz('/opt/homebrew/bin/az'), brew), platform: 'darwin' }).command).toBe('/opt/homebrew/Cellar/azure-cli/2.66.0/bin/az');
  });

  it('POSIX skips relative, dot, node_modules and untrusted-root PATH entries, and an az that resolves into a root', () => {
    const isFile = (p: string) => p.endsWith('/az');
    const posix = (PATH: string, realpath: AzBinaryDeps['realpath'] = (p) => p): AzBinaryDeps =>
      ({ platform: 'linux', env: { PATH }, isFile, realpath, untrustedRoots: ['/home/me/repo', '/home/me/repo/.omg'] });
    for (const dir of ['bin', '.', '/usr/../home/me/repo/bin', '/home/me/repo/node_modules/.bin', '/home/me/repo/bin', '/home/me/repo/.omg/team/factory-run/worktrees/issue-1/bin', '/opt/x/node_modules/.bin']) {
      expect(() => resolveAzEntry(posix(dir)), dir).toThrow(/Azure CLI not found/);
    }
    expect(() => resolveAzEntry(posix('/tmp/link', (p) => p.replace('/tmp/link', '/home/me/repo/tools')))).toThrow(/Azure CLI not found/);
    expect(() => resolveAzEntry(posix('/usr/bin', (p) => (p === '/usr/bin/az' ? '/home/me/repo/az' : p)))).toThrow(/Azure CLI not found/);
    expect(resolveAzEntry(posix('/home/me/repo/bin:/usr/bin')).command).toBe('/usr/bin/az');
    expect(() => resolveAzEntry({ ...posix('/usr/bin'), untrustedRoots: [] })).toThrow(/untrustedRoots/);
  });

  it('accepts a real MSI layout: bundled python.exe with -IBm azure.cli and AZ_INSTALLER=MSI', () => {
    const entry = resolveAzEntry(win(`C:\\Windows\\system32;"${MSI}\\wbin";C:\\tools`, files(...msi(MSI))));
    expect(entry).toEqual({ command: `${MSI}\\python.exe`, prefix: ['-IBm', 'azure.cli'], env: { AZ_INSTALLER: 'MSI' } });
    expect(AZ_PYTHON_PREFIX).toEqual(['-IBm', 'azure.cli']);
  });

  it('reads PATH under any casing of the name', () => {
    expect(resolveAzEntry(win(`${MSI}\\wbin`, files(...msi(MSI)), 'PATH')).command).toBe(`${MSI}\\python.exe`);
  });

  it('takes the first searchable PATH entry holding az.cmd', () => {
    const other = 'D:\\az';
    const entry = resolveAzEntry(win(`${other}\\wbin;${MSI}\\wbin`, files(...msi(other), ...msi(MSI))));
    expect(entry.command).toBe(`${other}\\python.exe`);
  });

  it('refuses a planted node_modules\\.bin\\az.cmd, even with a python.exe and azure\\cli beside it', () => {
    const planted = 'C:\\Users\\me\\proj\\node_modules';
    const fs = files(`${planted}\\.bin\\az.cmd`, `${planted}\\python.exe`, `${planted}\\Lib\\site-packages\\azure\\cli\\__main__.py`);
    expect(() => resolveAzEntry(win(`${planted}\\.bin`, fs))).toThrow(/Azure CLI not found/);
    // Ahead of the real install on PATH, it is skipped and the MSI one wins.
    const both = files(`${planted}\\.bin\\az.cmd`, `${planted}\\python.exe`, `${planted}\\Lib\\site-packages\\azure\\cli\\__main__.py`, ...msi(MSI));
    expect(resolveAzEntry(win(`${planted}\\.bin;${MSI}\\wbin`, both)).command).toBe(`${MSI}\\python.exe`);
  });

  it('refuses PATH entries at or under the repository, lane and job roots', () => {
    const lane = 'C:\\Users\\me\\.omg\\lanes\\l1';
    for (const dir of [`${REPO}\\wbin`, `${REPO.toLowerCase()}\\tools\\wbin`, `${lane}\\wbin`, `C:\\Code\\x\\..\\widgets\\wbin`]) {
      expect(() => resolveAzEntry(win(dir, files(...msi(dir.replace(/\\wbin$/, ''))), 'Path', [REPO, lane])), dir).toThrow(/Azure CLI not found/);
    }
    // A sibling whose name only starts like the root is not under it.
    expect(resolveAzEntry(win(`C:\\Code\\widgets-cli\\wbin`, files(...msi('C:\\Code\\widgets-cli')))).command).toBe('C:\\Code\\widgets-cli\\python.exe');
  });

  it('refuses UNC, device, drive-relative and relative PATH entries', () => {
    const isFile = (p: string) => /az\.cmd$|python\.exe$|__main__\.py$/i.test(p);
    for (const dir of ['\\\\server\\share\\CLI2\\wbin', '//server/share/CLI2/wbin', '\\\\?\\C:\\CLI2\\wbin', '\\CLI2\\wbin', 'C:CLI2\\wbin', '.\\wbin', 'wbin']) {
      expect(() => resolveAzEntry(win(dir, isFile)), dir).toThrow(AzBinaryError);
    }
  });

  it('refuses a layout without the bundled python.exe or azure\\cli package (no cmd.exe fallback)', () => {
    expect(() => resolveAzEntry(win(`${MSI}\\wbin`, files(`${MSI}\\wbin\\az.cmd`)))).toThrow(/no bundled .*python\.exe.*never through cmd\.exe/);
    expect(() => resolveAzEntry(win(`${MSI}\\wbin`, files(`${MSI}\\wbin\\az.cmd`, `${MSI}\\python.exe`)))).toThrow(/site-packages\\azure\\cli/);
  });

  it('refuses when az.cmd is not on PATH', () => {
    expect(() => resolveAzEntry(win('C:\\Windows', files()))).toThrow(/Azure CLI not found/);
    expect(() => resolveAzEntry({ platform: 'win32', env: {}, isFile: () => true, realpath: realpaths(), untrustedRoots: [REPO] })).toThrow(/Azure CLI not found/);
  });

  it('requires non-empty untrustedRoots on Windows', () => {
    for (const roots of [[], ['  ']]) {
      expect(() => resolveAzEntry(win(`${MSI}\\wbin`, files(...msi(MSI)), 'Path', roots))).toThrow(/untrustedRoots/);
    }
  });

  it('compares real paths: an 8.3 short name or a junction cannot alias a root', () => {
    const short = 'C:\\Code\\WIDGET~1';
    const junction = 'C:\\tools\\azlink';
    const fs = files(...msi(short), ...msi(junction), ...msi(REPO));
    const rp = realpaths({ [short]: REPO, [junction]: `${REPO}\\vendor` });
    expect(() => resolveAzEntry(win(`${short}\\wbin`, fs, 'Path', [REPO], rp))).toThrow(/Azure CLI not found/);
    expect(() => resolveAzEntry(win(`${junction}\\wbin`, fs, 'Path', [REPO], rp))).toThrow(/Azure CLI not found/);
    // A root given by its short name covers its long path too.
    expect(() => resolveAzEntry(win(`${REPO}\\wbin`, fs, 'Path', [short], rp))).toThrow(/Azure CLI not found/);
  });

  it('refuses a PATH entry whose real path does not resolve, and a python.exe that resolves into a root', () => {
    expect(() => resolveAzEntry(win(`${MSI}\\wbin`, files(...msi(MSI)), 'Path', [REPO], realpaths({}, [`${MSI}\\wbin`])))).toThrow(/Azure CLI not found/);
    const rp = realpaths({ [`${MSI}\\python.exe`]: `${REPO}\\python.exe` });
    expect(() => resolveAzEntry(win(`${MSI}\\wbin`, files(...msi(MSI)), 'Path', [REPO], rp))).toThrow(/resolves into node_modules or a repository/);
  });

  it('refuses segments ending in a dot or a space (Windows strips them)', () => {
    for (const dir of [`${REPO}.\\wbin`, `${REPO} \\wbin`, 'C:\\CLI2.\\wbin', 'C:\\CLI2 \\wbin', 'C:\\CLI2\\.\\wbin']) {
      expect(() => resolveAzEntry(win(dir, () => true)), dir).toThrow(/Azure CLI not found/);
    }
  });
});

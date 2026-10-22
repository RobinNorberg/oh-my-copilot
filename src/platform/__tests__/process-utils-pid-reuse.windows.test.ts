import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProcessStartIdentity, isProcessAlive, terminateOwnedProcessTree } from '../process-utils.js';

const isWindows = process.platform === 'win32';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(!isWindows)('terminateOwnedProcessTree parent-PID reuse (Windows)', () => {
  it('spares an older unrelated process whose ParentProcessId names the reused root PID', async (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-pid-reuse-'));
    const pidFile = join(dir, 'orphan.pid');
    const orphanScript = join(dir, 'orphan.js');
    writeFileSync(orphanScript, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n");
    // A exits at once and leaves orphan X behind, so X's ParentProcessId names a dead PID.
    // X is detached (no shared console), so no console host keeps A's PID allocated.
    const launcher = join(dir, 'a.js');
    writeFileSync(launcher, "require('child_process').spawn(process.execPath, process.argv.slice(2), { detached: true, stdio: 'ignore' }).unref();\n");
    const a = spawn(process.execPath, [launcher, orphanScript, pidFile], { stdio: 'ignore', windowsHide: true });
    const aPid = a.pid!;
    await new Promise(resolve => a.once('exit', resolve));
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await sleep(50);
    const orphanPid = Number(readFileSync(pidFile, 'utf8'));
    let reused: ChildProcess | null = null;
    try {
      expect(isProcessAlive(orphanPid)).toBe(true);
      // Spawn until Windows hands A's PID to a new process, which then looks like X's parent.
      const ping = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE');
      const startedAt = Date.now();
      for (let i = 0; i < 20_000 && Date.now() - startedAt < 90_000; i++) {
        const child = spawn(ping, ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
        if (child.pid === aPid) { reused = child; break; }
        child.kill();
      }
      if (!reused) {
        console.warn(`skipped: PID ${aPid} was not reused within the spawn budget`);
        ctx.skip();
        return;
      }
      await sleep(300);
      const identity = await getProcessStartIdentity(reused.pid!);
      expect(identity).toBeTruthy();
      await expect(terminateOwnedProcessTree({
        pid: reused.pid!, expectedStartIdentity: identity!, deadlineAt: new Date(Date.now() + 15_000).toISOString(), force: true,
      })).resolves.toBe('terminated');
      await sleep(500);
      expect(isProcessAlive(reused.pid!)).toBe(false);
      expect(isProcessAlive(orphanPid)).toBe(true);
    } finally {
      try { process.kill(orphanPid); } catch { /* already gone */ }
      try { reused?.kill(); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

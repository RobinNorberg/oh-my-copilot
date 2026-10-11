// Probe hook for copilot-hook-daemon.test.ts, copied into a temp plugin under
// daemon-safe script names. The payload's `hooks[<script name>]` says what this
// copy prints, which exit code it returns, how long it sleeps, or whether it
// hangs; each run appends one line to `payload.trace` so the test can compare
// order, process, cwd and owner pid between the cold and the warm path.
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { isMainThread } from 'node:worker_threads';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input || '{}');
  const name = basename(process.argv[1]);
  const spec = (payload.hooks && payload.hooks[name]) || {};
  const finish = () => {
    if (payload.trace) {
      appendFileSync(payload.trace, `${JSON.stringify({
        name,
        pid: process.pid,
        isMainThread,
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        marker: payload.marker ?? null,
        owner: process.env.OMC_SESSION_OWNER_PID ?? null,
        event: process.env.OMC_HOOK_EVENT ?? null,
        probeEnv: process.env.PROBE_ENV ?? null,
      })}\n`);
    }
    if (spec.stderr) process.stderr.write(spec.stderr);
    if (spec.stdout !== undefined) {
      process.stdout.write(typeof spec.stdout === 'string' ? spec.stdout : JSON.stringify(spec.stdout));
    }
    if (spec.hang) {
      setTimeout(() => {}, 60_000);
      return;
    }
    process.exitCode = spec.exitCode ?? 0;
  };
  if (spec.sleepMs) setTimeout(finish, spec.sleepMs);
  else finish();
});

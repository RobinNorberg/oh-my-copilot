// Main thread stays silent; a Worker (which inherits --require) writes the hook JSON
// and exits non-zero. If the adapter were active inside the Worker it would emit its
// own copy via fs.writeSync(1) and the parent would see two JSON documents.
import { Worker } from 'node:worker_threads';

const worker = new Worker(
  `process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'from worker' } }) + '\\n');
   process.exitCode = 3;`,
  { eval: true },
);
worker.once('exit', (code) => {
  process.stderr.write(`worker exit ${code}\n`);
});

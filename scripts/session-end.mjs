#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readStdin } from './lib/stdin.mjs';

async function main() {
  // Read stdin (timeout-protected, see issue #240/#459)
  const input = await readStdin();

  const fallback = { continue: true, suppressOutput: true };

  // Copilot CLI may invoke the SessionEnd hook with empty stdin during a
  // clean shutdown. Treat that as an expected no-op so the hook stays quiet
  // instead of logging a JSON parse error (#3104/#3105/#3106).
  if (input.trim().length === 0) {
    console.log(JSON.stringify(fallback));
    return;
  }

  try {
    const data = JSON.parse(input);
    const { processSessionEnd } = await import('../dist/hooks/session-end/index.js');
    const result = await processSessionEnd(data);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[session-end] Error:', error.message);
    console.log(JSON.stringify(fallback));
  }
}

main();

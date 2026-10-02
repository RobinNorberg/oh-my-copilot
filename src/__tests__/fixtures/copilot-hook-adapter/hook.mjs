// Test hook for copilot-hook-adapter.test.ts; behaviour selected by FIXTURE_MODE.
const mode = process.env.FIXTURE_MODE || 'empty';

switch (mode) {
  case 'crash':
    throw new Error('fixture crash');
  case 'exit1':
    process.stdout.write('{"hookSpecificOutput":{"additionalContext":"before exit"}}\n');
    process.exit(1);
    break;
  case 'exit2':
    process.stderr.write('policy says no\n');
    process.exit(2);
    break;
  case 'pretty':
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'pretty context' },
    }, null, 2));
    break;
  case 'block':
    console.log(JSON.stringify({ decision: 'block', reason: 'blocked by fixture' }));
    break;
  case 'nonjson':
    process.stdout.write('plain text output\n');
    break;
  case 'destroyed-stdout':
    // Mirrors run.cjs sink.closeDestinations() followed by process.exit(1).
    process.stdout.write('{"additionalContext":"survives destroy"}\n', () => {
      process.stdout.destroy();
      process.exit(1);
    });
    break;
  case 'empty':
  default:
    break;
}

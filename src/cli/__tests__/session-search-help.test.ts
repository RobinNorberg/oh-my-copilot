import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const cliIndexSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'),
  'utf-8'
);

describe('session search help text', () => {
  it('documents the session search command examples', () => {
    expect(cliIndexSource).toContain('omg session search "team leader stale"');
    expect(cliIndexSource).toContain('omg session search notify-hook --since 7d');
    expect(cliIndexSource).toContain('omg session search provider-routing --project all --json');
    expect(cliIndexSource).toContain('omg session friction report --since 24h');
    expect(cliIndexSource).toContain('omg session friction report --json');
  });
});

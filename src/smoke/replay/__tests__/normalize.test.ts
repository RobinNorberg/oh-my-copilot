import { describe, expect, it } from 'vitest';

import { DELTA_MAX_BYTES, digest, normalize, normalizedDigest, truncateUtf8 } from '../normalize.js';

describe('normalize', () => {
  it('masks run-specific tokens', () => {
    expect(normalize([
      'session 3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b at 2026-10-30T09:12:44.123Z (epoch 1761815564123)',
      'commit 95bc2e1403a1b2c3d4e5f60718293a4b5c6d7e8f, short 95bc2e140',
      'pid 48213 finished in 2140ms, then 12 ms',
    ].join('\n'))).toBe([
      'session <uuid> at <ts> (epoch <ts>)',
      'commit <hex>, short 95bc2e140',
      'pid <n> finished in <ms>, then <ms>',
    ].join('\n'));
  });
  it('turns CRLF into LF and trims trailing whitespace', () => {
    expect(normalize('a  \r\nb\t\r\n\r\n')).toBe('a\nb');
  });
  it('substitutes this machine dirs first, so record and replay digests agree', () => {
    const recorded = 'edit ${PROJECT}/src/a.ts';
    expect(normalizedDigest('edit /tmp/replay/project/src/a.ts', { dirs: { PROJECT: '/tmp/replay/project' } }))
      .toBe(normalizedDigest(recorded));
  });
  it('digest is sha256-prefixed and stable', () => {
    expect(digest('x')).toBe('sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
  });
});

describe('truncateUtf8', () => {
  it('returns text that fits unchanged', () => {
    expect(truncateUtf8('short')).toBe('short');
  });
  it('cuts on a character boundary and marks the cut', () => {
    const text = 'ä'.repeat(DELTA_MAX_BYTES);
    const out = truncateUtf8(text);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(DELTA_MAX_BYTES);
    expect(out.endsWith('…[truncated]')).toBe(true);
    expect(out).not.toContain('�');
  });
});

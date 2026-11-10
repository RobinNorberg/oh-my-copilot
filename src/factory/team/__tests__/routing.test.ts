import { describe, expect, it } from 'vitest';
import { isOwnerName, MAX_ROUTING_BYTES, parseRouting, routeFor } from '../routing.js';

const TABLE = [
  '# Team routing',
  'prose is ignored',
  '| path glob | role | owner | handle |',
  '|---|---|---|---|',
  '| src/factory/** | executor | factory-team | @robin |',
  '| docs/** | writer | docs | - |',
  '| **/*.md | - | writers | @org/docs-team |',
  '| ** | - | everyone | @fallback |',
].join('\n');

describe('parseRouting', () => {
  it('parses the table and skips header, separator and prose', () => {
    const { routes, warnings } = parseRouting(TABLE);
    expect(warnings).toEqual([]);
    expect(routes).toEqual([
      { glob: 'src/factory/**', role: 'executor', owner: 'factory-team', handle: '@robin' },
      { glob: 'docs/**', role: 'writer', owner: 'docs' },
      { glob: '**/*.md', owner: 'writers', handle: '@org/docs-team' },
      { glob: '**', owner: 'everyone', handle: '@fallback' },
    ]);
  });

  it('warns, and keeps the row, for ** inside a segment', () => {
    const { routes, warnings } = parseRouting(['| src/**.ts | - | a | - |', '| docs** | - | b | - |', '| **.md | - | c | - |', '| src/**/*.ts | - | d | - |', '| docs/** | - | e | - |'].join('\n'));
    expect(routes.map((r) => r.owner)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('line 1');
    expect(warnings[0]).toContain('whole path segments only');
    expect(warnings[0]).toContain('**/*.ts');
  });

  it('drops bad rows with a warning each', () => {
    const { routes, warnings } = parseRouting([
      '| a/b | x | Bad Owner | - |',
      '| ../etc/** | - | ok | - |',
      '| /abs/** | - | ok | - |',
      '| a/** | - | ok | robin |',
      '| a/** | Role | ok | - |',
      '| a/** | - | ok |',
      '| fine/** | - | ok | @robin |',
    ].join('\n'));
    expect(routes).toEqual([{ glob: 'fine/**', owner: 'ok', handle: '@robin' }]);
    expect(warnings).toHaveLength(6);
    expect(warnings[0]).toContain('line 1');
  });

  it('drops a row with more than 2 ** segments or 8 wildcards, with a warning', () => {
    const { routes, warnings } = parseRouting([
      '| **/a/**/b/** | - | too-many-stars | - |',
      '| **a**a**a**a**a**a**a**a**b | - | too-many-wildcards | - |',
      '| **/a/** | - | fine | - |',
    ].join('\n'));
    expect(routes.map((r) => r.owner)).toEqual(['fine']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('2 ** segments');
    expect(warnings[1]).toContain('wildcards');
  });

  it('shows control and bidi characters in warnings instead of passing them through', () => {
    const { warnings } = parseRouting('| a | - | ow‮ner\u001b[31m | - |');
    expect(warnings[0]).toContain('<U+202E>');
    expect(warnings[0]).not.toContain('\u001b');
  });

  it('ignores a file over the size cap', () => {
    const r = parseRouting(`| a/** | - | ok | - |\n${'x'.repeat(MAX_ROUTING_BYTES)}`);
    expect(r.routes).toEqual([]);
    expect(r.warnings[0]).toContain('larger than');
  });

  it('handles CRLF and a BOM', () => {
    expect(parseRouting(`${String.fromCharCode(0xfeff)}${TABLE.replace(/\n/g, '\r\n')}`).routes).toHaveLength(4);
  });
});

describe('routeFor', () => {
  const { routes } = parseRouting(TABLE);
  it('uses the first matching row per path and de-duplicates', () => {
    const r = routeFor(routes, ['src/factory/run/engine.ts', 'src/factory/poll.ts', 'docs/a.md', 'README.md', 'lib/x.ts']);
    expect(r.map((x) => x.owner)).toEqual(['factory-team', 'docs', 'writers', 'everyone']);
  });
  it('no paths selects the catch-all rows', () => {
    expect(routeFor(routes, []).map((x) => x.owner)).toEqual(['everyone']);
  });
  it('no match gives nothing', () => {
    expect(routeFor(parseRouting('| src/** | - | a | - |').routes, ['docs/x.md'])).toEqual([]);
  });
});

describe('isOwnerName', () => {
  it('accepts label-safe names only', () => {
    expect(isOwnerName('team-a.b_c')).toBe(true);
    for (const bad of ['', 'A', '-x', 'a b', 'a:b', 'a'.repeat(40), 'a\n', undefined, 3]) expect(isOwnerName(bad)).toBe(false);
  });
});

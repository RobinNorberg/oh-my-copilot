/**
 * The bench fixture's base project (`omg factory bench`): a small
 * TypeScript + vitest library committed on `main` of a fresh local-forge
 * repository. The `.copilot/omg.jsonc` committed with it is the trusted
 * base layer: the local forge, its gate (`npm test`: the zero-dependency
 * lint, tsc and vitest, as `.github/workflows/ci.yml` runs them), the
 * prepare check and the intake source. Contents only; fixture.ts writes them.
 *
 * Bump BENCH_FIXTURE_VERSION on any change here or in issues.ts: results of
 * different fixture versions are not comparable (compare warns).
 */
export const BENCH_FIXTURE_VERSION = 1;
/** The integration branch of the fixture (a default ship.trustedBases entry). */
export const BENCH_BASE = 'main';
/** The backlog label every bench item carries (factory.intake.source). */
export const BENCH_LABEL = 'bench';
/** The local gate (factory.forge.local.gate): the repository's own `npm test`. */
export const BENCH_GATE = ['npm', 'test'];
/** Where the harness puts an issue's hidden acceptance test in its scratch checkout (inside the tsconfig and vitest globs). */
export const ACCEPTANCE_TEST_PATH = 'test/bench-acceptance.test.ts';
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const BENCH_OMG_JSONC = `// Bench fixture config (omg factory bench). Committed on main: the trusted base layer.
${json({
    ship: { base: BENCH_BASE, prepare: { checks: [['node', 'scripts/lint.mjs']] } },
    factory: {
        forge: { kind: 'local', local: { gate: BENCH_GATE } },
        intake: { source: { type: 'local-backlog', label: BENCH_LABEL } },
    },
})}`;
const LINT_MJS = `// Zero-dependency lint: no tabs, no trailing whitespace, a final newline (src/ and test/ .ts files).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];
function walk(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.ts')) check(path);
  }
}
function check(path) {
  const text = readFileSync(path, 'utf8');
  if (text.length > 0 && !text.endsWith('\\n')) problems.push(path + ': no final newline');
  text.split('\\n').forEach((line, i) => {
    if (line.includes('\\t')) problems.push(path + ':' + (i + 1) + ': tab');
    if (/[ \\t]+\\r?$/.test(line)) problems.push(path + ':' + (i + 1) + ': trailing whitespace');
  });
}
walk('src');
walk('test');
for (const p of problems) console.error(p);
if (problems.length > 0) process.exit(1);
console.log('lint ok');
`;
/** The base files, path -> content (forward slashes). */
export const BENCH_PROJECT_FILES = {
    '.gitignore': 'node_modules/\n.omg/\n',
    '.copilot/omg.jsonc': BENCH_OMG_JSONC,
    '.github/workflows/ci.yml': `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm test
`,
    'package.json': json({
        name: 'bench-shop',
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: { lint: 'node scripts/lint.mjs', test: 'node scripts/lint.mjs && tsc --noEmit -p . && vitest run' },
        devDependencies: { '@types/node': '^22.19.7', typescript: '^5.7.2', vitest: '^4.1.11' },
    }),
    'tsconfig.json': json({
        compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: ['node'] },
        include: ['src', 'test'],
    }),
    'vitest.config.mjs': "export default { test: { include: ['test/**/*.test.ts'] } };\n",
    'scripts/lint.mjs': LINT_MJS,
    'README.md': `# bench-shop

A tiny shop library: carts, prices, stock and slugs.

## Usage

Call \`cartTotal(lines)\` to recieve the total in cents, and \`formatPrice(cents)\` to show it.
Keep prices in cents; never seperate the currency from the amount.

## Development

\`npm test\` runs the lint, the type check and the tests. See docs/STYLE.md.
`,
    'docs/STYLE.md': `# Style

- \`const\` or \`let\`, never \`var\`.
- Single quotes for strings.
- Two-space indentation, no tabs, no trailing whitespace.
- Every exported function has a test under test/.
`,
    'src/math.ts': `export function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
`,
    'src/strings.ts': `/** A URL slug: lower case, words joined by single dashes. */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '-');
}
`,
    'src/format.ts': `export function formatPrice(cents: number): string {
  return '$' + (cents / 100).toFixed(2);
}
`,
    'src/cart.ts': `import { formatPrice } from './format.js';

export interface CartLine {
  sku: string;
  priceCents: number;
  quantity: number;
}

export function lineTotal(line: CartLine): number {
  return line.priceCents * line.quantity;
}

export function cartTotal(lines: readonly CartLine[]): number {
  return lines.reduce((total, line) => total + lineTotal(line), 0);
}

export function describeCart(lines: readonly CartLine[]): string {
  return lines.length + ' item(s), total ' + formatPrice(cartTotal(lines));
}
`,
    'src/inventory.ts': `export interface StockItem {
  sku: string;
  count: number;
}

export function inStock(items: readonly StockItem[], sku: string): boolean {
  for (const item of items) {
    if (item.sku.trim().toUpperCase() === sku.trim().toUpperCase()) {
      return item.count > 0;
    }
  }
  return false;
}

export function stockCount(items: readonly StockItem[], sku: string): number {
  for (const item of items) {
    if (item.sku.trim().toUpperCase() === sku.trim().toUpperCase()) {
      return item.count;
    }
  }
  return 0;
}
`,
    'src/legacy.ts': `export function legacyLabel(name: string, count: number): string {
  var label = "item";
  if (count !== 1) {
    label = "items";
  }
  var text = name + ": " + count + " " + label;
  return text;
}
`,
    'test/math.test.ts': `import { describe, expect, it } from 'vitest';
import { round2, sum } from '../src/math.js';

describe('math', () => {
  it('sums', () => expect(sum([1, 2, 3])).toBe(6));
  it('rounds to two decimals', () => expect(round2(1.234)).toBe(1.23));
});
`,
    'test/strings.test.ts': `import { expect, it } from 'vitest';
import { slugify } from '../src/strings.js';

it('keeps a plain word', () => expect(slugify('abc')).toBe('abc'));
`,
    'test/cart.test.ts': `import { expect, it } from 'vitest';
import { cartTotal, describeCart } from '../src/cart.js';

const lines = [{ sku: 'A', priceCents: 250, quantity: 2 }, { sku: 'B', priceCents: 100, quantity: 1 }];

it('totals a cart', () => expect(cartTotal(lines)).toBe(600));
it('describes a cart', () => expect(describeCart(lines)).toBe('2 item(s), total $6.00'));
`,
    'test/inventory.test.ts': `import { expect, it } from 'vitest';
import { inStock, stockCount } from '../src/inventory.js';

const items = [{ sku: 'A1', count: 3 }, { sku: 'B2', count: 0 }];

it('finds stock case-insensitively', () => expect(inStock(items, ' a1 ')).toBe(true));
it('counts stock', () => expect(stockCount(items, 'b2')).toBe(0));
it('unknown sku', () => expect(stockCount(items, 'zz')).toBe(0));
`,
    'test/legacy.test.ts': `import { expect, it } from 'vitest';
import { legacyLabel } from '../src/legacy.js';

it('labels one item', () => expect(legacyLabel('pens', 1)).toBe('pens: 1 item'));
it('labels many items', () => expect(legacyLabel('pens', 3)).toBe('pens: 3 items'));
`,
};
//# sourceMappingURL=project.js.map
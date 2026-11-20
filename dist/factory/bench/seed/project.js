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
export const BENCH_FIXTURE_VERSION = 3;
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
/** The shipping rates of the base (cents per country code); issue 13 adds one. */
export const BASE_RATES = { SE: 4900, DK: 5900, FI: 5900 };
/** src/shipping.ts with these rates. */
export const SHIPPING_TS = (rates) => `/** Flat shipping rates in cents, per country code. */
export const SHIPPING_RATES: Readonly<Record<string, number>> = {
${Object.entries(rates).map(([code, cents]) => `  ${code}: ${cents},`).join('\n')}
};

export function shippingCents(country: string): number {
  const rate = SHIPPING_RATES[country.trim().toUpperCase()];
  if (rate === undefined) throw new Error('no shipping to ' + country);
  return rate;
}
`;
/** docs/SHIPPING.md with these rates (test/shipping.test.ts keeps it in step with src/shipping.ts). */
export const SHIPPING_MD = (rates) => `# Shipping rates

| country | rate |
|---|---|
${Object.entries(rates).map(([code, cents]) => `| ${code} | $${(cents / 100).toFixed(2)} |`).join('\n')}
`;
/** src/messages.ts with this checkout message (issues 14 and 15 both change that one line). */
export const MESSAGES_TS = (checkout) => `export const MESSAGES: Readonly<Record<'checkout' | 'empty', string>> = {
  checkout: '${checkout}',
  empty: 'Your cart is empty.',
};
`;
/** The base files, path -> content (forward slashes). */
export const BENCH_PROJECT_FILES = {
    // `node_modules` without a slash: the fixture's node_modules may be a symlink (init --node-modules), which `node_modules/` would not ignore.
    '.gitignore': 'node_modules\n.omg/\n',
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
    // Fixture v3: the files of issues 13-17 (shipping: ci-fix; messages: the conflicting pair; units and its importers: the refactor).
    'src/shipping.ts': SHIPPING_TS(BASE_RATES),
    'docs/SHIPPING.md': SHIPPING_MD(BASE_RATES),
    'test/shipping.test.ts': `import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { SHIPPING_RATES, shippingCents } from '../src/shipping.js';

it('looks up a rate case-insensitively', () => expect(shippingCents(' se ')).toBe(4900));
it('refuses an unknown country', () => expect(() => shippingCents('XX')).toThrow());

it('docs/SHIPPING.md lists every rate', () => {
  const docs = readFileSync(new URL('../docs/SHIPPING.md', import.meta.url), 'utf8');
  const rows = [...docs.matchAll(/^\\| ([A-Z]{2}) \\| \\$(\\d+\\.\\d{2}) \\|$/gm)].map((m) => [m[1], m[2]]);
  expect(rows).toEqual(Object.entries(SHIPPING_RATES).map(([code, cents]) => [code, (cents / 100).toFixed(2)]));
});
`,
    'src/messages.ts': MESSAGES_TS('Thanks for your order!'),
    'test/messages.test.ts': `import { expect, it } from 'vitest';
import { MESSAGES } from '../src/messages.js';

it('has the checkout and empty-cart messages', () => {
  expect(MESSAGES.checkout.length).toBeGreaterThan(0);
  expect(MESSAGES.empty).toBe('Your cart is empty.');
});
`,
    'src/units.ts': `export function toGrams(kg: number): number {
  return Math.round(kg * 1000);
}

export function toKilograms(grams: number): number {
  return grams / 1000;
}
`,
    'src/parcel.ts': `import { toGrams } from './units.js';

export function parcelGrams(itemsKg: readonly number[]): number {
  return itemsKg.reduce((total, kg) => total + toGrams(kg), 0);
}
`,
    'src/label.ts': `import { toKilograms } from './units.js';

export function weightLabel(grams: number): string {
  return toKilograms(grams).toFixed(2) + ' kg';
}
`,
    'src/freight.ts': `import { toKilograms } from './units.js';

export function freightClass(grams: number): 'light' | 'heavy' {
  return toKilograms(grams) < 20 ? 'light' : 'heavy';
}
`,
    'test/units.test.ts': `import { expect, it } from 'vitest';
import { toGrams, toKilograms } from '../src/units.js';

it('converts kilograms to grams', () => expect(toGrams(1.2345)).toBe(1235));
it('converts grams to kilograms', () => expect(toKilograms(2500)).toBe(2.5));
`,
    'test/parcel.test.ts': `import { expect, it } from 'vitest';
import { parcelGrams } from '../src/parcel.js';

it('weighs a parcel', () => expect(parcelGrams([0.5, 1.25])).toBe(1750));
`,
    'test/label.test.ts': `import { expect, it } from 'vitest';
import { weightLabel } from '../src/label.js';

it('labels a weight', () => expect(weightLabel(1750)).toBe('1.75 kg'));
`,
    'test/freight.test.ts': `import { expect, it } from 'vitest';
import { freightClass } from '../src/freight.js';

it('classes freight', () => {
  expect(freightClass(19_999)).toBe('light');
  expect(freightClass(20_000)).toBe('heavy');
});
`,
};
//# sourceMappingURL=project.js.map
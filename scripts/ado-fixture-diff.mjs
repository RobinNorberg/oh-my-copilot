#!/usr/bin/env node
/**
 * Diff a live Azure DevOps recording against the docs-sample fixtures
 * (src/forge/ado/record.ts). Usage:
 *
 *   OMG_ADO_RECORD_DIR=<dir> omg factory run ...   # record
 *   node scripts/ado-fixture-diff.mjs <dir>        # diff
 *
 * Prints, per route, the response keys the samples have and the live answers
 * lack; exits 1 when there is drift.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoFixtureShapeReport } from '../dist/forge/ado/record.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const recordedDir = process.argv[2];
if (!recordedDir) {
  console.error('usage: node scripts/ado-fixture-diff.mjs <recorded dir>');
  process.exit(2);
}

const load = (dir) =>
  readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((name) => ({ name, ...JSON.parse(readFileSync(join(dir, name), 'utf8')) }));

const samples = load(join(root, 'src', 'forge', 'ado', '__tests__', 'fixtures')).filter((f) => f.provenance.startsWith('docs-sample '));
const lines = adoFixtureShapeReport(samples, load(recordedDir));
for (const line of lines) console.log(line);
console.log(lines.length ? `${lines.length} route(s) drift from the docs samples` : 'no drift from the docs samples');
process.exit(lines.length ? 1 : 0);

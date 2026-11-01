#!/usr/bin/env node
import { hardenWindowsExeSearch } from '../scripts/lib/windows-search.mjs';

// Before the CLI bundle loads, so nothing it initializes can spawn by bare name first.
hardenWindowsExeSearch();
await import('../bridge/cli.cjs');

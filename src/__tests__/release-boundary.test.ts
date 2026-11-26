import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error The release helper is intentionally dependency-free ESM without declarations.
import * as releaseBoundary from '../../scripts/release-boundary.mjs';

const {
  assertArchive,
  assertEvidence,
  assertNpmAbsent,
  assertSlsaProvenance,
  assertTrigger,
  buildEvidenceFromBytes,
  cliMain,
  decodeDssePayload,
  prepareStage,
  selectSlsaAttestation,
  verifyRegistry,
  writeEvidence,
} = releaseBoundary;

const PACKAGE_NAME = 'oh-my-copilot';
const VERSION = '4.15.4';
const TAG = `v${VERSION}`;
const SHA = 'a'.repeat(40);
const TEMP_ROOTS: string[] = [];

type TarEntry = {
  path: string;
  content?: Buffer | string;
  mode?: number;
  type?: '0' | '5';
};

type TestServer = {
  base: string;
  close: () => Promise<void>;
};

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  TEMP_ROOTS.push(root);
  return root;
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function tarHeader(entry: TarEntry, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  if (Buffer.byteLength(entry.path) > 100) {
    throw new Error(`test tar fixture path is too long: ${entry.path}`);
  }
  header.write(entry.path, 0, 'utf8');
  writeOctal(header, 100, 8, entry.mode ?? 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.type === '5' ? 0 : content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = (entry.type ?? '0').charCodeAt(0);
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}

function makeTarball(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content ?? '', 'utf8');
    blocks.push(tarHeader(entry, content));
    if (entry.type !== '5') {
      blocks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function packageManifest(gitHead?: string): Record<string, unknown> {
  return {
    name: PACKAGE_NAME,
    version: VERSION,
    ...(gitHead ? { gitHead } : {}),
    bin: {
      'oh-my-copilot': 'bin/oh-my-copilot.js',
      omg: 'bin/oh-my-copilot.js',
      'omg-cli': 'bridge/cli.cjs',
    },
  };
}

function releaseTarball(
  gitHead = SHA,
  extraEntries: TarEntry[] = [],
  readme = '# fixture\n',
  omit: string[] = [],
  rootPlugin: Record<string, unknown> = { name: 'oh-my-copilot', version: VERSION },
): Buffer {
  return makeTarball([
    { path: 'package/package.json', content: `${JSON.stringify(packageManifest(gitHead), null, 2)}\n` },
    {
      path: 'package/.claude-plugin/plugin.json',
      content: JSON.stringify({ name: 'oh-my-copilot', version: VERSION }),
    },
    {
      path: 'package/.claude-plugin/marketplace.json',
      content: JSON.stringify({
        version: VERSION,
        plugins: [{ name: 'oh-my-copilot', version: VERSION, source: './' }],
      }),
    },
    {
      path: 'package/.mcp.json',
      content: JSON.stringify({
        mcpServers: {
          omc: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs'] },
        },
      }),
    },
    { path: 'package/bin/oh-my-copilot.js', content: '#!/usr/bin/env node\n', mode: 0o755 },
    { path: 'package/bridge/cli.cjs', content: 'module.exports = {};\n' },
    { path: 'package/bridge/claude-md-coordinator.cjs', content: 'module.exports = {};\n' },
    { path: 'package/bridge/mcp-server.cjs', content: 'module.exports = {};\n' },
    { path: 'package/bridge/runtime-cli.cjs', content: 'module.exports = {};\n' },
    { path: 'package/bridge/team.js', content: 'export {};\n' },
    { path: 'package/plugin.json', content: JSON.stringify(rootPlugin) },
    { path: 'package/copilot/hooks.json', content: '{"version":1,"hooks":{}}' },
    { path: 'package/copilot/agents/executor.md', content: '---\nname: executor\n---\n' },
    { path: 'package/scripts/copilot/dispatch.cjs', content: 'module.exports = {};\n' },
    { path: 'package/scripts/lib/copilot-hook-adapter.cjs', content: 'module.exports = {};\n' },
    { path: 'package/README.md', content: readme },
    ...extraEntries,
  ].filter(entry => !omit.includes(entry.path)));
}

function writeTarball(root: string, name: string, bytes: Buffer): string {
  const path = join(root, name);
  writeFileSync(path, bytes);
  return path;
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListening);
      resolveListening();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose())),
  };
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function withEnvironment<T>(values: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function dssePayload(sha512: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `pkg:npm/${PACKAGE_NAME}@${VERSION}`, digest: { sha512 } }],
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: {
          workflow: {
            repository: 'https://github.com/RobinNorberg/oh-my-copilot',
            path: '.github/workflows/ci.yml',
            ref: `refs/tags/${TAG}`,
          },
        },
        resolvedDependencies: [{
          uri: `git+https://github.com/RobinNorberg/oh-my-copilot@refs/tags/${TAG}`,
          digest: { gitCommit: SHA },
        }],
      },
      runDetails: {
        builder: { id: 'https://github.com/actions/runner/github-hosted' },
        metadata: { invocationId: 'https://github.com/RobinNorberg/oh-my-copilot/actions/runs/123' },
      },
    },
    ...overrides,
  };
}

function slsaAttestation(payload: Record<string, unknown>, signature = 'fixture-signature'): Record<string, unknown> {
  return {
    predicateType: 'https://slsa.dev/provenance/v1',
    bundle: {
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
        signatures: [{ keyid: 'fixture', sig: signature }],
      },
    },
  };
}

function auditReport(
  attestation: Record<string, unknown>,
  registry: string,
  overrides: { invalid?: unknown[]; missing?: unknown[]; verified?: unknown[] } = {},
): Record<string, unknown> {
  return {
    invalid: overrides.invalid ?? [],
    missing: overrides.missing ?? [],
    verified: overrides.verified ?? [{
      name: PACKAGE_NAME,
      version: VERSION,
      location: `node_modules/${PACKAGE_NAME}`,
      registry: `${registry}/`,
      attestations: [{ predicateType: 'https://slsa.dev/provenance/v1' }],
      attestationBundles: [attestation],
    }],
  };
}

function createTriggerRepository(): { root: string; sha: string } {
  const root = makeTempRoot('release-boundary-trigger-');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, '.github'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify(packageManifest(), null, 2));
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'oh-my-copilot', version: VERSION }));
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'oh-my-copilot', version: VERSION }));
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    version: VERSION,
    plugins: [{ name: 'oh-my-copilot', version: VERSION }],
  }));
  writeFileSync(join(root, 'docs', 'CLAUDE.md'), `<!-- OMC:VERSION:${VERSION} -->\n`);
  writeFileSync(join(root, 'CHANGELOG.md'), `# oh-my-copilot v${VERSION}: fixture\n`);
  writeFileSync(join(root, '.github', 'release-body.md'), '# Release notes\n');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'release@example.test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'release fixture'], { cwd: root, stdio: 'ignore' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  execFileSync('git', ['tag', '-a', TAG, '-m', TAG], { cwd: root, stdio: 'ignore' });
  return { root, sha };
}

afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('release-boundary.mjs', () => {
  it('runs as a CLI: an unknown subcommand exits non-zero (was a silent no-op on Windows)', () => {
    const script = fileURLToPath(new URL('../../scripts/release-boundary.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [script, 'no-such-command'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('release-boundary: unknown command: no-such-command');
  });

  it('fails closed for npm collision, status, malformed-body, transport, and timeout states', async () => {
    const server = await startServer((request, response) => {
      switch (request.url) {
        case `/${PACKAGE_NAME}/4.15.4`:
          response.writeHead(404);
          response.end();
          break;
        case `/${PACKAGE_NAME}/4.15.5`:
          sendJson(response, 200, { version: '4.15.5' });
          break;
        case `/${PACKAGE_NAME}/4.15.6`:
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end('{malformed');
          break;
        case `/${PACKAGE_NAME}/4.15.7`:
          request.socket.destroy();
          break;
        case `/${PACKAGE_NAME}/4.15.8`:
          break;
        default:
          response.writeHead(500);
          response.end();
      }
    });
    try {
      await withEnvironment({ RELEASE_BOUNDARY_REGISTRY_URL: server.base }, async () => {
        await expect(assertNpmAbsent(PACKAGE_NAME, VERSION)).resolves.toMatchObject({ absent: true });
        await expect(assertNpmAbsent(PACKAGE_NAME, '4.15.5')).rejects.toThrow('already exists');
        await expect(assertNpmAbsent(PACKAGE_NAME, '4.15.6')).rejects.toThrow('unexpected HTTP 503');
        await expect(assertNpmAbsent(PACKAGE_NAME, '4.15.7')).rejects.toThrow('network request failed');
      });
      await withEnvironment({
        RELEASE_BOUNDARY_REGISTRY_URL: server.base,
        RELEASE_BOUNDARY_FETCH_TIMEOUT_MS: '10',
      }, async () => {
        await expect(assertNpmAbsent(PACKAGE_NAME, '4.15.8')).rejects.toThrow('network request failed');
      });
    } finally {
      await server.close();
    }
  });

  it('requires an annotated tag, exact checkout SHA, version parity, and committed release notes', () => {
    const { root, sha } = createTriggerRepository();
    expect(assertTrigger({ tag: TAG, sha, cwd: root })).toEqual({ version: VERSION, sha });
    expect(() => assertTrigger({ tag: VERSION, sha, cwd: root })).toThrow('canonical');
    expect(() => assertTrigger({ tag: TAG, sha: 'b'.repeat(40), cwd: root })).toThrow('same commit');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...packageManifest(), version: '4.15.3' }));
    expect(() => assertTrigger({ tag: TAG, sha, cwd: root })).toThrow('package.json version');
    writeFileSync(join(root, 'package.json'), JSON.stringify(packageManifest(), null, 2));

    writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'oh-my-copilot', version: '4.15.3' }));
    expect(() => assertTrigger({ tag: TAG, sha, cwd: root })).toThrow('plugin.json version');
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'oh-my-claudecode', version: VERSION }));
    expect(() => assertTrigger({ tag: TAG, sha, cwd: root })).toThrow('plugin.json name');
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'oh-my-copilot', version: VERSION }));

    writeFileSync(join(root, 'docs', 'CLAUDE.md'), '<!-- OMC:VERSION:4.15.3 -->\n');
    expect(() => assertTrigger({ tag: TAG, sha, cwd: root })).toThrow('does not advertise');

    writeFileSync(join(root, 'docs', 'CLAUDE.md'), `<!-- OMC:VERSION:${VERSION} -->\n`);
    writeFileSync(join(root, '.github', 'release-body.md'), ' \n');
    expect(() => assertTrigger({ tag: TAG, sha, cwd: root })).toThrow('must be non-empty');
    writeFileSync(join(root, '.github', 'release-body.md'), '# Changed release notes\n');
    expect(() => assertTrigger({ tag: TAG, sha, cwd: root })).toThrow('match the contents committed at HEAD');
    execFileSync('git', ['tag', '-d', TAG], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['tag', TAG], { cwd: root, stdio: 'ignore' });
    expect(() => assertTrigger({ tag: TAG, sha, cwd: root })).toThrow('must be annotated');
  });

  it('stages a safe npm archive with only a staged gitHead injection and rejects traversal', () => {
    const root = makeTempRoot('release-boundary-stage-');
    const trackedManifestPath = join(root, 'package.json');
    const trackedManifest = `${JSON.stringify(packageManifest(), null, 2)}\n`;
    writeFileSync(trackedManifestPath, trackedManifest);
    const seedPath = writeTarball(root, 'seed.tgz', makeTarball([
      { path: 'package/package.json', content: trackedManifest },
      { path: 'package/bin/oh-my-copilot.js', content: '#!/usr/bin/env node\n', mode: 0o755 },
    ]));
    const stage = join(root, 'stage');

    prepareStage(seedPath, stage, SHA);
    expect(readFileSync(trackedManifestPath, 'utf8')).toBe(trackedManifest);
    expect(JSON.parse(readFileSync(join(stage, 'package', 'package.json'), 'utf8'))).toMatchObject({
      name: PACKAGE_NAME,
      version: VERSION,
      gitHead: SHA,
    });

    const traversalPath = writeTarball(root, 'traversal.tgz', makeTarball([
      { path: '../outside.txt', content: 'escape' },
    ]));
    const rejectedStage = join(root, 'rejected-stage');
    expect(() => prepareStage(traversalPath, rejectedStage, SHA)).toThrow('unsafe');
    expect(() => readFileSync(join(root, 'outside.txt'), 'utf8')).toThrow();
  });

  it('asserts the final archive surfaces and records tamper-evident byte and content manifests', async () => {
    const root = makeTempRoot('release-boundary-evidence-');
    const tarballPath = writeTarball(root, `${PACKAGE_NAME}-${VERSION}.tgz`, releaseTarball());
    const evidencePath = join(root, 'release-evidence.json');

    expect(() => assertArchive(tarballPath, { version: VERSION, gitHead: SHA })).not.toThrow();
    const evidence = writeEvidence(tarballPath, evidencePath);
    expect(evidence).toMatchObject({
      package: { name: PACKAGE_NAME, version: VERSION, gitHead: SHA },
      sourceSha: SHA,
      tag: TAG,
      npmIntegrity: expect.stringMatching(/^sha512-/),
    });
    expect(evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.archiveManifest).toMatchObject({
      algorithm: 'sha256',
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(evidence.archiveManifest.files).toContainEqual(expect.objectContaining({
      path: 'package/bridge/claude-md-coordinator.cjs',
      byteLength: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(evidence.archiveManifest.files.map((file: { path: string }) => file.path)).toEqual([
      'package/.claude-plugin/marketplace.json',
      'package/.claude-plugin/plugin.json',
      'package/.mcp.json',
      'package/README.md',
      'package/bin/oh-my-copilot.js',
      'package/bridge/claude-md-coordinator.cjs',
      'package/bridge/cli.cjs',
      'package/bridge/mcp-server.cjs',
      'package/bridge/runtime-cli.cjs',
      'package/bridge/team.js',
      'package/copilot/agents/executor.md',
      'package/copilot/hooks.json',
      'package/package.json',
      'package/plugin.json',
      'package/scripts/copilot/dispatch.cjs',
      'package/scripts/lib/copilot-hook-adapter.cjs',
    ]);

    const forbiddenPath = writeTarball(root, 'forbidden.tgz', releaseTarball(SHA, [
      { path: 'package/.omg/evidence.json', content: '{}' },
    ]));
    expect(() => assertArchive(forbiddenPath, { version: VERSION, gitHead: SHA })).toThrow('forbidden operational artifact');
    expect(assertEvidence(tarballPath, evidencePath)).toEqual(evidence);
    const missingCoordinatorPath = writeTarball(root, 'missing-coordinator.tgz', makeTarball([
      { path: 'package/package.json', content: `${JSON.stringify(packageManifest(SHA), null, 2)}\n` },
      { path: 'package/.claude-plugin/plugin.json', content: JSON.stringify({ name: 'oh-my-copilot', version: VERSION }) },
      { path: 'package/.claude-plugin/marketplace.json', content: JSON.stringify({ version: VERSION, plugins: [{ name: 'oh-my-copilot', version: VERSION, source: './' }] }) },
      { path: 'package/.mcp.json', content: JSON.stringify({ mcpServers: { omc: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs'] } } }) },
      { path: 'package/bin/oh-my-copilot.js', content: '#!/usr/bin/env node\n', mode: 0o755 },
      { path: 'package/bridge/cli.cjs', content: 'module.exports = {};\n' },
      { path: 'package/bridge/mcp-server.cjs', content: 'module.exports = {};\n' },
      { path: 'package/bridge/runtime-cli.cjs', content: 'module.exports = {};\n' },
      { path: 'package/bridge/team.js', content: 'export {};\n' },
    ]));
    expect(() => assertArchive(missingCoordinatorPath, { version: VERSION, gitHead: SHA })).toThrow('bridge/claude-md-coordinator.cjs');
    for (const required of [
      'plugin.json',
      'copilot/hooks.json',
      'copilot/agents/executor.md',
      'scripts/copilot/dispatch.cjs',
      'scripts/lib/copilot-hook-adapter.cjs',
    ]) {
      const missingPath = writeTarball(
        root,
        'missing-copilot-surface.tgz',
        releaseTarball(SHA, [], '# fixture\n', [`package/${required}`]),
      );
      expect(() => assertArchive(missingPath, { version: VERSION, gitHead: SHA })).toThrow(required);
    }
    for (const rootPlugin of [
      { name: 'oh-my-copilot', version: '4.15.3' },
      { name: 'oh-my-claudecode', version: VERSION },
    ]) {
      const wrongRootPluginPath = writeTarball(
        root,
        'wrong-root-plugin.tgz',
        releaseTarball(SHA, [], '# fixture\n', [], rootPlugin),
      );
      expect(() => assertArchive(wrongRootPluginPath, { version: VERSION, gitHead: SHA })).toThrow('root plugin.json');
    }
    await expect(cliMain([
      'assert-evidence',
      '--tarball',
      tarballPath,
      '--evidence',
      evidencePath,
    ])).resolves.toBeUndefined();
    writeFileSync(tarballPath, releaseTarball(SHA, [], '# tampered bytes\n'));
    expect(() => assertEvidence(tarballPath, evidencePath)).toThrow();
  });

  it.each([
    'package/con/config.json',
    'package/COM1.txt',
    'package/lpt²/log.txt',
    'package/CON .txt',
    'package/cache./value.json',
    'package/cache /value.json',
  ])('rejects Windows archive path collisions: %s', path => {
    const root = makeTempRoot('release-boundary-windows-path-');
    const tarballPath = writeTarball(
      root,
      'unsafe-windows-path.tgz',
      releaseTarball(SHA, [{ path, content: 'unsafe' }]),
    );
    expect(() => assertArchive(tarballPath, { version: VERSION, gitHead: SHA }))
      .toThrow('tar archive path is unsafe');
  });

  it('decodes exactly one DSSE SLSA statement and requires distinct workflow-v1 build type and GitHub-hosted builder', () => {

    const archiveEvidence = buildEvidenceFromBytes(releaseTarball());
    const payload = dssePayload(archiveEvidence.sha512.hex);
    const attestation = slsaAttestation(payload);
    expect(selectSlsaAttestation({ attestations: [attestation] })).toBe(attestation);
    expect(decodeDssePayload(attestation)).toEqual(payload);
    expect(assertSlsaProvenance(payload, {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      sha512: archiveEvidence.sha512.hex,
    })).toBe(true);
    const wrongBuildTypePayload = dssePayload(archiveEvidence.sha512.hex);
    (wrongBuildTypePayload.predicate as { buildDefinition: { buildType: string } }).buildDefinition.buildType = 'https://github.com/actions/runner/github-hosted';
    expect(() => assertSlsaProvenance(wrongBuildTypePayload, {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      sha512: archiveEvidence.sha512.hex,
    })).toThrow('workflow v1 build type');
    const wrongBuilderPayload = dssePayload(archiveEvidence.sha512.hex);
    (wrongBuilderPayload.predicate as { runDetails: { builder: { id: string } } }).runDetails.builder.id = 'https://github.com/actions/runner/self-hosted';
    expect(() => assertSlsaProvenance(wrongBuilderPayload, {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      sha512: archiveEvidence.sha512.hex,
    })).toThrow('builder id');

    expect(() => selectSlsaAttestation({ attestations: [attestation, attestation] })).toThrow('exactly one');
    expect(() => decodeDssePayload({ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: 'bad!' } } })).toThrow('canonical base64');
    const wrongRefPayload = dssePayload(archiveEvidence.sha512.hex);
    const wrongRefPredicate = wrongRefPayload.predicate as {
      buildDefinition: {
        externalParameters: { workflow: Record<string, unknown> };
      };
    };
    wrongRefPredicate.buildDefinition.externalParameters.workflow.ref = 'refs/tags/v4.15.3';
    const wrongSubjectPayload = dssePayload('b'.repeat(128));
    expect(() => assertSlsaProvenance(wrongSubjectPayload, {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      sha512: archiveEvidence.sha512.hex,
    })).toThrow('subject');
    const wrongCommitPayload = dssePayload(archiveEvidence.sha512.hex);
    const wrongCommitPredicate = wrongCommitPayload.predicate as {
      buildDefinition: {
        resolvedDependencies: Array<{ digest: Record<string, unknown> }>;
      };
    };
    wrongCommitPredicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'b'.repeat(40);
    expect(() => assertSlsaProvenance(wrongCommitPayload, {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      sha512: archiveEvidence.sha512.hex,
    })).toThrow('resolved dependency');
    expect(() => assertSlsaProvenance(wrongRefPayload, {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      sha512: archiveEvidence.sha512.hex,
    })).toThrow('workflow repository, path, or ref');
    const wrongPathPayload = dssePayload(archiveEvidence.sha512.hex);
    const wrongPathPredicate = wrongPathPayload.predicate as {
      buildDefinition: {
        externalParameters: { workflow: Record<string, unknown> };
      };
    };
    wrongPathPredicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/release.yml';
    expect(() => assertSlsaProvenance(wrongPathPayload, {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      sha512: archiveEvidence.sha512.hex,
    })).toThrow('workflow repository, path, or ref');
    const wrongRepoPayload = dssePayload(archiveEvidence.sha512.hex);
    const wrongRepoPredicate = wrongRepoPayload.predicate as {
      buildDefinition: {
        externalParameters: { workflow: Record<string, unknown> };
      };
    };
    wrongRepoPredicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/example/wrong';
    expect(() => assertSlsaProvenance(wrongRepoPayload, {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      sha512: archiveEvidence.sha512.hex,
    })).toThrow('workflow repository, path, or ref');
  });

  it('verifies registry bytes against evidence and rejects fallback provenance', async () => {
    const root = makeTempRoot('release-boundary-registry-');
    const tarball = releaseTarball();
    const localTarballPath = writeTarball(root, `${PACKAGE_NAME}-${VERSION}.tgz`, tarball);
    const evidencePath = join(root, 'release-evidence.json');
    const evidence = writeEvidence(localTarballPath, evidencePath);
    let base = '';
    let servedTarball = tarball;
    let registryAttestation = slsaAttestation(dssePayload(evidence.sha512.hex));

    const server = await startServer((request, response) => {
      if (request.url === `/${PACKAGE_NAME}/${VERSION}`) {
        sendJson(response, 200, {
          name: PACKAGE_NAME,
          version: VERSION,
          gitHead: SHA,
          dist: {
            tarball: `${base}/tarballs/${PACKAGE_NAME}-${VERSION}.tgz`,
            integrity: evidence.npmIntegrity,
            shasum: evidence.sha1,
            signatures: [{ keyid: 'fixture', sig: 'fixture' }],
          },
        });
        return;
      }
      if (request.url === `/${PACKAGE_NAME}`) {
        sendJson(response, 200, { 'dist-tags': { latest: VERSION } });
        return;
      }
      if (request.url === `/tarballs/${PACKAGE_NAME}-${VERSION}.tgz`) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(servedTarball);
        return;
      }
      if (request.url === `/-/npm/v1/attestations/${PACKAGE_NAME}@${VERSION}`) {
        sendJson(response, 200, { attestations: [registryAttestation] });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    base = server.base;
    const auditPath = join(root, 'npm-audit-signatures.json');
    const npmVerifiedAttestation = slsaAttestation(dssePayload(evidence.sha512.hex));
    writeFileSync(auditPath, JSON.stringify(auditReport(npmVerifiedAttestation, base)));
    const requiredRegistryOptions = {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      evidencePath,
      tarballPath: localTarballPath,
      provenance: 'required',
      auditPath,
    };
    try {
      await withEnvironment({ RELEASE_BOUNDARY_REGISTRY_URL: base }, async () => {
        await expect(cliMain([
          'verify-registry',
          '--package',
          PACKAGE_NAME,
          '--version',
          VERSION,
          '--tag',
          TAG,
          '--sha',
          SHA,
          '--evidence',
          evidencePath,
          '--tarball',
          localTarballPath,
          '--provenance',
          'required',
        ])).rejects.toThrow('--audit is required');

        await expect(cliMain([
          'verify-registry',
          '--package',
          PACKAGE_NAME,
          '--version',
          VERSION,
          '--tag',
          TAG,
          '--sha',
          SHA,
          '--evidence',
          evidencePath,
          '--tarball',
          localTarballPath,
          '--provenance',
          'required',
          '--audit',
          auditPath,

        ])).resolves.toBeUndefined();

        servedTarball = releaseTarball(SHA, [], '# tampered bytes\n');
        await expect(verifyRegistry({
          packageName: PACKAGE_NAME,
          version: VERSION,
          tag: TAG,
          sha: SHA,
          evidencePath,
          tarballPath: localTarballPath,
          provenance: 'required',
          auditPath,
        })).rejects.toThrow();
        servedTarball = tarball;
        writeFileSync(auditPath, JSON.stringify(auditReport(npmVerifiedAttestation, base, { invalid: [{ code: 'EATTESTATIONVERIFY' }] })));
        await expect(verifyRegistry(requiredRegistryOptions)).rejects.toThrow('invalid or missing signatures');
        writeFileSync(auditPath, JSON.stringify(auditReport(npmVerifiedAttestation, base, { missing: [{ name: PACKAGE_NAME }] })));
        await expect(verifyRegistry(requiredRegistryOptions)).rejects.toThrow('invalid or missing signatures');
        writeFileSync(auditPath, JSON.stringify(auditReport(npmVerifiedAttestation, base, {
          verified: [{
            name: 'wrong-package',
            version: VERSION,
            registry: `${base}/`,
            attestationBundles: [npmVerifiedAttestation],
          }],
        })));
        await expect(verifyRegistry(requiredRegistryOptions)).rejects.toThrow(`exactly one verified ${PACKAGE_NAME}@${VERSION} entry`);
        writeFileSync(auditPath, JSON.stringify(auditReport(npmVerifiedAttestation, base)));
        registryAttestation = slsaAttestation(dssePayload(evidence.sha512.hex), 'different-signature');
        await expect(verifyRegistry(requiredRegistryOptions)).rejects.toThrow('DSSE signatures mismatch');
        registryAttestation = slsaAttestation(dssePayload('b'.repeat(128)));
        await expect(verifyRegistry(requiredRegistryOptions)).rejects.toThrow('DSSE payload mismatch');
        registryAttestation = slsaAttestation(dssePayload(evidence.sha512.hex));
      });

      const publishLogPath = join(root, 'npm-publish.log');
      writeFileSync(publishLogPath, 'npm error code TLOG_CREATE_ENTRY_ERROR\nnpm error rekor unavailable\n');
      await expect(cliMain([
        'verify-registry',
        '--package',
        PACKAGE_NAME,
        '--version',
        VERSION,
        '--tag',
        TAG,
        '--sha',
        SHA,
        '--evidence',
        evidencePath,
        '--tarball',
        localTarballPath,
        '--provenance',
        'sigstore-fallback',
        '--publish-log',
        publishLogPath,
        '--audit',
        auditPath,
      ])).rejects.toThrow('provenance must be required');
      await expect(cliMain([
        'assert-sigstore-fallback',
        '--publish-log',
        publishLogPath,
      ])).rejects.toThrow('unknown command');
      await expect(verifyRegistry({
        packageName: PACKAGE_NAME,
        version: VERSION,
        tag: TAG,
        sha: SHA,
        evidencePath,
        tarballPath: localTarballPath,
        provenance: 'sigstore-fallback',
        publishLog: publishLogPath,
      })).rejects.toThrow('provenance must be required');
      await expect(cliMain([
        'verify-registry',
        '--package',
        PACKAGE_NAME,
        '--version',
        VERSION,
        '--tag',
        TAG,
        '--sha',
        SHA,
        '--evidence',
        evidencePath,
        '--tarball',
        localTarballPath,
        '--provenance',
        'required',
        '--audit',
        auditPath,
        '--publish-log',
        publishLogPath,
      ])).rejects.toThrow('--publish-log is not valid');
    } finally {
      await server.close();
    }
  });

  it('waits for registry propagation on 404/408/429/5xx but fails at once on other statuses and wrong bytes', async () => {
    const root = makeTempRoot('release-boundary-propagation-');
    const tarball = releaseTarball();
    const localTarballPath = writeTarball(root, `${PACKAGE_NAME}-${VERSION}.tgz`, tarball);
    const evidencePath = join(root, 'release-evidence.json');
    const evidence = writeEvidence(localTarballPath, evidencePath);
    let base = '';
    // Status codes the next tarball requests answer with before the real bytes; 'always404' never serves them.
    let tarballStatuses: number[] = [];
    let always404 = false;
    let servedTarball = tarball;
    let tarballRequests = 0;
    const attestation = slsaAttestation(dssePayload(evidence.sha512.hex));
    // Per-path answers served before the real one: a status (3xx with a Location), a reset socket, a 404 whose body
    // stalls, a 200 whose body is cut off by a reset ('cut'), stalls ('stall200') or trickles in slowly ('trickle200').
    const failNext: Record<string, Array<number | 'reset' | 'stall' | 'cut' | 'stall200' | 'trickle200'>> = {};
    const stalled: ServerResponse[] = [];
    const requests: Record<string, number> = {};

    const server = await startServer((request, response) => {
      const path = request.url ?? '';
      requests[path] = (requests[path] ?? 0) + 1;
      const action = failNext[path]?.shift();
      if (action === 'reset') {
        request.socket.destroy();
        return;
      }
      if (action === 'cut') {
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(tarball.length) });
        response.write(tarball.subarray(0, Math.floor(tarball.length / 2)), () => request.socket.destroy());
        return;
      }
      if (action === 'stall200') {
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(tarball.length) });
        response.write(tarball.subarray(0, 1));
        stalled.push(response);
        return;
      }
      if (action === 'trickle200') {
        // The real bytes in 6 chunks, 150 ms apart: about 750 ms in all, longer than the 300 ms request timeout.
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(servedTarball.length) });
        const size = Math.ceil(servedTarball.length / 6);
        let offset = 0;
        const next = () => {
          const end = Math.min(offset + size, servedTarball.length);
          response.write(servedTarball.subarray(offset, end));
          offset = end;
          if (offset < servedTarball.length) setTimeout(next, 150);
          else response.end();
        };
        next();
        return;
      }
      if (action === 'stall') {
        response.writeHead(404, { 'content-length': '1000' });
        response.write('x');
        stalled.push(response);
        return;
      }
      if (action !== undefined) {
        response.writeHead(action, action >= 300 && action < 400 ? { location: `${base}${path}` } : {});
        response.end();
        return;
      }
      if (request.url === `/${PACKAGE_NAME}/${VERSION}`) {
        sendJson(response, 200, {
          name: PACKAGE_NAME,
          version: VERSION,
          gitHead: SHA,
          dist: {
            tarball: `${base}/tarballs/${PACKAGE_NAME}-${VERSION}.tgz`,
            integrity: evidence.npmIntegrity,
            shasum: evidence.sha1,
            signatures: [{ keyid: 'fixture', sig: 'fixture' }],
          },
        });
        return;
      }
      if (request.url === `/${PACKAGE_NAME}`) {
        sendJson(response, 200, { 'dist-tags': { latest: VERSION } });
        return;
      }
      if (request.url === `/tarballs/${PACKAGE_NAME}-${VERSION}.tgz`) {
        tarballRequests += 1;
        const status = always404 ? 404 : tarballStatuses.shift();
        if (status !== undefined) {
          response.writeHead(status);
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(servedTarball);
        return;
      }
      if (request.url === `/-/npm/v1/attestations/${PACKAGE_NAME}@${VERSION}`) {
        sendJson(response, 200, { attestations: [attestation] });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    base = server.base;
    const auditPath = join(root, 'npm-audit-signatures.json');
    writeFileSync(auditPath, JSON.stringify(auditReport(attestation, base)));
    const options = {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      evidencePath,
      tarballPath: localTarballPath,
      provenance: 'required',
      auditPath,
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const reset = (statuses: number[]) => {
      tarballStatuses = statuses;
      tarballRequests = 0;
      for (const key of Object.keys(requests)) delete requests[key];
      stderr.mockClear();
    };
    const tarballPath = `/tarballs/${PACKAGE_NAME}-${VERSION}.tgz`;
    const metadataPath = `/${PACKAGE_NAME}/${VERSION}`;
    const rootPath = `/${PACKAGE_NAME}`;
    const attestationPath = `/-/npm/v1/attestations/${PACKAGE_NAME}@${VERSION}`;
    try {
      await withEnvironment({
        RELEASE_BOUNDARY_REGISTRY_URL: base,
        RELEASE_BOUNDARY_PROPAGATION_BUDGET_MS: '60000',
        RELEASE_BOUNDARY_PROPAGATION_DELAY_MS: '100',
        RELEASE_BOUNDARY_PROPAGATION_MAX_DELAY_MS: '100',
      }, async () => {
        reset([404, 404]);
        await expect(verifyRegistry(options)).resolves.toMatchObject({ provenance: 'required' });
        expect(tarballRequests).toBe(3);
        const waits = stderr.mock.calls.map(([line]) => String(line));
        expect(waits).toHaveLength(2);
        expect(waits[0]).toContain('registry tarball returned HTTP 404; waiting');
        expect(waits[0]).toContain('(attempt 2)');
        expect(waits[1]).toContain('(attempt 3)');

        reset([503, 500]);
        await expect(verifyRegistry(options)).resolves.toMatchObject({ provenance: 'required' });
        expect(tarballRequests).toBe(3);
        expect(String(stderr.mock.calls[0]?.[0])).toContain('registry tarball returned HTTP 503');

        // Rate limiting and request timeouts are "not there yet" too.
        reset([429, 408]);
        await expect(verifyRegistry(options)).resolves.toMatchObject({ provenance: 'required' });
        expect(tarballRequests).toBe(3);
        expect(String(stderr.mock.calls[0]?.[0])).toContain('registry tarball returned HTTP 429; waiting');
        expect(String(stderr.mock.calls[1]?.[0])).toContain('registry tarball returned HTTP 408; waiting');

        // A 200 whose body is cut off by a reset is a transient network error, waited out like a reset before the headers.
        reset([]);
        failNext[tarballPath] = ['cut'];
        await expect(verifyRegistry(options)).resolves.toMatchObject({ provenance: 'required' });
        expect(requests[tarballPath]).toBe(2);
        expect(String(stderr.mock.calls[0]?.[0])).toMatch(/^release-boundary: registry tarball network request failed for .*; waiting/);

        reset([403]);
        await expect(verifyRegistry(options)).rejects.toThrow(/^registry tarball returned HTTP 403$/);
        expect(tarballRequests).toBe(1);
        expect(stderr).not.toHaveBeenCalled();

        reset([]);
        servedTarball = releaseTarball(SHA, [], '# tampered bytes\n');
        await expect(verifyRegistry(options)).rejects.toThrow(/registry tarball (byte length|SHA-512) mismatch/);
        expect(tarballRequests).toBe(1);
        expect(stderr).not.toHaveBeenCalled();
        servedTarball = tarball;

        // A redirect is not propagation: it fails at once, as before the wait existed.
        reset([302]);
        await expect(verifyRegistry(options)).rejects.toThrow(/^registry tarball returned HTTP 302$/);
        expect(tarballRequests).toBe(1);
        expect(stderr).not.toHaveBeenCalled();

        // The version metadata, root metadata and attestation reads wait too, and so does a reset connection.
        reset([]);
        failNext[metadataPath] = [404];
        failNext[rootPath] = [503];
        failNext[attestationPath] = ['reset', 404];
        await expect(verifyRegistry(options)).resolves.toMatchObject({ provenance: 'required' });
        expect(requests).toMatchObject({ [metadataPath]: 2, [rootPath]: 2, [attestationPath]: 3, [tarballPath]: 1 });
        const waited = stderr.mock.calls.map(([line]) => String(line));
        expect(waited).toHaveLength(4);
        expect(waited[0]).toContain('registry version metadata returned HTTP 404; waiting');
        expect(waited[1]).toContain('registry root metadata returned HTTP 503; waiting');
        expect(waited[2]).toMatch(/^release-boundary: attestation endpoint network request failed for .*; waiting/);
        expect(waited[3]).toContain('attestation endpoint returned HTTP 404; waiting');

        // A 404 whose body never arrives is cancelled, not read: the next attempt goes out at once.
        reset([]);
        failNext[tarballPath] = ['stall'];
        const started = Date.now();
        await expect(verifyRegistry(options)).resolves.toMatchObject({ provenance: 'required' });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(requests[tarballPath]).toBe(2);
        expect(String(stderr.mock.calls[0]?.[0])).toContain('registry tarball returned HTTP 404; waiting');
      });

      // A 200 whose body stalls is read inside the request timeout: aborted, then waited out, never a hang.
      await withEnvironment({
        RELEASE_BOUNDARY_REGISTRY_URL: base,
        RELEASE_BOUNDARY_FETCH_TIMEOUT_MS: '2000',
        RELEASE_BOUNDARY_PROPAGATION_BUDGET_MS: '60000',
        RELEASE_BOUNDARY_PROPAGATION_DELAY_MS: '100',
        RELEASE_BOUNDARY_PROPAGATION_MAX_DELAY_MS: '100',
      }, async () => {
        reset([]);
        failNext[tarballPath] = ['stall200'];
        await expect(verifyRegistry(options)).resolves.toMatchObject({ provenance: 'required' });
        expect(requests[tarballPath]).toBeGreaterThanOrEqual(2);
        expect(stderr.mock.calls.map(([line]) => String(line)).some((line) => /^release-boundary: registry tarball network request failed for .*; waiting/.test(line))).toBe(true);
      });

      // A 200 whose body keeps arriving for longer than the request timeout completes on the first attempt: the timer
      // restarts with every chunk, it only aborts a body that stops.
      await withEnvironment({
        RELEASE_BOUNDARY_REGISTRY_URL: base,
        RELEASE_BOUNDARY_FETCH_TIMEOUT_MS: '300',
        RELEASE_BOUNDARY_PROPAGATION_BUDGET_MS: '60000',
        RELEASE_BOUNDARY_PROPAGATION_DELAY_MS: '100',
        RELEASE_BOUNDARY_PROPAGATION_MAX_DELAY_MS: '100',
      }, async () => {
        reset([]);
        failNext[tarballPath] = ['trickle200'];
        const started = Date.now();
        await expect(verifyRegistry(options)).resolves.toMatchObject({ provenance: 'required' });
        expect(Date.now() - started).toBeGreaterThan(300);
        expect(requests[tarballPath]).toBe(1);
        expect(stderr).not.toHaveBeenCalled();
      });

      // Refused connections, unknown or unreachable hosts and TLS failures are not waited out: they fail at once.
      // The connect errors are injected (as undici reports them: TypeError "fetch failed" with the code on its cause),
      // so neither port reuse nor Windows' slow refusal of a closed local port can turn them into a timeout.
      for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH']) {
        const refused = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
          throw new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code}`), { code }) });
        });
        try {
          await withEnvironment({
            RELEASE_BOUNDARY_REGISTRY_URL: base,
            RELEASE_BOUNDARY_PROPAGATION_BUDGET_MS: '60000',
            RELEASE_BOUNDARY_PROPAGATION_DELAY_MS: '100',
          }, async () => {
            reset([]);
            await expect(verifyRegistry(options)).rejects.toThrow(/^network request failed for .*: fetch failed$/);
            expect(refused).toHaveBeenCalledTimes(1);
            expect(stderr).not.toHaveBeenCalled();
          });
        } finally {
          refused.mockRestore();
        }
      }
      // TLS against the live plain-HTTP fixture server fails in the handshake, at once.
      const tlsRegistry = base.replace('http:', 'https:');
      await withEnvironment({
        RELEASE_BOUNDARY_REGISTRY_URL: tlsRegistry,
        RELEASE_BOUNDARY_PROPAGATION_BUDGET_MS: '60000',
        RELEASE_BOUNDARY_PROPAGATION_DELAY_MS: '100',
      }, async () => {
        reset([]);
        const registryAudit = join(root, 'npm-audit-signatures-other.json');
        writeFileSync(registryAudit, JSON.stringify(auditReport(attestation, tlsRegistry)));
        await expect(verifyRegistry({ ...options, auditPath: registryAudit })).rejects.toThrow(/^network request failed for /);
        expect(stderr).not.toHaveBeenCalled();
      });

      // No setting turns the wait into a tight request loop.
      for (const name of ['RELEASE_BOUNDARY_PROPAGATION_DELAY_MS', 'RELEASE_BOUNDARY_PROPAGATION_MAX_DELAY_MS']) {
        await withEnvironment({ RELEASE_BOUNDARY_REGISTRY_URL: base, [name]: '0' }, async () => {
          await expect(verifyRegistry(options)).rejects.toThrow(`${name} must be an integer between 100 and 600000`);
        });
      }

      await withEnvironment({
        RELEASE_BOUNDARY_REGISTRY_URL: base,
        // The budget's clock starts before the metadata reads; however long they take, the message counts the attempts.
        RELEASE_BOUNDARY_PROPAGATION_BUDGET_MS: '1500',
        RELEASE_BOUNDARY_PROPAGATION_DELAY_MS: '100',
        RELEASE_BOUNDARY_PROPAGATION_MAX_DELAY_MS: '100',
      }, async () => {
        reset([]);
        always404 = true;
        const failure = await verifyRegistry(options).then(() => undefined, (error: unknown) => error as Error);
        always404 = false;
        expect(failure).toBeInstanceOf(Error);
        expect(failure?.message).toContain('registry tarball returned HTTP 404 after');
        expect(failure?.message).toContain(`${PACKAGE_NAME}@${VERSION} IS published`);
        expect(failure?.message).toContain('do not republish');
        expect(failure?.message).toContain(`Release Recovery workflow (tag=${TAG} sha=${SHA})`);
        expect(failure?.message).toContain(`registry tarball returned HTTP 404 after ${tarballRequests} attempt(s) over 2s`);
        expect(tarballRequests).toBeGreaterThanOrEqual(1);
      });
    } finally {
      stderr.mockRestore();
      for (const response of stalled) response.destroy();
      await server.close();
    }
  });

  it('runs the CLI when invoked by an absolute OS path', () => {
    const script = resolve('scripts/release-boundary.mjs');
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [script, 'no-such-command'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      ({ status, stderr } = error as { status: number; stderr: string });
    }
    expect(status).toBe(1);
    expect(stderr).toContain('unknown command: no-such-command');
  });
});

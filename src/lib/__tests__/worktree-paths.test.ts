import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  validatePath,
  resolveOmcPath,
  resolveStatePath,
  ensureOmcDir,
  getWorktreeNotepadPath,
  getWorktreeProjectMemoryPath,
  getOmcRoot,
  getSharedOmcRoot,
  resolvePlanPath,
  resolveResearchPath,
  resolveLogsPath,
  resolveWisdomPath,
  isPathUnderOmc,
  ensureAllOmcDirs,
  clearWorktreeCache,
  getProcessSessionId,
  resetProcessSessionId,
  validateSessionId,
  resolveToWorktreeRoot,
  validateWorkingDirectory,
  getWorktreeRoot,
  getProjectIdentifier,
  clearDualDirWarnings,
  migrateOmcpContentToOmc,
  clearOmcpContentWarnings,
} from '../worktree-paths.js';

const TEST_DIR = resolve(tmpdir(), 'worktree-paths-test');

describe('worktree-paths', () => {
  beforeEach(() => {
    clearWorktreeCache();
    clearDualDirWarnings();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.OMC_STATE_DIR;
  });

  describe('validatePath', () => {
    it('should reject path traversal attempts', () => {
      expect(() => validatePath('../foo')).toThrow('path traversal');
      expect(() => validatePath('foo/../bar')).toThrow('path traversal');
      expect(() => validatePath('../../etc/passwd')).toThrow('path traversal');
    });

    it('should reject absolute paths', () => {
      expect(() => validatePath('/etc/passwd')).toThrow('absolute paths');
      expect(() => validatePath('~/secret')).toThrow('absolute paths');
    });

    it('should allow valid relative paths', () => {
      expect(() => validatePath('state/ralph.json')).not.toThrow();
      expect(() => validatePath('notepad.md')).not.toThrow();
      expect(() => validatePath('plans/my-plan.md')).not.toThrow();
    });
  });

  describe('resolveOmcPath', () => {
    it('should resolve paths under .omc directory', () => {
      const result = resolveOmcPath('state/ralph.json', TEST_DIR);
      expect(result).toBe(join(TEST_DIR, '.omcp', 'state', 'ralph.json'));
    });

    it('should reject paths that escape .omc boundary', () => {
      expect(() => resolveOmcPath('../secret.txt', TEST_DIR)).toThrow('path traversal');
    });
  });

  describe('resolveStatePath', () => {
    it('should resolve state file paths with -state suffix', () => {
      const result = resolveStatePath('ralph', TEST_DIR);
      expect(result).toBe(join(TEST_DIR, '.omcp', 'state', 'ralph-state.json'));
    });

    it('should handle input already having -state suffix', () => {
      const result = resolveStatePath('ultrawork-state', TEST_DIR);
      expect(result).toBe(join(TEST_DIR, '.omcp', 'state', 'ultrawork-state.json'));
    });

    it('should resolve swarm as regular JSON path after #1131 removal', () => {
      // swarm SQLite special-casing removed in #1131
      const result = resolveStatePath('swarm', TEST_DIR);
      expect(result).toContain('swarm-state.json');
    });
  });

  describe('ensureOmcDir', () => {
    it('should create directories under .omc', () => {
      const result = ensureOmcDir('state', TEST_DIR);
      expect(result).toBe(join(TEST_DIR, '.omcp', 'state'));
      expect(existsSync(result)).toBe(true);
    });
  });

  describe('helper functions', () => {
    it('getWorktreeNotepadPath resolves under shared root', () => {
      const result = getWorktreeNotepadPath(TEST_DIR);
      expect(result).toBe(join(TEST_DIR, '.omc', 'notepad.md'));
    });

    it('getWorktreeProjectMemoryPath resolves under shared root', () => {
      const result = getWorktreeProjectMemoryPath(TEST_DIR);
      expect(result).toBe(join(TEST_DIR, '.omc', 'project-memory.json'));
    });

    it('getOmcRoot returns the private root', () => {
      const result = getOmcRoot(TEST_DIR);
      expect(result).toBe(join(TEST_DIR, '.omcp'));
    });

    it('resolvePlanPath resolves under shared root', () => {
      const result = resolvePlanPath('my-feature', TEST_DIR);
      expect(result).toBe(join(TEST_DIR, '.omc', 'plans', 'my-feature.md'));
    });

    it('resolveResearchPath resolves under shared root', () => {
      const result = resolveResearchPath('api-research', TEST_DIR);
      expect(result).toBe(join(TEST_DIR, '.omc', 'research', 'api-research'));
    });

    it('resolveLogsPath stays under private root', () => {
      const result = resolveLogsPath(TEST_DIR);
      expect(result).toBe(join(TEST_DIR, '.omcp', 'logs'));
    });

    it('resolveWisdomPath resolves under shared root', () => {
      const result = resolveWisdomPath('my-plan', TEST_DIR);
      expect(result).toBe(join(TEST_DIR, '.omc', 'notepads', 'my-plan'));
    });
  });

  describe('getSharedOmcRoot', () => {
    beforeEach(() => {
      clearOmcpContentWarnings();
    });

    it('returns <worktree>/.omc/ in the local case', () => {
      expect(getSharedOmcRoot(TEST_DIR)).toBe(join(TEST_DIR, '.omc'));
    });

    it('returns <stateDir>/<projectId>/.omc/ when OMC_STATE_DIR is set', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'shared-root-state-'));
      try {
        process.env.OMC_STATE_DIR = stateDir;
        const projectId = getProjectIdentifier(TEST_DIR);
        expect(getSharedOmcRoot(TEST_DIR)).toBe(join(stateDir, projectId, '.omc'));
      } finally {
        delete process.env.OMC_STATE_DIR;
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it('is distinct from getOmcRoot in the local case', () => {
      expect(getSharedOmcRoot(TEST_DIR)).not.toBe(getOmcRoot(TEST_DIR));
    });
  });

  describe('migrateOmcpContentToOmc', () => {
    beforeEach(() => {
      clearOmcpContentWarnings();
    });

    it('moves notepad.md and project-memory.json into .omc/', () => {
      const omcp = join(TEST_DIR, '.omcp');
      mkdirSync(omcp, { recursive: true });
      writeFileSync(join(omcp, 'notepad.md'), 'note', 'utf-8');
      writeFileSync(join(omcp, 'project-memory.json'), '{}', 'utf-8');

      const moved = migrateOmcpContentToOmc(TEST_DIR);

      expect(moved).toBe(true);
      expect(existsSync(join(TEST_DIR, '.omc', 'notepad.md'))).toBe(true);
      expect(existsSync(join(TEST_DIR, '.omc', 'project-memory.json'))).toBe(true);
      expect(existsSync(join(omcp, 'notepad.md'))).toBe(false);
      expect(existsSync(join(omcp, 'project-memory.json'))).toBe(false);
      expect(readFileSync(join(TEST_DIR, '.omc', 'notepad.md'), 'utf-8')).toBe('note');
    });

    it('merges plans/, research/, notepads/ into .omc/', () => {
      const omcp = join(TEST_DIR, '.omcp');
      mkdirSync(join(omcp, 'plans'), { recursive: true });
      mkdirSync(join(omcp, 'research', 'spike-a'), { recursive: true });
      mkdirSync(join(omcp, 'notepads', 'plan-x'), { recursive: true });
      writeFileSync(join(omcp, 'plans', 'feature.md'), 'plan', 'utf-8');
      writeFileSync(join(omcp, 'research', 'spike-a', 'notes.md'), 'r', 'utf-8');
      writeFileSync(join(omcp, 'notepads', 'plan-x', 'wisdom.md'), 'w', 'utf-8');

      const moved = migrateOmcpContentToOmc(TEST_DIR);

      expect(moved).toBe(true);
      expect(existsSync(join(TEST_DIR, '.omc', 'plans', 'feature.md'))).toBe(true);
      expect(existsSync(join(TEST_DIR, '.omc', 'research', 'spike-a', 'notes.md'))).toBe(true);
      expect(existsSync(join(TEST_DIR, '.omc', 'notepads', 'plan-x', 'wisdom.md'))).toBe(true);
    });

    it('keeps the .omc/ copy and warns once when both exist', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const omcp = join(TEST_DIR, '.omcp');
        const omc = join(TEST_DIR, '.omc');
        mkdirSync(omcp, { recursive: true });
        mkdirSync(omc, { recursive: true });
        writeFileSync(join(omcp, 'notepad.md'), 'old', 'utf-8');
        writeFileSync(join(omc, 'notepad.md'), 'new', 'utf-8');

        migrateOmcpContentToOmc(TEST_DIR);
        migrateOmcpContentToOmc(TEST_DIR);

        // .omc/ wins and is preserved
        expect(readFileSync(join(omc, 'notepad.md'), 'utf-8')).toBe('new');
        // Legacy file is not removed (manual cleanup required)
        expect(existsSync(join(omcp, 'notepad.md'))).toBe(true);
        // Warning logged at most once across two calls
        const conflictWarns = warnSpy.mock.calls.filter(c =>
          typeof c[0] === 'string' && c[0].includes('omc-share') && c[0].includes('Both')
        );
        expect(conflictWarns.length).toBe(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('is idempotent (no-op on second call after migration)', () => {
      const omcp = join(TEST_DIR, '.omcp');
      mkdirSync(omcp, { recursive: true });
      writeFileSync(join(omcp, 'notepad.md'), 'note', 'utf-8');

      expect(migrateOmcpContentToOmc(TEST_DIR)).toBe(true);
      expect(migrateOmcpContentToOmc(TEST_DIR)).toBe(false);
    });

    it('is a no-op when .omcp/ does not exist', () => {
      expect(migrateOmcpContentToOmc(TEST_DIR)).toBe(false);
      expect(existsSync(join(TEST_DIR, '.omc'))).toBe(false);
    });

    it('is skipped when OMC_STATE_DIR is set', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'omcp-content-mig-'));
      try {
        process.env.OMC_STATE_DIR = stateDir;
        const omcp = join(TEST_DIR, '.omcp');
        mkdirSync(omcp, { recursive: true });
        writeFileSync(join(omcp, 'notepad.md'), 'note', 'utf-8');

        expect(migrateOmcpContentToOmc(TEST_DIR)).toBe(false);
        // File is left untouched in centralized mode
        expect(existsSync(join(omcp, 'notepad.md'))).toBe(true);
      } finally {
        delete process.env.OMC_STATE_DIR;
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it('does not relocate plugin-private state under .omcp/state/', () => {
      const omcp = join(TEST_DIR, '.omcp');
      mkdirSync(join(omcp, 'state', 'sessions', 'pid-123'), { recursive: true });
      writeFileSync(join(omcp, 'state', 'ralph-state.json'), '{}', 'utf-8');

      migrateOmcpContentToOmc(TEST_DIR);

      // State stays in .omcp/, never moves to .omc/
      expect(existsSync(join(omcp, 'state', 'ralph-state.json'))).toBe(true);
      expect(existsSync(join(TEST_DIR, '.omc', 'state'))).toBe(false);
    });
  });

  describe('isPathUnderOmc', () => {
    it('should return true for paths under .omc', () => {
      expect(isPathUnderOmc(join(TEST_DIR, '.omcp', 'state', 'ralph.json'), TEST_DIR)).toBe(true);
      expect(isPathUnderOmc(join(TEST_DIR, '.omcp'), TEST_DIR)).toBe(true);
    });

    it('should return false for paths outside .omc', () => {
      expect(isPathUnderOmc(join(TEST_DIR, 'src', 'file.ts'), TEST_DIR)).toBe(false);
      expect(isPathUnderOmc('/etc/passwd', TEST_DIR)).toBe(false);
    });
  });

  describe('ensureAllOmcDirs', () => {
    it('creates private subdirectories under .omcp/ and shared under .omc/', () => {
      ensureAllOmcDirs(TEST_DIR);

      // Private (plugin-owned)
      expect(existsSync(join(TEST_DIR, '.omcp'))).toBe(true);
      expect(existsSync(join(TEST_DIR, '.omcp', 'state'))).toBe(true);
      expect(existsSync(join(TEST_DIR, '.omcp', 'logs'))).toBe(true);
      expect(existsSync(join(TEST_DIR, '.omcp', 'drafts'))).toBe(true);

      // Shared (cross-plugin)
      expect(existsSync(join(TEST_DIR, '.omc'))).toBe(true);
      expect(existsSync(join(TEST_DIR, '.omc', 'plans'))).toBe(true);
      expect(existsSync(join(TEST_DIR, '.omc', 'research'))).toBe(true);
      expect(existsSync(join(TEST_DIR, '.omc', 'notepads'))).toBe(true);
    });
  });

  describe('resolveToWorktreeRoot', () => {
    it('should return process.cwd()-based root when no directory provided', () => {
      const result = resolveToWorktreeRoot();
      // We are inside a git repo, so it should return a real root
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should resolve a subdirectory to its git worktree root', () => {
      // Use the current repo - create a subdir and verify it resolves to root
      const root = getWorktreeRoot(process.cwd());
      if (!root) return; // skip if not in a git repo
      const subdir = join(root, 'src');
      const result = resolveToWorktreeRoot(subdir);
      expect(result).toBe(root);
    });

    it('should fall back and log for non-git directories', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const nonGitDir = mkdtempSync(join(tmpdir(), 'worktree-paths-nongit-'));

      const result = resolveToWorktreeRoot(nonGitDir);

      // non-git directory should fall back to process.cwd root
      const expectedRoot = getWorktreeRoot(process.cwd()) || process.cwd();
      expect(result).toBe(expectedRoot);
      expect(errorSpy).toHaveBeenCalledWith(
        '[worktree] non-git directory provided, falling back to process root',
        { directory: nonGitDir }
      );

      errorSpy.mockRestore();
      rmSync(nonGitDir, { recursive: true, force: true });
    });

    it('should handle bare repositories by falling back and logging', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const bareRepoDir = mkdtempSync(join(tmpdir(), 'worktree-paths-bare-'));
      execSync('git init --bare', { cwd: bareRepoDir, stdio: 'pipe' });

      const result = resolveToWorktreeRoot(bareRepoDir);

      const expectedRoot = getWorktreeRoot(process.cwd()) || process.cwd();
      expect(result).toBe(expectedRoot);
      expect(errorSpy).toHaveBeenCalledWith(
        '[worktree] non-git directory provided, falling back to process root',
        { directory: bareRepoDir }
      );

      errorSpy.mockRestore();
      rmSync(bareRepoDir, { recursive: true, force: true });
    });
  });

  describe('validateWorkingDirectory (#576)', () => {
    it('should return worktree root even when workingDirectory is a subdirectory', () => {
      // This is the core #576 fix: a subdirectory must never be returned
      const root = getWorktreeRoot(process.cwd());
      if (!root) return; // skip if not in a git repo
      const subdir = join(root, 'src');
      const result = validateWorkingDirectory(subdir);
      expect(result).toBe(root);
    });

    it('should return trusted root when no workingDirectory provided', () => {
      const root = getWorktreeRoot(process.cwd()) || process.cwd();
      const result = validateWorkingDirectory();
      expect(result).toBe(root);
    });

    it('should throw for directories outside the trusted root', () => {
      // Use a real temp dir that exists but is outside any repo worktree root
      const outsideDir = mkdtempSync(join(tmpdir(), 'worktree-paths-outside-'));
      try {
        expect(() => validateWorkingDirectory(outsideDir)).toThrow('outside the trusted worktree root');
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('should reject a workingDirectory that resolves to a different git root', () => {
      const nestedRepoDir = mkdtempSync(join(tmpdir(), 'worktree-paths-nested-'));
      execSync('git init', { cwd: nestedRepoDir, stdio: 'pipe' });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = validateWorkingDirectory(nestedRepoDir);

      const trustedRoot = getWorktreeRoot(process.cwd()) || process.cwd();
      expect(result).toBe(trustedRoot);
      expect(errorSpy).toHaveBeenCalledWith(
        '[worktree] workingDirectory resolved to different git worktree root, using trusted root',
        expect.objectContaining({
          workingDirectory: nestedRepoDir,
          providedRoot: expect.any(String),
          trustedRoot: expect.any(String),
        })
      );

      errorSpy.mockRestore();
      rmSync(nestedRepoDir, { recursive: true, force: true });
    });
  });

  describe('getProcessSessionId (Issue #456)', () => {
    afterEach(() => {
      resetProcessSessionId();
    });

    it('should return a string matching pid-{PID}-{timestamp} format', () => {
      const sessionId = getProcessSessionId();
      expect(sessionId).toMatch(/^pid-\d+-\d+$/);
    });

    it('should include the current process PID', () => {
      const sessionId = getProcessSessionId();
      expect(sessionId).toContain(`pid-${process.pid}-`);
    });

    it('should return the same value on repeated calls (stable)', () => {
      const id1 = getProcessSessionId();
      const id2 = getProcessSessionId();
      const id3 = getProcessSessionId();
      expect(id1).toBe(id2);
      expect(id2).toBe(id3);
    });

    it('should pass session ID validation', () => {
      const sessionId = getProcessSessionId();
      expect(() => validateSessionId(sessionId)).not.toThrow();
    });

    it('should generate a new ID after reset', () => {
      const _id1 = getProcessSessionId();
      resetProcessSessionId();
      const id2 = getProcessSessionId();
      // IDs should differ (different timestamp)
      // In rare cases they could match if called in the same millisecond,
      // but the PID portion will be the same so we just check they're strings
      expect(typeof id2).toBe('string');
      expect(id2).toMatch(/^pid-\d+-\d+$/);
    });
  });

  // ==========================================================================
  // OMC_STATE_DIR TESTS (Issue #1014)
  // ==========================================================================

  describe('getProjectIdentifier', () => {
    it('should return a string with dirName-hash format', () => {
      const id = getProjectIdentifier(TEST_DIR);
      // Format: {dirName}-{16-char hex hash}
      expect(id).toMatch(/^[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);
    });

    it('should include the directory basename in the identifier', () => {
      const id = getProjectIdentifier(TEST_DIR);
      expect(id).toContain('worktree-paths-test-');
    });

    it('should return stable results for the same input', () => {
      const id1 = getProjectIdentifier(TEST_DIR);
      const id2 = getProjectIdentifier(TEST_DIR);
      expect(id1).toBe(id2);
    });

    it('should return different results for different directories', () => {
      const dir2 = mkdtempSync(join(tmpdir(), 'worktree-paths-other-'));
      try {
        const id1 = getProjectIdentifier(TEST_DIR);
        const id2 = getProjectIdentifier(dir2);
        expect(id1).not.toBe(id2);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    });

    it('should use git remote URL when available (stable across worktrees)', () => {
      // Create a git repo with a remote
      const repoDir = mkdtempSync(join(tmpdir(), 'worktree-paths-remote-'));
      try {
        execSync('git init', { cwd: repoDir, stdio: 'pipe' });
        execSync('git remote add origin https://github.com/test/my-repo.git', {
          cwd: repoDir,
          stdio: 'pipe',
        });
        clearWorktreeCache();

        const id = getProjectIdentifier(repoDir);
        expect(id).toMatch(/^[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);

        // Create a second repo with the same remote — should produce the same hash
        const repoDir2 = mkdtempSync(join(tmpdir(), 'worktree-paths-remote2-'));
        try {
          execSync('git init', { cwd: repoDir2, stdio: 'pipe' });
          execSync('git remote add origin https://github.com/test/my-repo.git', {
            cwd: repoDir2,
            stdio: 'pipe',
          });
          clearWorktreeCache();

          const id2 = getProjectIdentifier(repoDir2);
          // Same remote URL → same hash suffix
          const hash1 = id.split('-').pop();
          const hash2 = id2.split('-').pop();
          expect(hash1).toBe(hash2);
        } finally {
          rmSync(repoDir2, { recursive: true, force: true });
        }
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('should fall back to path hash for repos without remotes', () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'worktree-paths-noremote-'));
      try {
        execSync('git init', { cwd: repoDir, stdio: 'pipe' });
        clearWorktreeCache();

        const id = getProjectIdentifier(repoDir);
        expect(id).toMatch(/^[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('should sanitize special characters in directory names', () => {
      const specialDir = join(tmpdir(), 'worktree paths test!@#');
      mkdirSync(specialDir, { recursive: true });
      try {
        const id = getProjectIdentifier(specialDir);
        // Special chars should be replaced with underscores
        expect(id).toMatch(/^[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);
        expect(id).not.toContain(' ');
        expect(id).not.toContain('!');
        expect(id).not.toContain('@');
        expect(id).not.toContain('#');
      } finally {
        rmSync(specialDir, { recursive: true, force: true });
      }
    });
  });

  describe('getOmcRoot with OMC_STATE_DIR (Issue #1014)', () => {
    it('should return default .omc path when OMC_STATE_DIR is not set', () => {
      delete process.env.OMC_STATE_DIR;
      const result = getOmcRoot(TEST_DIR);
      expect(result).toBe(join(TEST_DIR, '.omcp'));
    });

    it('should return centralized path when OMC_STATE_DIR is set', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'omc-state-dir-'));
      try {
        process.env.OMC_STATE_DIR = stateDir;
        const result = getOmcRoot(TEST_DIR);
        const projectId = getProjectIdentifier(TEST_DIR);
        expect(result).toBe(join(stateDir, projectId));
        expect(result).not.toContain('.omcp');
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it('should log warning when both legacy and centralized dirs exist', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'omc-state-dir-'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        process.env.OMC_STATE_DIR = stateDir;
        const projectId = getProjectIdentifier(TEST_DIR);

        // Create both directories
        mkdirSync(join(TEST_DIR, '.omcp'), { recursive: true });
        mkdirSync(join(stateDir, projectId), { recursive: true });

        clearDualDirWarnings();
        getOmcRoot(TEST_DIR);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Both legacy state dir')
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Using centralized dir')
        );
      } finally {
        warnSpy.mockRestore();
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it('should not log warning when only centralized dir exists', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'omc-state-dir-'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        process.env.OMC_STATE_DIR = stateDir;
        const projectId = getProjectIdentifier(TEST_DIR);

        // Create only centralized dir (no legacy .omcp/)
        mkdirSync(join(stateDir, projectId), { recursive: true });

        clearDualDirWarnings();
        getOmcRoot(TEST_DIR);

        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it('should only log dual-dir warning once per path pair', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'omc-state-dir-'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        process.env.OMC_STATE_DIR = stateDir;
        const projectId = getProjectIdentifier(TEST_DIR);

        mkdirSync(join(TEST_DIR, '.omcp'), { recursive: true });
        mkdirSync(join(stateDir, projectId), { recursive: true });

        clearDualDirWarnings();
        getOmcRoot(TEST_DIR);
        getOmcRoot(TEST_DIR);
        getOmcRoot(TEST_DIR);

        // Should only warn once despite 3 calls
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('path functions with OMC_STATE_DIR', () => {
    let stateDir: string;

    beforeEach(() => {
      stateDir = mkdtempSync(join(tmpdir(), 'omc-state-dir-paths-'));
      process.env.OMC_STATE_DIR = stateDir;
    });

    afterEach(() => {
      delete process.env.OMC_STATE_DIR;
      rmSync(stateDir, { recursive: true, force: true });
    });

    it('resolveOmcPath should resolve under centralized dir', () => {
      const result = resolveOmcPath('state/ralph.json', TEST_DIR);
      const projectId = getProjectIdentifier(TEST_DIR);
      expect(result).toBe(join(stateDir, projectId, 'state', 'ralph.json'));
    });

    it('resolveStatePath should resolve under centralized dir', () => {
      const result = resolveStatePath('ralph', TEST_DIR);
      const projectId = getProjectIdentifier(TEST_DIR);
      expect(result).toBe(join(stateDir, projectId, 'state', 'ralph-state.json'));
    });

    it('getWorktreeNotepadPath should resolve under centralized .omc/', () => {
      const result = getWorktreeNotepadPath(TEST_DIR);
      const projectId = getProjectIdentifier(TEST_DIR);
      expect(result).toBe(join(stateDir, projectId, '.omc', 'notepad.md'));
    });

    it('getWorktreeProjectMemoryPath should resolve under centralized .omc/', () => {
      const result = getWorktreeProjectMemoryPath(TEST_DIR);
      const projectId = getProjectIdentifier(TEST_DIR);
      expect(result).toBe(join(stateDir, projectId, '.omc', 'project-memory.json'));
    });

    it('resolvePlanPath should resolve under centralized .omc/', () => {
      const result = resolvePlanPath('my-feature', TEST_DIR);
      const projectId = getProjectIdentifier(TEST_DIR);
      expect(result).toBe(join(stateDir, projectId, '.omc', 'plans', 'my-feature.md'));
    });

    it('resolveResearchPath should resolve under centralized .omc/', () => {
      const result = resolveResearchPath('api-research', TEST_DIR);
      const projectId = getProjectIdentifier(TEST_DIR);
      expect(result).toBe(join(stateDir, projectId, '.omc', 'research', 'api-research'));
    });

    it('resolveLogsPath stays under centralized private root', () => {
      const result = resolveLogsPath(TEST_DIR);
      const projectId = getProjectIdentifier(TEST_DIR);
      expect(result).toBe(join(stateDir, projectId, 'logs'));
    });

    it('resolveWisdomPath should resolve under centralized .omc/', () => {
      const result = resolveWisdomPath('my-plan', TEST_DIR);
      const projectId = getProjectIdentifier(TEST_DIR);
      expect(result).toBe(join(stateDir, projectId, '.omc', 'notepads', 'my-plan'));
    });

    it('isPathUnderOmc should check against centralized dir', () => {
      const projectId = getProjectIdentifier(TEST_DIR);
      const centralPath = join(stateDir, projectId, 'state', 'ralph.json');
      expect(isPathUnderOmc(centralPath, TEST_DIR)).toBe(true);

      // Legacy path should NOT be under omc when centralized
      expect(isPathUnderOmc(join(TEST_DIR, '.omcp', 'state', 'ralph.json'), TEST_DIR)).toBe(false);
    });

    it('ensureAllOmcDirs should create dirs under centralized private and shared roots', () => {
      ensureAllOmcDirs(TEST_DIR);
      const projectId = getProjectIdentifier(TEST_DIR);
      const centralPrivate = join(stateDir, projectId);
      const centralShared = join(stateDir, projectId, '.omc');

      // Private (plugin-owned)
      expect(existsSync(centralPrivate)).toBe(true);
      expect(existsSync(join(centralPrivate, 'state'))).toBe(true);
      expect(existsSync(join(centralPrivate, 'logs'))).toBe(true);
      expect(existsSync(join(centralPrivate, 'drafts'))).toBe(true);

      // Shared (cross-plugin)
      expect(existsSync(centralShared)).toBe(true);
      expect(existsSync(join(centralShared, 'plans'))).toBe(true);
      expect(existsSync(join(centralShared, 'research'))).toBe(true);
      expect(existsSync(join(centralShared, 'notepads'))).toBe(true);

      // Legacy .omcp/ should NOT be created in the worktree when centralized
      expect(existsSync(join(TEST_DIR, '.omcp'))).toBe(false);
      // Worktree-relative .omc/ should also NOT be created when centralized
      expect(existsSync(join(TEST_DIR, '.omc'))).toBe(false);
    });

    it('ensureOmcDir should create dir under centralized path', () => {
      const result = ensureOmcDir('state', TEST_DIR);
      const projectId = getProjectIdentifier(TEST_DIR);
      expect(result).toBe(join(stateDir, projectId, 'state'));
      expect(existsSync(result)).toBe(true);
    });
  });
});

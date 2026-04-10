#!/usr/bin/env node

/**
 * OMC Session Start Hook (Node.js)
 * Restores persistent mode states when session starts
 * Cross-platform: Windows, macOS, Linux
 */

import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getCopilotConfigDir } from './lib/config-dir.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Copilot config directory (respects COPILOT_CONFIG_DIR env var) */
const configDir = getCopilotConfigDir();

// Import timeout-protected stdin reader (prevents hangs on Linux/Windows, see issue #240, #524)
let readStdin;
try {
  const mod = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
  readStdin = mod.readStdin;
} catch {
  // Fallback: inline timeout-protected readStdin if lib module is missing
  readStdin = (timeoutMs = 5000) => new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; process.stdin.removeAllListeners(); process.stdin.destroy(); resolve(Buffer.concat(chunks).toString('utf-8')); }
    }, timeoutMs);
    process.stdin.on('data', (chunk) => { chunks.push(chunk); });
    process.stdin.on('end', () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf-8')); } });
    process.stdin.on('error', () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(''); } });
    if (process.stdin.readableEnded) { if (!settled) { settled = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf-8')); } }
  });
}

// Read JSON file safely
function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function getRuntimeBaseDir() {
  return process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..');
}

async function loadProjectMemoryModules() {
  try {
    const runtimeBase = getRuntimeBaseDir();
    const [
      projectMemoryStorage,
      projectMemoryDetector,
      projectMemoryFormatter,
      rulesFinder,
    ] = await Promise.all([
      import(pathToFileURL(join(runtimeBase, 'dist', 'hooks', 'project-memory', 'storage.js')).href),
      import(pathToFileURL(join(runtimeBase, 'dist', 'hooks', 'project-memory', 'detector.js')).href),
      import(pathToFileURL(join(runtimeBase, 'dist', 'hooks', 'project-memory', 'formatter.js')).href),
      import(pathToFileURL(join(runtimeBase, 'dist', 'hooks', 'rules-injector', 'finder.js')).href),
    ]);

    return {
      loadProjectMemory: projectMemoryStorage.loadProjectMemory,
      saveProjectMemory: projectMemoryStorage.saveProjectMemory,
      shouldRescan: projectMemoryStorage.shouldRescan,
      detectProjectEnvironment: projectMemoryDetector.detectProjectEnvironment,
      formatContextSummary: projectMemoryFormatter.formatContextSummary,
      findProjectRoot: rulesFinder.findProjectRoot,
    };
  } catch {
    return null;
  }
}

function hasProjectMemoryContent(memory) {
  return Boolean(
    memory &&
    (
      memory.userDirectives?.length ||
      memory.customNotes?.length ||
      memory.hotPaths?.length ||
      memory.techStack?.languages?.length ||
      memory.techStack?.frameworks?.length ||
      memory.build?.buildCommand ||
      memory.build?.testCommand
    )
  );
}

async function resolveProjectMemorySummary(directory, projectMemoryModules) {
  const {
    detectProjectEnvironment,
    findProjectRoot,
    formatContextSummary,
    loadProjectMemory,
    saveProjectMemory,
    shouldRescan,
  } = projectMemoryModules;

  const projectRoot = findProjectRoot?.(directory);
  if (!projectRoot) {
    return '';
  }

  let memory = await loadProjectMemory?.(projectRoot);

  if ((!memory || shouldRescan?.(memory)) && detectProjectEnvironment && saveProjectMemory) {
    const existing = memory;
    memory = await detectProjectEnvironment(projectRoot);

    if (existing) {
      memory.customNotes = existing.customNotes;
      memory.userDirectives = existing.userDirectives;
    }

    await saveProjectMemory(projectRoot, memory);
  }

  if (!hasProjectMemoryContent(memory)) {
    return '';
  }

  return formatContextSummary(memory)?.trim() || '';
}

// Semantic version comparison (for cache cleanup sorting)
function semverCompare(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

// Extract OMC version from copilot-instructions.md content
function extractOmcVersion(content) {
  const match = content.match(/<!-- OMC:VERSION:(\d+\.\d+\.\d+[^\s]*?) -->/);
  return match ? match[1] : null;
}

// Resolve plugin root: Copilot CLI sets PLUGIN_ROOT; legacy Claude CLI sets CLAUDE_PLUGIN_ROOT.
// Fallback: __dirname is scripts/, parent is the plugin install root.
const _resolvedPluginRoot = process.env.PLUGIN_ROOT
  || process.env.CLAUDE_PLUGIN_ROOT
  || dirname(__dirname);

// Get plugin version from plugin root
function getPluginVersion() {
  try {
    const pluginRoot = _resolvedPluginRoot;
    if (!pluginRoot) return null;
    const pkg = readJsonFile(join(pluginRoot, 'package.json'));
    return pkg?.version || null;
  } catch { return null; }
}

// Get npm global package version
function getNpmVersion() {
  try {
    const versionFile = join(configDir, '.omcp-version.json');
    const data = readJsonFile(versionFile);
    return data?.version || null;
  } catch { return null; }
}

// Get copilot-instructions.md version
function getClaudeMdVersion() {
  try {
    const claudeMdPath = join(configDir, 'copilot-instructions.md');
    if (!existsSync(claudeMdPath)) return null;  // File doesn't exist
    const content = readFileSync(claudeMdPath, 'utf-8');
    const version = extractOmcVersion(content);
    return version || 'unknown';  // File exists but no marker = 'unknown'
  } catch { return null; }
}

// Detect version drift between components
function detectVersionDrift() {
  const pluginVersion = getPluginVersion();
  const npmVersion = getNpmVersion();
  const claudeMdVersion = getClaudeMdVersion();

  // Need at least plugin version to detect drift
  if (!pluginVersion) return null;

  const drift = [];

  if (npmVersion && npmVersion !== pluginVersion) {
    drift.push({ component: 'npm package (omp CLI)', current: npmVersion, expected: pluginVersion });
  }

  if (claudeMdVersion === 'unknown') {
    drift.push({
      component: 'copilot-instructions.md instructions',
      current: 'unknown (needs migration)',
      expected: pluginVersion
    });
  } else if (claudeMdVersion && claudeMdVersion !== pluginVersion) {
    drift.push({
      component: 'copilot-instructions.md instructions',
      current: claudeMdVersion,
      expected: pluginVersion
    });
  }

  if (drift.length === 0) return null;

  return { pluginVersion, npmVersion, claudeMdVersion, drift };
}

// Check if we should notify (once per unique drift combination)
function shouldNotifyDrift(driftInfo) {
  const stateFile = join(configDir, '.omcp', 'update-state.json');
  const driftKey = `plugin:${driftInfo.pluginVersion}-npm:${driftInfo.npmVersion}-copilot:${driftInfo.claudeMdVersion}`;

  try {
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      if (state.lastNotifiedDrift === driftKey) return false;
    }
  } catch {}

  // Save new drift state
  try {
    const dir = join(configDir, '.omcp');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
      lastNotifiedDrift: driftKey,
      lastNotifiedAt: new Date().toISOString()
    }));
  } catch {}

  return true;
}

// Check npm registry for available update (with 24h cache)
async function checkNpmUpdate(currentVersion) {
  const cacheFile = join(configDir, '.omcp', 'update-check.json');
  const CACHE_DURATION = 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Check cache
  try {
    if (existsSync(cacheFile)) {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'));
      if (cached.timestamp && (now - cached.timestamp) < CACHE_DURATION) {
        return (cached.updateAvailable && semverCompare(cached.latestVersion, currentVersion) > 0)
          ? { currentVersion, latestVersion: cached.latestVersion }
          : null;
      }
    }
  } catch {}

  // Fetch from npm registry with 2s timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch('https://registry.npmjs.org/oh-my-copilot/latest', {
      signal: controller.signal
    });
    if (!response.ok) return null;

    const data = await response.json();
    const latestVersion = data.version;
    const updateAvailable = semverCompare(latestVersion, currentVersion) > 0;

    // Update cache
    try {
      const dir = join(configDir, '.omcp');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ timestamp: now, latestVersion, currentVersion, updateAvailable }));
    } catch {}

    return updateAvailable ? { currentVersion, latestVersion } : null;
  } catch { return null; } finally { clearTimeout(timeoutId); }
}

// Check if HUD is properly installed (with retry for race conditions)
async function checkHudInstallation(retryCount = 0) {
  const hudDir = join(configDir, 'hud');
  // Support current and legacy script names
  const hudScriptOmc = join(hudDir, 'omcp-hud.mjs');
  const hudScriptLegacy = join(hudDir, 'omcp-hud.js');
  const settingsFile = join(configDir, 'settings.json');

  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 100;

  // Check if HUD script exists (either naming convention)
  const hudScriptExists = existsSync(hudScriptOmc) || existsSync(hudScriptLegacy);
  if (!hudScriptExists) {
    return { installed: false, reason: 'HUD script missing' };
  }

  // Check if statusLine is configured (with retry for race conditions)
  try {
    if (existsSync(settingsFile)) {
      const content = readFileSync(settingsFile, 'utf-8');
      // Handle empty or whitespace-only content (race condition during write)
      if (!content || !content.trim()) {
        if (retryCount < MAX_RETRIES) {
          // Sleep and retry (non-blocking)
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
          return checkHudInstallation(retryCount + 1);
        }
        return { installed: false, reason: 'settings.json empty (possible race condition)' };
      }
      const settings = JSON.parse(content);
      if (!settings.statusLine) {
        // Retry once if statusLine not found (could be mid-write)
        if (retryCount < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
          return checkHudInstallation(retryCount + 1);
        }
        return { installed: false, reason: 'statusLine not configured' };
      }

      const statusLineCommand = typeof settings.statusLine === 'string'
        ? settings.statusLine
        : (typeof settings.statusLine === 'object' && settings.statusLine && typeof settings.statusLine.command === 'string'
          ? settings.statusLine.command
          : null);

      // If OMC HUD wrapper is configured, ensure at least one plugin cache version is built.
      if (statusLineCommand?.includes('omcp-hud')) {
        const pluginCacheBase = join(configDir, 'plugins', 'cache', 'omg', 'oh-my-copilot');
        if (existsSync(pluginCacheBase)) {
          const versions = readdirSync(pluginCacheBase)
            .filter(version => !version.startsWith('.'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .reverse();
          if (versions.length > 0) {
            const hasBuiltHud = versions.some(version =>
              existsSync(join(pluginCacheBase, version, 'dist', 'hud', 'index.js'))
            );
            if (!hasBuiltHud) {
              const latestVersionDir = join(pluginCacheBase, versions[0]);
              return {
                installed: false,
                reason: `HUD plugin cache is not built. Run: cd "${latestVersionDir}" && npm install && npm run build`,
              };
            }
          }
        }
      }
    } else {
      return { installed: false, reason: 'settings.json missing' };
    }
  } catch (err) {
    // JSON parse error - could be mid-write, retry
    if (retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      return checkHudInstallation(retryCount + 1);
    }
    console.error('HUD check error:', err.message);
    return { installed: false, reason: 'Could not read settings' };
  }

  return { installed: true };
}

// Detect Azure DevOps platform from git remote URL
async function detectAdoPlatform(directory) {
  try {
    const { execSync } = await import('child_process');
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: directory,
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).toString().trim();
    if (remoteUrl.includes('dev.azure.com') || remoteUrl.includes('visualstudio.com')) {
      return remoteUrl;
    }
  } catch {
    // Not a git repo or no remote configured — skip silently
  }
  return null;
}

// Read ADO config from .omcp/config.json
function readAdoConfig(directory) {
  try {
    const configPath = join(directory, '.omcp', 'config.json');
    const config = readJsonFile(configPath);
    return config?.ado || null;
  } catch {
    return null;
  }
}

// Main
async function main() {
  try {
    const input = await readStdin();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';
    const projectMemoryModules = await loadProjectMemoryModules();
    const messages = [];

    // Check for version drift between components
    const driftInfo = detectVersionDrift();
    if (driftInfo && shouldNotifyDrift(driftInfo)) {
      let driftMsg = `[OMC VERSION DRIFT DETECTED]\n\nPlugin version: ${driftInfo.pluginVersion}\n`;
      for (const d of driftInfo.drift) {
        driftMsg += `${d.component}: ${d.current} (expected ${d.expected})\n`;
      }
      driftMsg += `\nRun 'omc update' to sync all components.`;

      messages.push(`<session-restore>\n\n${driftMsg}\n\n</session-restore>\n\n---\n`);
    }

    // Check npm registry for available update (with 24h cache)
    try {
      const pluginVersion = getPluginVersion();
      if (pluginVersion) {
        const updateInfo = await checkNpmUpdate(pluginVersion);
        if (updateInfo) {
          messages.push(`<session-restore>\n\n[OMC UPDATE AVAILABLE]\n\nA new version of oh-my-copilot is available: v${updateInfo.latestVersion} (current: v${updateInfo.currentVersion})\n\nTo update, run: omc update\n(This syncs plugin, npm package, and copilot-instructions.md together)\n\n</session-restore>\n\n---\n`);
        }
      }
    } catch {}

    // Warn if silentAutoUpdate is enabled but running in plugin mode (#1773)
    if (process.env.CLAUDE_PLUGIN_ROOT) {
      try {
        const omcConfigPath = join(configDir, '.omc-config.json');
        const omcConfig = readJsonFile(omcConfigPath);
        if (omcConfig?.silentAutoUpdate) {
          messages.push(`<session-restore>\n\n[OMC] silentAutoUpdate is enabled in .omc-config.json but has no effect in plugin mode.\nTo update, use: /plugin marketplace update omc && /omc-setup\nOr run manually: omc update\n\n</session-restore>\n\n---\n`);
        }
      } catch {}
    }

    // Check HUD installation (one-time setup guidance)
    const hudCheck = await checkHudInstallation();
    if (!hudCheck.installed) {
      messages.push(`<system-reminder>
[OMC] HUD not configured (${hudCheck.reason}). Run /hud setup then restart Copilot CLI.
</system-reminder>`);
    }

    // Check for ultrawork state - only restore if session matches (issue #311)
    // Session-scoped ONLY when session_id exists — no legacy fallback
    let ultraworkState = null;
    if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
      // Session-scoped ONLY — no legacy fallback
      ultraworkState = readJsonFile(join(directory, '.omcp', 'state', 'sessions', sessionId, 'ultrawork-state.json'));
      // Validate session identity
      if (ultraworkState && ultraworkState.session_id && ultraworkState.session_id !== sessionId) {
        ultraworkState = null;
      }
    } else {
      // No session_id — legacy behavior for backward compat
      ultraworkState = readJsonFile(join(directory, '.omcp', 'state', 'ultrawork-state.json'));
    }

    if (ultraworkState?.active) {
      messages.push(`<session-restore>

[ULTRAWORK MODE RESTORED]

You have an active ultrawork session from ${ultraworkState.started_at}.
Original task: ${ultraworkState.original_prompt}

Treat this as prior-session context only. Prioritize the user's newest request, and resume ultrawork only if the user explicitly asks to continue it.

</session-restore>

---
`);
    }

    // Check for ralph loop state
    // Session-scoped ONLY when session_id exists — no legacy fallback
    let ralphState = null;
    if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
      // Session-scoped ONLY — no legacy fallback
      ralphState = readJsonFile(join(directory, '.omcp', 'state', 'sessions', sessionId, 'ralph-state.json'));
      // Validate session identity
      if (ralphState && ralphState.session_id && ralphState.session_id !== sessionId) {
        ralphState = null;
      }
    } else {
      // No session_id — legacy behavior for backward compat
      ralphState = readJsonFile(join(directory, '.omcp', 'state', 'ralph-state.json'));
      if (!ralphState) {
        ralphState = readJsonFile(join(directory, '.omcp', 'ralph-state.json'));
      }
    }
    if (ralphState?.active) {
      messages.push(`<session-restore>

[RALPH LOOP RESTORED]

You have an active ralph-loop session.
Original task: ${ralphState.prompt || 'Task in progress'}
Iteration: ${ralphState.iteration || 1}/${ralphState.max_iterations || 10}

Treat this as prior-session context only. Prioritize the user's newest request, and resume the ralph loop only if the user explicitly asks to continue it.

</session-restore>

---
`);
    }

    // Check for incomplete todos (project-local only, not global
    // [$COPILOT_CONFIG_DIR|~/.copilot]/todos/)
    // NOTE: We intentionally do NOT scan the global
    // [$COPILOT_CONFIG_DIR|~/.copilot]/todos/ directory.
    // That directory accumulates todo files from ALL past sessions across all
    // projects, causing phantom task counts in fresh sessions (see issue #354).
    const localTodoPaths = [
      join(directory, '.omcp', 'todos.json'),
      join(directory, '.copilot', 'todos.json')
    ];
    let incompleteCount = 0;
    for (const todoFile of localTodoPaths) {
      if (existsSync(todoFile)) {
        try {
          const data = readJsonFile(todoFile);
          const todos = data?.todos || (Array.isArray(data) ? data : []);
          incompleteCount += todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length;
        } catch {}
      }
    }

    if (incompleteCount > 0) {
      messages.push(`<session-restore>

[PENDING TASKS DETECTED]

You have ${incompleteCount} incomplete tasks from a previous session.
Treat this as prior-session context only. Prioritize the user's newest request, and resume these tasks only if the user explicitly asks to continue them.

</session-restore>

---
`);
    }

    if (projectMemoryModules) {
      try {
        const summary = await resolveProjectMemorySummary(directory, projectMemoryModules);
        if (summary) {
          messages.push(`<project-memory-context>

[PROJECT MEMORY]

${summary}

</project-memory-context>

---
`);
        }
      } catch {
        // Project memory is additive only; never break session start.
      }
    }

    // Check for notepad Priority Context
    const notepadPath = join(directory, '.omcp', 'notepad.md');
    if (existsSync(notepadPath)) {
      try {
        const notepadContent = readFileSync(notepadPath, 'utf-8');
        const priorityMatch = notepadContent.match(/## Priority Context\n([\s\S]*?)(?=## |$)/);
        if (priorityMatch && priorityMatch[1].trim()) {
          const priorityContext = priorityMatch[1].trim();
          // Only inject if there's actual content (not just the placeholder comment)
          const cleanContent = priorityContext.replace(/<!--[\s\S]*?-->/g, '').trim();
          if (cleanContent) {
            messages.push(`<notepad-context>
[NOTEPAD - Priority Context]
${cleanContent}
</notepad-context>`);
          }
        }
      } catch (err) {
        // Silently ignore notepad read errors
      }
    }

    // Detect Azure DevOps platform and inject context
    const adoRemoteUrl = await detectAdoPlatform(directory);
    if (adoRemoteUrl) {
      const adoConfig = readAdoConfig(directory);
      let adoMsg = `[AZURE DEVOPS DETECTED]\n\nPlatform: Azure DevOps\nRemote: ${adoRemoteUrl}\n\nAvailable MCP Tools: \`mcp__azure-devops__*\`\n- Work Items: wit_get_work_item, wit_create_work_item, wit_update_work_item, wit_my_work_items, wit_list_backlog_work_items, wit_get_work_items_for_iteration, wit_get_work_items_batch_by_ids, wit_add_child_work_items, wit_link_work_item_to_pull_request, wit_work_items_link, wit_work_item_unlink, wit_add_artifact_link, wit_add_work_item_comment, wit_list_work_item_comments, wit_list_work_item_revisions, wit_update_work_items_batch\n- Queries: wit_get_query, wit_get_query_results_by_id, search_workitem\n- Repos: repo_list_repos_by_project, repo_get_repo_by_name_or_id, repo_list_pull_requests_by_repo_or_project, repo_list_pull_requests_by_commits, repo_create_pull_request, repo_get_pull_request_by_id, repo_update_pull_request, repo_update_pull_request_reviewers, repo_search_commits\n- PR Threads: repo_create_pull_request_thread, repo_list_pull_request_threads, repo_list_pull_request_thread_comments, repo_reply_to_comment, repo_update_pull_request_thread\n- Branches: repo_create_branch, repo_get_branch_by_name, repo_list_branches_by_repo, repo_list_my_branches_by_repo\n- Pipelines: pipelines_get_builds, pipelines_get_build_status, pipelines_get_build_log, pipelines_get_build_log_by_id, pipelines_get_build_changes, pipelines_get_build_definitions, pipelines_get_build_definition_revisions, pipelines_run_pipeline, pipelines_create_pipeline, pipelines_list_runs, pipelines_get_run, pipelines_update_build_stage\n- Test Plans: testplan_list_test_plans, testplan_list_test_suites, testplan_list_test_cases, testplan_create_test_plan, testplan_create_test_suite, testplan_create_test_case, testplan_add_test_cases_to_suite, testplan_update_test_case_steps, testplan_show_test_results_from_build_id\n- Wiki: wiki_list_wikis, wiki_get_wiki, wiki_list_pages, wiki_get_page, wiki_get_page_content, wiki_create_or_update_page, search_wiki\n- Search: search_code, search_workitem, search_wiki\n- Security: advsec_get_alerts, advsec_get_alert_details\n- Iterations: work_list_iterations, work_list_team_iterations, work_create_iterations, work_assign_iterations, work_get_iteration_capacities, work_get_team_capacity, work_update_team_capacity\n- Organization: core_list_projects, core_list_project_teams, core_get_identity_ids\n\nConfig file: \`.omcp/config.json\` (org, project, workItemType, areaPath, iterationPath)\n\nRecommended plugins:\n- azure-devops-mcp: MCP server for ADO tools (https://github.com/microsoft/azure-devops-mcp)\n- azure-skills: Plugin for Azure cloud operations (https://github.com/microsoft/azure-skills)`;
      if (adoConfig) {
        adoMsg += `\n\nADO Config:\n${JSON.stringify(adoConfig, null, 2)}`;
      }
      messages.push(`<system-reminder>\n${adoMsg}\n</system-reminder>`);
    }

    // Cleanup old plugin cache versions (keep latest 2, symlink the rest)
    // Instead of deleting old versions, replace them with symlinks to the latest.
    // This prevents "Cannot find module" errors for sessions started before a
    // plugin update whose CLAUDE_PLUGIN_ROOT still points to the old version.
    try {
      const cacheBase = join(configDir, 'plugins', 'cache', 'omg', 'oh-my-copilot');
      if (existsSync(cacheBase)) {
        const versions = readdirSync(cacheBase)
          .filter(v => /^\d+\.\d+\.\d+/.test(v))
          .sort(semverCompare)
          .reverse();

        if (versions.length > 2) {
          const latest = versions[0];
          const toSymlink = versions.slice(2);
          for (const version of toSymlink) {
            try {
              const versionPath = join(cacheBase, version);
              const stat = lstatSync(versionPath);

              const isWin = process.platform === 'win32';
              const symlinkTarget = isWin ? join(cacheBase, latest) : latest;

              if (stat.isSymbolicLink()) {
                // Already a symlink — update only if pointing to wrong target.
                // Use atomic temp-symlink + rename to avoid a window where
                // the path doesn't exist (fixes race in issue #1007).
                const target = readlinkSync(versionPath);
                if (target === latest || target === join(cacheBase, latest)) continue;
                try {
                  const tmpLink = versionPath + '.tmp.' + process.pid;
                  symlinkSync(symlinkTarget, tmpLink, isWin ? 'junction' : undefined);
                  try {
                    renameSync(tmpLink, versionPath);
                  } catch {
                    // rename failed (e.g. cross-device) — fall back to unlink+symlink
                    try { unlinkSync(tmpLink); } catch {}
                    unlinkSync(versionPath);
                    symlinkSync(symlinkTarget, versionPath, isWin ? 'junction' : undefined);
                  }
                } catch (swapErr) {
                  if (swapErr?.code !== 'EEXIST') {
                    // Leave as-is rather than losing it
                  }
                }
              } else if (stat.isDirectory()) {
                // Directory → symlink: cannot be atomic, but run.cjs now
                // handles missing targets gracefully (issue #1007).
                rmSync(versionPath, { recursive: true, force: true });
                try {
                  symlinkSync(symlinkTarget, versionPath, isWin ? 'junction' : undefined);
                } catch (symlinkErr) {
                  // EEXIST: another session raced us — safe to ignore.
                  if (symlinkErr?.code !== 'EEXIST') {
                    // Symlink genuinely failed. Leave the path as-is.
                  }
                }
              }
            } catch {
              // lstatSync / rmSync / unlinkSync failure — leave old directory as-is.
            }
          }
        }
      }
    } catch {}

    // Send session-start notification (non-blocking, fire-and-forget)
    try {
      const pluginRoot = _resolvedPluginRoot;
      if (pluginRoot) {
        const { notify } = await import(pathToFileURL(join(pluginRoot, 'dist', 'notifications', 'index.js')).href);
        // Fire and forget - don't await, don't block session start
        notify('session-start', {
          sessionId,
          projectPath: directory,
          timestamp: new Date().toISOString(),
        }).catch(() => {}); // swallow errors silently

        // Start reply listener daemon if notification reply config is available
        try {
          const { startReplyListener, buildDaemonConfig } = await import(pathToFileURL(join(pluginRoot, 'dist', 'notifications', 'reply-listener.js')).href);
          const replyConfig = await buildDaemonConfig();
          if (replyConfig) {
            startReplyListener(replyConfig);
          }
        } catch {
          // Reply listener not available or not configured, skip silently
        }
      }
    } catch {
      // Notification module not available, skip silently
    }

    if (messages.length > 0) {
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'sessionStart',
          additionalContext: messages.join('\n')
        }
      }));
    } else {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    }
  } catch (error) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();

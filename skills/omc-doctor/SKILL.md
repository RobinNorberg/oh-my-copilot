---
name: omc-doctor
description: Diagnose and fix oh-my-copilot installation issues
level: 3
---

# Doctor Skill

Note: All `~/.copilot/...` paths in this guide respect `COPILOT_CONFIG_DIR` when that environment variable is set.

## Task: Run Installation Diagnostics

You are the OMC Doctor - diagnose and fix installation issues.

### Step 1: Check Plugin Version

```bash
# Get installed and latest versions (cross-platform)
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),d=process.env.COPILOT_CONFIG_DIR||p.join(h,'.copilot'),b=p.join(d,'plugins','cache','omg','oh-my-copilot');try{const v=f.readdirSync(b).filter(x=>/^\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));console.log('Installed:',v.length?v[v.length-1]:'(none)')}catch{console.log('Installed: (none)')}"
npm view oh-my-copilot version 2>/dev/null || echo "Latest: (unavailable)"
```

**Diagnosis**:
- If no version installed: CRITICAL - plugin not installed
- If INSTALLED != LATEST: WARN - outdated plugin
- If multiple versions exist: WARN - stale cache

### Step 2: Check for Legacy Hooks in settings.json

Read both `${COPILOT_CONFIG_DIR:-~/.copilot}/settings.json` (profile-level) and `./.copilot/settings.json` (project-level) and check if there's a `"hooks"` key with entries like:
- `bash ${COPILOT_CONFIG_DIR:-$HOME/.copilot}/hooks/keyword-detector.sh`
- `bash ${COPILOT_CONFIG_DIR:-$HOME/.copilot}/hooks/persistent-mode.sh`
- `bash ${COPILOT_CONFIG_DIR:-$HOME/.copilot}/hooks/session-start.sh`

**Diagnosis**:
- If found: CRITICAL - legacy hooks causing duplicates

### Step 3: Check for Legacy Bash Hook Scripts

```bash
ls -la "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/hooks/*.sh 2>/dev/null
```

**Diagnosis**:
- If `keyword-detector.sh`, `persistent-mode.sh`, `session-start.sh`, or `stop-continuation.sh` exist: WARN - legacy scripts (can cause confusion)

### Step 4: Check copilot-instructions.md

```bash
# Check if copilot-instructions.md exists
ls -la "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/copilot-instructions.md 2>/dev/null

# Check for OMC markers (<!-- OMG:START --> is the canonical marker)
grep -q "<!-- OMG:START -->" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/copilot-instructions.md" 2>/dev/null && echo "Has OMC config" || echo "Missing OMC config in copilot-instructions.md"

# Check copilot-instructions.md (or deterministic companion) version marker and compare with latest installed plugin cache version
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),d=process.env.COPILOT_CONFIG_DIR||p.join(h,'.copilot');const base=p.join(d,'copilot-instructions.md');let baseContent='';try{baseContent=f.readFileSync(base,'utf8')}catch{};let candidates=[base];let referenced='';const importMatch=baseContent.match(/copilot-[^ )]*\.md/);if(importMatch){referenced=p.join(d,importMatch[0]);candidates.push(referenced)}else{const defaultCompanion=p.join(d,'copilot-omc.md');if(f.existsSync(defaultCompanion))candidates.push(defaultCompanion);try{const others=f.readdirSync(d).filter(n=>/^copilot-.*\.md$/i.test(n)).sort().map(n=>p.join(d,n));for(const o of others){if(candidates.includes(o)===false)candidates.push(o)}}catch{}};let instrV='(missing)';let instrSource='(none)';for(const file of candidates){try{const c=f.readFileSync(file,'utf8');const m=c.match(/<!--\s*OMC:VERSION:([^\s]+)\s*-->/i);if(m){instrV=m[1];instrSource=file;break}}catch{}};if(instrV==='(missing)'&&candidates.length>0){instrV='(missing marker)';instrSource='scanned deterministic copilot-instructions sources';};let pluginV='(none)';try{const b=p.join(d,'plugins','cache','omg','oh-my-copilot');const v=f.readdirSync(b).filter(x=>/^\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));pluginV=v.length?v[v.length-1]:'(none)';}catch{};console.log('copilot-instructions.md OMC version:',instrV);console.log('OMC version source:',instrSource);console.log('Latest cached plugin version:',pluginV);if(instrV==='(missing)'||instrV==='(missing marker)'||pluginV==='(none)'){console.log('VERSION CHECK SKIPPED: missing OMC marker or plugin cache')}else if(instrV===pluginV){console.log('VERSION MATCH: copilot-instructions.md and plugin cache are aligned')}else{console.log('VERSION DRIFT: copilot-instructions.md and plugin versions differ')}"

# Check companion files for file-split pattern (e.g. copilot-omc.md)
find "${COPILOT_CONFIG_DIR:-$HOME/.copilot}" -maxdepth 1 -type f -name 'copilot-*.md' -print 2>/dev/null
while IFS= read -r f; do
  [ -f "$f" ] && grep -q "<!-- OMG:START -->" "$f" 2>/dev/null && echo "Has OMC config in companion: $f"
done < <(find "${COPILOT_CONFIG_DIR:-$HOME/.copilot}" -maxdepth 1 -type f -name 'copilot-*.md' 2>/dev/null)

# Check if copilot-instructions.md references a companion file
grep -o "copilot-[^ )]*\.md" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/copilot-instructions.md" 2>/dev/null
```

**Diagnosis**:
- If copilot-instructions.md missing: CRITICAL - copilot-instructions.md not configured
- If `<!-- OMG:START -->` found in copilot-instructions.md: OK
- If `<!-- OMG:START -->` found in a companion file (e.g. `copilot-omc.md`): OK - file-split pattern detected
- If no OMC markers in copilot-instructions.md or any companion file: WARN - outdated copilot-instructions.md
- If `OMC:VERSION` marker is missing from deterministic copilot-instructions source scan (base + referenced companion): WARN - cannot verify copilot-instructions.md freshness
- If `copilot-instructions.md OMC version` != `Latest cached plugin version`: WARN - version drift detected (run `omcp update` or `omcp setup`)

### Step 5: Check for Stale Plugin Cache

```bash
# Count versions in cache (cross-platform)
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),d=process.env.COPILOT_CONFIG_DIR||p.join(h,'.copilot'),b=p.join(d,'plugins','cache','omg','oh-my-copilot');try{const v=f.readdirSync(b).filter(x=>/^\d/.test(x));console.log(v.length+' version(s):',v.join(', '))}catch{console.log('0 versions')}"
```

**Diagnosis**:
- If > 1 version: WARN - multiple cached versions (cleanup recommended)

### Step 6: Check for Legacy Curl-Installed Content

Check for legacy agents, commands, and skills installed via curl (before plugin system).
**Important**: Only flag files whose names match actual plugin-provided names. Do NOT flag user's custom agents/commands/skills that are unrelated to OMC.

```bash
# Check for legacy agents directory
ls -la "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/agents/ 2>/dev/null

# Check for legacy commands directory
ls -la "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/commands/ 2>/dev/null

# Check for legacy skills directory
ls -la "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/skills/ 2>/dev/null
```

**Diagnosis**:
- If `~/.copilot/agents/` exists with files matching plugin agent names: WARN - legacy agents (now provided by plugin)
- If `~/.copilot/commands/` exists with files matching plugin command names: WARN - legacy commands (now provided by plugin)
- If `~/.copilot/skills/` exists with files matching plugin skill names: WARN - legacy skills (now provided by plugin)
- If custom files exist that do NOT match plugin names: OK - these are user custom content, do not flag them

**Known plugin agent names** (check agents/ for these):
`architect.md`, `document-specialist.md`, `explore.md`, `executor.md`, `debugger.md`, `planner.md`, `analyst.md`, `critic.md`, `verifier.md`, `test-engineer.md`, `designer.md`, `writer.md`, `qa-tester.md`, `scientist.md`, `security-reviewer.md`, `code-reviewer.md`, `git-master.md`, `code-simplifier.md`

**Known plugin skill names** (check skills/ for these):
`ai-slop-cleaner`, `ask`, `autopilot`, `cancel`, `cccg`, `configure-notifications`, `deep-interview`, `deepinit`, `external-context`, `hud`, `learner`, `mcp-setup`, `omc-doctor`, `omc-setup`, `omc-teams`, `plan`, `project-session-manager`, `ralph`, `ralplan`, `release`, `sciomc`, `setup`, `skill`, `team`, `ultraqa`, `ultrawork`, `visual-verdict`, `writer-memory`

**Known plugin command names** (check commands/ for these):
`ultrawork.md`, `deepsearch.md`

### Step 7: Check Permission Allowlist

Read `~/.copilot/settings.local.json` (respecting `COPILOT_CONFIG_DIR`) and verify `permissions.allow` contains the expected Tier 1+2 tools:

```bash
node -e "
const p=require('path'),f=require('fs'),h=require('os').homedir();
const d=process.env.COPILOT_CONFIG_DIR||p.join(h,'.copilot');
const fp=p.join(d,'settings.local.json');
if(!f.existsSync(fp)){console.log('settings.local.json not found');process.exit()}
try{
  const s=JSON.parse(f.readFileSync(fp,'utf-8'));
  const allow=s?.permissions?.allow;
  if(!Array.isArray(allow)){console.log('permissions.allow missing or not an array');process.exit()}
  const tier12=['lsp_hover','lsp_goto_definition','lsp_find_references','lsp_document_symbols',
    'lsp_workspace_symbols','lsp_diagnostics','lsp_diagnostics_directory','lsp_servers',
    'ast_grep_search','notepad_read','notepad_stats','state_read','state_list_active',
    'state_get_status','project_memory_read','notepad_write_priority','notepad_write_working',
    'notepad_write_manual','notepad_prune','state_write','state_clear','project_memory_write',
    'project_memory_add_note','project_memory_add_directive','ast_grep_replace',
    'lsp_prepare_rename','lsp_rename','lsp_code_actions','lsp_code_action_resolve','python_repl'];
  const missing=tier12.filter(t=>!allow.some(e=>e.includes(t)));
  if(missing.length===0){console.log('All Tier 1+2 tools present ('+allow.length+' entries)')}
  else{console.log('Missing tools: '+missing.join(', '))}
}catch(e){console.log('Parse error: '+e.message)}
"
```

**Diagnosis**:
- If `settings.local.json` not found: WARN - permissions not configured (run `/omc-setup`)
- If `permissions.allow` missing: WARN - allowlist not written (run `/omc-setup`)
- If tools missing: WARN - allowlist incomplete; `setup-maintenance` will auto-heal on next session start, or run `/omc-setup` to fix immediately

---

## Report Format

After running all checks, output a report:

```
## OMC Doctor Report

### Summary
[HEALTHY / ISSUES FOUND]

### Checks

| Check | Status | Details |
|-------|--------|---------|
| Plugin Version | OK/WARN/CRITICAL | ... |
| Legacy Hooks (settings.json) | OK/CRITICAL | ... |
| Legacy Scripts (~/.copilot/hooks/) | OK/WARN | ... |
| copilot-instructions.md | OK/WARN/CRITICAL | ... |
| Plugin Cache | OK/WARN | ... |
| Legacy Agents (~/.copilot/agents/) | OK/WARN | ... |
| Legacy Commands (~/.copilot/commands/) | OK/WARN | ... |
| Legacy Skills (~/.copilot/skills/) | OK/WARN | ... |
| Permission Allowlist (settings.local.json) | OK/WARN | ... |

### Issues Found
1. [Issue description]
2. [Issue description]

### Recommended Fixes
[List fixes based on issues]
```

---

## Auto-Fix (if user confirms)

If issues found, ask user: "Would you like me to fix these issues automatically?"

If yes, apply fixes:

### Fix: Legacy Hooks in settings.json
Remove the `"hooks"` section from `${COPILOT_CONFIG_DIR:-~/.copilot}/settings.json` (keep other settings intact)

### Fix: Legacy Bash Scripts
```bash
rm -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/hooks/keyword-detector.sh
rm -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/hooks/persistent-mode.sh
rm -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/hooks/session-start.sh
rm -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/hooks/stop-continuation.sh
```

### Fix: Outdated Plugin
```bash
# Clear plugin cache (cross-platform)
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.copilot'),b=p.join(d,'plugins','cache','omg','oh-my-copilot');try{f.rmSync(b,{recursive:true,force:true});console.log('Plugin cache cleared. Restart Copilot CLI to fetch latest version.')}catch{console.log('No plugin cache found')}"
```

### Fix: Stale Cache (multiple versions)
```bash
# Keep only latest version (cross-platform)
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),d=process.env.COPILOT_CONFIG_DIR||p.join(h,'.copilot'),b=p.join(d,'plugins','cache','omg','oh-my-copilot');try{const v=f.readdirSync(b).filter(x=>/^\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));v.slice(0,-1).forEach(x=>f.rmSync(p.join(b,x),{recursive:true,force:true}));console.log('Removed',v.length-1,'old version(s)')}catch(e){console.log('No cache to clean')}"
```

### Fix: Missing/Outdated copilot-instructions.md
Fetch latest from GitHub and write to `${COPILOT_CONFIG_DIR:-~/.copilot}/copilot-instructions.md`:
```
WebFetch(url: "https://raw.githubusercontent.com/RobinNorberg/oh-my-copilot/main/docs/copilot-instructions.md", prompt: "Return the complete raw markdown content exactly as-is")
```

### Fix: Legacy Curl-Installed Content

Remove legacy agents, commands, and skills directories (now provided by plugin):

```bash
# Backup first (optional - ask user)
# mv "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/agents "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/agents.bak
# mv "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/commands "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/commands.bak
# mv "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/skills "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/skills.bak

# Or remove directly
rm -rf "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/agents
rm -rf "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/commands
rm -rf "${COPILOT_CONFIG_DIR:-$HOME/.copilot}"/skills
```

**Note**: Only remove if these contain oh-my-copilot-related files. If user has custom agents/commands/skills, warn them and ask before removing.

---

## Post-Fix

After applying fixes, inform user:
> Fixes applied. **Restart Copilot CLI** for changes to take effect.

---
name: omc-doctor
description: Diagnose and fix oh-my-copilot installation issues
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

Read both `~/.copilot/settings.json` (profile-level) and `./.copilot/settings.json` (project-level) and check if there's a `"hooks"` key with entries like:
- `bash $HOME/.copilot/hooks/keyword-detector.sh`
- `bash $HOME/.copilot/hooks/persistent-mode.sh`
- `bash $HOME/.copilot/hooks/session-start.sh`

**Diagnosis**:
- If found: CRITICAL - legacy hooks causing duplicates

### Step 3: Check for Legacy Bash Hook Scripts

```bash
ls -la ~/.copilot/hooks/*.sh 2>/dev/null
```

**Diagnosis**:
- If `keyword-detector.sh`, `persistent-mode.sh`, `session-start.sh`, or `stop-continuation.sh` exist: WARN - legacy scripts (can cause confusion)

### Step 4: Check copilot-instructions.md

```bash
# Check if copilot-instructions.md exists
ls -la ~/.copilot/copilot-instructions.md 2>/dev/null

# Check for OMC markers (<!-- OMG:START --> is the canonical marker)
grep -q "<!-- OMG:START -->" ~/.copilot/copilot-instructions.md 2>/dev/null && echo "Has OMC config" || echo "Missing OMC config in copilot-instructions.md"

# Check companion files for file-split pattern (e.g. copilot-omg.md)
ls ~/.copilot/copilot-*.md 2>/dev/null
for f in ~/.copilot/copilot-*.md; do
  [ -f "$f" ] && grep -q "<!-- OMG:START -->" "$f" 2>/dev/null && echo "Has OMC config in companion: $f"
done

# Check if copilot-instructions.md references a companion file
grep -o "copilot-[^ )]*\.md" ~/.copilot/copilot-instructions.md 2>/dev/null
```

**Diagnosis**:
- If copilot-instructions.md missing: CRITICAL - copilot-instructions.md not configured
- If `<!-- OMG:START -->` found in copilot-instructions.md: OK
- If `<!-- OMG:START -->` found in a companion file (e.g. `copilot-omg.md`): OK - file-split pattern detected
- If no OMC markers in copilot-instructions.md or any companion file: WARN - outdated copilot-instructions.md

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
ls -la ~/.copilot/agents/ 2>/dev/null

# Check for legacy commands directory
ls -la ~/.copilot/commands/ 2>/dev/null

# Check for legacy skills directory
ls -la ~/.copilot/skills/ 2>/dev/null
```

**Diagnosis**:
- If `~/.copilot/agents/` exists with files matching plugin agent names: WARN - legacy agents (now provided by plugin)
- If `~/.copilot/commands/` exists with files matching plugin command names: WARN - legacy commands (now provided by plugin)
- If `~/.copilot/skills/` exists with files matching plugin skill names: WARN - legacy skills (now provided by plugin)
- If custom files exist that do NOT match plugin names: OK - these are user custom content, do not flag them

**Known plugin agent names** (check agents/ for these):
`architect.md`, `document-specialist.md`, `explore.md`, `executor.md`, `debugger.md`, `planner.md`, `analyst.md`, `critic.md`, `verifier.md`, `test-engineer.md`, `designer.md`, `writer.md`, `qa-tester.md`, `scientist.md`, `security-reviewer.md`, `code-reviewer.md`, `git-master.md`, `code-simplifier.md`

**Known plugin skill names** (check skills/ for these):
`ai-slop-cleaner`, `ask`, `autopilot`, `cancel`, `ccg`, `configure-notifications`, `deep-interview`, `deepinit`, `external-context`, `hud`, `learner`, `mcp-setup`, `omc-doctor`, `omc-setup`, `omc-teams`, `plan`, `project-session-manager`, `ralph`, `ralplan`, `release`, `sciomc`, `setup`, `skill`, `team`, `ultraqa`, `ultrawork`, `writer-memory`

**Known plugin command names** (check commands/ for these):
`ultrawork.md`, `deepsearch.md`

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
Remove the `"hooks"` section from `~/.copilot/settings.json` (keep other settings intact)

### Fix: Legacy Bash Scripts
```bash
rm -f ~/.copilot/hooks/keyword-detector.sh
rm -f ~/.copilot/hooks/persistent-mode.sh
rm -f ~/.copilot/hooks/session-start.sh
rm -f ~/.copilot/hooks/stop-continuation.sh
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
Fetch latest from GitHub and write to `~/.copilot/copilot-instructions.md`:
```
WebFetch(url: "https://raw.githubusercontent.com/RobinNorberg/oh-my-copilot/main/docs/copilot-instructions.md", prompt: "Return the complete raw markdown content exactly as-is")
```

### Fix: Legacy Curl-Installed Content

Remove legacy agents, commands, and skills directories (now provided by plugin):

```bash
# Backup first (optional - ask user)
# mv ~/.copilot/agents ~/.copilot/agents.bak
# mv ~/.copilot/commands ~/.copilot/commands.bak
# mv ~/.copilot/skills ~/.copilot/skills.bak

# Or remove directly
rm -rf ~/.copilot/agents
rm -rf ~/.copilot/commands
rm -rf ~/.copilot/skills
```

**Note**: Only remove if these contain oh-my-copilot-related files. If user has custom agents/commands/skills, warn them and ask before removing.

---

## Post-Fix

After applying fixes, inform user:
> Fixes applied. **Restart Copilot CLI** for changes to take effect.

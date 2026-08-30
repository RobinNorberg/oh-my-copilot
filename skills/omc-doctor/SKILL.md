---
name: omc-doctor
description: Diagnose and fix oh-my-copilot installation issues
level: 3
---

# Doctor Skill

Note: All `~/.claude/...` paths in this guide respect `COPILOT_CONFIG_DIR` when that environment variable is set.

## Task: Run Installation Diagnostics

You are the OMC Doctor - diagnose and fix installation issues.

### Step 1: Check Plugin Version

```bash
# Get installed and latest versions (cross-platform)
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),d=process.env.COPILOT_CONFIG_DIR||p.join(h,'.claude'),b=p.join(d,'plugins','cache','omc','oh-my-copilot');try{const v=f.readdirSync(b).filter(x=>/^\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));console.log('Installed:',v.length?v[v.length-1]:'(none)')}catch{console.log('Installed: (none)')}"
node -e "const{spawnSync}=require('node:child_process');const r=spawnSync('npm',['view','oh-my-copilot','version'],{encoding:'utf8',shell:process.platform==='win32'});console.log('Latest:',r.status===0?(r.stdout||'').trim():'(unavailable)')"
```

**Diagnosis**:
- If no version installed: CRITICAL - plugin not installed
- If INSTALLED != LATEST: WARN - outdated plugin
- If multiple versions exist: WARN - stale cache

### Step 2: Check for Legacy Hooks in settings.json

Read both `${COPILOT_CONFIG_DIR:-~/.claude}/settings.json` (profile-level) and `./.claude/settings.json` (project-level) and check if there's a `"hooks"` key with entries like:
- `bash ${COPILOT_CONFIG_DIR:-$HOME/.claude}/hooks/keyword-detector.sh`
- `bash ${COPILOT_CONFIG_DIR:-$HOME/.claude}/hooks/persistent-mode.sh`
- `bash ${COPILOT_CONFIG_DIR:-$HOME/.claude}/hooks/session-start.sh`

**Diagnosis**:
- If found: CRITICAL - legacy hooks causing duplicates

### Step 3: Check for Legacy Bash Hook Scripts

```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.claude'),b=p.join(d,'hooks');try{const s=f.readdirSync(b).filter(x=>x.endsWith('.sh'));console.log(s.length===0?'No legacy .sh hooks in '+b:'Legacy .sh hooks in '+b+': '+s.join(', '))}catch{console.log('No hooks directory at '+b)}"
```

**Diagnosis**:
- If `keyword-detector.sh`, `persistent-mode.sh`, `session-start.sh`, or `stop-continuation.sh` exist: WARN - legacy scripts (can cause confusion)

### Step 4: Check CLAUDE.md

```bash
# Presence, OMC marker, companion reference, and every CLAUDE-*.md companion in one
# pass. The needle is OMC:START, the unique part of the canonical marker.
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.claude');const base=p.join(d,'CLAUDE.md');const MARK='OMC:START';let text='';try{text=f.readFileSync(base,'utf8');console.log('CLAUDE.md: present at '+base+' ('+text.length+' bytes)')}catch{console.log('CLAUDE.md: MISSING at '+base)};console.log(text.includes(MARK)?'Has OMC config':'Missing OMC config in CLAUDE.md');const ref=text.match(/CLAUDE-[^ )]*\.md/);console.log('Companion reference:',ref?ref[0]:'(none)');let names=[];try{names=f.readdirSync(d).filter(x=>{const n=x.toLowerCase();return n.startsWith('claude-')&&n.endsWith('.md')})}catch{};for(const n of names){let c='';try{c=f.readFileSync(p.join(d,n),'utf8')}catch{};console.log((c.includes(MARK)?'Has OMC config in companion: ':'Companion without OMC config: ')+n)}"

# Check CLAUDE.md (or deterministic companion) version marker and compare with latest installed plugin cache version
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),d=process.env.COPILOT_CONFIG_DIR||p.join(h,'.claude');const base=p.join(d,'CLAUDE.md');let baseContent='';try{baseContent=f.readFileSync(base,'utf8')}catch{};let candidates=[base];let referenced='';const importMatch=baseContent.match(/CLAUDE-[^ )]*\\.md/);if(importMatch){referenced=p.join(d,importMatch[0]);candidates.push(referenced)}else{const defaultCompanion=p.join(d,'CLAUDE-omc.md');if(f.existsSync(defaultCompanion))candidates.push(defaultCompanion);try{const others=f.readdirSync(d).filter(n=>/^CLAUDE-.*\\.md$/i.test(n)).sort().map(n=>p.join(d,n));for(const o of others){if(candidates.includes(o)===false)candidates.push(o)}}catch{}};let claudeV='(missing)';let claudeSource='(none)';for(const file of candidates){try{const c=f.readFileSync(file,'utf8');const m=c.match(/OMC:VERSION:([^\\s]+)/i);if(m){claudeV=m[1];claudeSource=file;break}}catch{}};if(claudeV==='(missing)'&&candidates.length>0){claudeV='(missing marker)';claudeSource='scanned deterministic CLAUDE sources';};let pluginV='(none)';try{const b=p.join(d,'plugins','cache','omc','oh-my-copilot');const v=f.readdirSync(b).filter(x=>/^\\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));pluginV=v.length?v[v.length-1]:'(none)';}catch{};console.log('CLAUDE.md OMC version:',claudeV);console.log('OMC version source:',claudeSource);console.log('Latest cached plugin version:',pluginV);if(claudeV==='(missing)'||claudeV==='(missing marker)'||pluginV==='(none)'){console.log('VERSION CHECK SKIPPED: missing CLAUDE marker or plugin cache')}else if(claudeV===pluginV){console.log('VERSION MATCH: CLAUDE and plugin cache are aligned')}else{console.log('VERSION DRIFT: CLAUDE.md and plugin versions differ')}"
```

**Diagnosis**:
- If CLAUDE.md missing: CRITICAL - CLAUDE.md not configured
- If `<!-- OMC:START -->` found in CLAUDE.md: OK
- If `<!-- OMC:START -->` found in a companion file (e.g. `CLAUDE-omc.md`): OK - file-split pattern detected
- If no OMC markers in CLAUDE.md or any companion file: WARN - outdated CLAUDE.md
- If `OMC:VERSION` marker is missing from deterministic CLAUDE source scan (base + referenced companion): WARN - cannot verify CLAUDE.md freshness
- If `CLAUDE.md OMC version` != `Latest cached plugin version`: WARN - version drift detected (run `omc update` or `omc setup`)

### Step 5: Check Ralph Ruby Dependency

Ralph workflows require Ruby. Check for Ruby explicitly so fresh installations get actionable guidance instead of a later opaque Ralph failure.

```bash
node -e "const{spawnSync}=require('node:child_process');const r=spawnSync('ruby',['--version'],{encoding:'utf8',shell:process.platform==='win32'});if(r.status===0){console.log('Ruby for Ralph:',(r.stdout||'').split(/\r?\n/)[0])}else{console.log('Ruby for Ralph: MISSING');console.log('Install Ruby before using Ralph. Ubuntu/Debian: sudo apt update && sudo apt install ruby-full');console.log('macOS: brew install ruby');console.log('Windows: winget install RubyInstallerTeam.Ruby')}"
```

**Diagnosis**:
- If Ruby is found: OK - Ralph dependency present
- If Ruby is missing: WARN - Ralph workflows may fail until Ruby is installed

### Step 6: Check for Stale Plugin Cache

```bash
# Count versions in cache (cross-platform)
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),d=process.env.COPILOT_CONFIG_DIR||p.join(h,'.claude'),b=p.join(d,'plugins','cache','omc','oh-my-copilot');try{const v=f.readdirSync(b).filter(x=>/^\d/.test(x));console.log(v.length+' version(s):',v.join(', '))}catch{console.log('0 versions')}"
```

**Diagnosis**:
- If > 1 version: WARN - multiple cached versions (cleanup recommended)

### Step 7: Check for Legacy Curl-Installed Content

Check for legacy agents, commands, and skills installed via curl (before plugin system).
**Important**: Only flag files whose names match actual plugin-provided names. Do NOT flag user's custom agents/commands/skills that are unrelated to OMC.

```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.claude');for(const dir of ['agents','commands','skills']){try{const e=f.readdirSync(p.join(d,dir));console.log(dir+' ('+e.length+'): '+e.join(', '))}catch{console.log(dir+': (absent)')}}"
```

**Diagnosis**:
- If `~/.claude/agents/` exists with files matching plugin agent names: WARN - legacy agents (now provided by plugin)
- If `~/.claude/commands/` exists with files matching plugin command names: WARN - legacy commands (now provided by plugin)
- If `~/.claude/skills/` exists with files matching plugin skill names: WARN - legacy skills (now provided by plugin)
- If custom files exist that do NOT match plugin names: OK - these are user custom content, do not flag them

**Known plugin agent names** (check agents/ for these):
`architect.md`, `document-specialist.md`, `explore.md`, `executor.md`, `debugger.md`, `planner.md`, `analyst.md`, `critic.md`, `verifier.md`, `test-engineer.md`, `designer.md`, `writer.md`, `qa-tester.md`, `scientist.md`, `security-reviewer.md`, `code-reviewer.md`, `git-master.md`, `code-simplifier.md`

**Known plugin skill names** (check skills/ for these):
`ai-slop-cleaner`, `ask`, `autopilot`, `cancel`, `configure-notifications`, `deep-interview`, `deepinit`, `external-context`, `hud`, `omc-doctor`, `omc-setup`, `plan`, `project-session-manager`, `ralph`, `ralplan`, `release`, `skill`, `team`, `visual-verdict`, `wiki`

**Known plugin command names** (check commands/ for these):
`deepsearch.md`

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
| Legacy Scripts (~/.claude/hooks/) | OK/WARN | ... |
| CLAUDE.md | OK/WARN/CRITICAL | ... |
| Ralph Ruby Dependency | OK/WARN | ... |
| Plugin Cache | OK/WARN | ... |
| Legacy Agents (~/.claude/agents/) | OK/WARN | ... |
| Legacy Commands (~/.claude/commands/) | OK/WARN | ... |
| Legacy Skills (~/.claude/skills/) | OK/WARN | ... |

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
Remove the `"hooks"` section from `${COPILOT_CONFIG_DIR:-~/.claude}/settings.json` (keep other settings intact)

### Fix: Legacy Bash Scripts
```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.claude');for(const n of ['keyword-detector.sh','persistent-mode.sh','session-start.sh','stop-continuation.sh']){const t=p.join(d,'hooks',n);if(f.existsSync(t)){f.rmSync(t,{force:true});console.log('Removed '+t)}}"
```

### Fix: Outdated Plugin
```bash
# Clear plugin cache (cross-platform)
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.claude'),b=p.join(d,'plugins','cache','omc','oh-my-copilot');try{f.rmSync(b,{recursive:true,force:true});console.log('Plugin cache cleared. Restart Claude Code to fetch latest version.')}catch{console.log('No plugin cache found')}"
```

### Fix: Stale Cache (multiple versions)
```bash
# Keep only latest version (cross-platform)
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),d=process.env.COPILOT_CONFIG_DIR||p.join(h,'.claude'),b=p.join(d,'plugins','cache','omc','oh-my-copilot');try{const v=f.readdirSync(b).filter(x=>/^\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));v.slice(0,-1).forEach(x=>f.rmSync(p.join(b,x),{recursive:true,force:true}));console.log('Removed',v.length-1,'old version(s)')}catch(e){console.log('No cache to clean')}"
```

### Fix: Missing/Outdated CLAUDE.md
Fetch latest from GitHub and write to `${COPILOT_CONFIG_DIR:-~/.claude}/CLAUDE.md`:
```
WebFetch(url: "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-copilot/main/docs/CLAUDE.md", prompt: "Return the complete raw markdown content exactly as-is")
```

### Fix: Legacy Curl-Installed Content

Remove legacy agents, commands, and skills directories (now provided by plugin):

Back up first (offer this to the user before removing anything):

```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.claude');for(const n of ['agents','commands','skills']){const s=p.join(d,n);if(f.existsSync(s)){f.renameSync(s,s+'.bak');console.log('Moved '+s+' to '+s+'.bak')}}"
```

Or remove directly:

```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.claude');for(const n of ['agents','commands','skills']){const t=p.join(d,n);if(f.existsSync(t)){f.rmSync(t,{recursive:true,force:true});console.log('Removed '+t)}}"
```

**Note**: Only remove if these contain oh-my-copilot-related files. If user has custom agents/commands/skills, warn them and ask before removing.

---

## Post-Fix

After applying fixes, inform user:
> Fixes applied. **Restart Claude Code** for changes to take effect.

# Phase 2: Environment Configuration

**Skip condition**: If resuming and `lastCompletedStep >= 4`, skip Steps 2.0–2.3 and begin at Step 2.4 so retired setup values are always cleared before the phase exits.

## Resume Boundary

Capture the original progress marker once when Phase 2 starts. A resumed run that enters at Step 2.4 must not repeat the completed Steps 2.5/2.6 prompts or overwrite a higher progress marker:

```bash
node -e "const p=require('path'),f=require('fs'),t=p.join('.omg','state','setup-state.json');let s={};if(f.existsSync(t)){try{s=JSON.parse(f.readFileSync(t,'utf8'))}catch{console.error('ERROR: Setup state is invalid JSON. Existing setup state was not modified.');process.exit(1)}}const step=Number.isFinite(s.lastCompletedStep)?s.lastCompletedStep:0;console.log('RESUME_LAST_COMPLETED_STEP='+step);console.log('RESUMED_PHASE_TWO_BOUNDARY='+(step>=4))"
```

## Step 2.0: Check Ralph Ruby Dependency

Ralph workflows require Ruby. On fresh Ubuntu installations, missing Ruby can cause Ralph to fail later with an opaque Claude Code abort. Check for Ruby during setup and show a product-facing remediation hint without blocking the rest of setup:

```bash
node -e "const{spawnSync}=require('node:child_process');const r=spawnSync('ruby',['--version'],{encoding:'utf8',shell:process.platform==='win32'});if(r.status===0){console.log('Ruby detected for Ralph workflows: '+(r.stdout||'').split(/\r?\n/)[0])}else{console.log('WARNING: Ruby was not found on PATH. Ralph workflows require Ruby.');console.log('Install it, then restart Claude Code before using Ralph.');console.log('Ubuntu/Debian: sudo apt update && sudo apt install ruby-full');console.log('macOS: brew install ruby');console.log('Windows: winget install RubyInstallerTeam.Ruby')}"
```

## Step 2.1: Setup HUD Statusline

**Note**: If resuming and `lastCompletedStep >= 3`, skip to Step 2.2.

The HUD shows real-time status in Claude Code's status bar. Delegate all HUD/statusLine setup to the `hud` skill:

Use the Skill tool to invoke: `hud` with args: `setup`

Do not generate, normalize, or patch `statusLine` paths inline in this phase. This is especially important on Windows, where backslash path handling must stay inside the `hud` skill.

This will:
1. Install the HUD wrapper script to `~/.claude/hud/omcp-hud.mjs`
2. Configure `statusLine` in `~/.claude/settings.json`
3. Report status and prompt to restart if needed

After HUD setup completes, save progress:
```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-progress.mjs" save 3
```

With no config type argument, `save` carries forward the one already recorded in `.omg/state/setup-state.json`.

## Step 2.2: Repair Stale Plugin Cache References

After a marketplace update, Claude Code may still have old OMC cache paths in the running session or plugin registry. Repair those references before any cache cleanup so setup does not repeatedly emit stale plugin directory errors.

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/repair-plugin-cache.mjs"
```

## Step 2.3: Check for Updates

Notify user if a newer version is available:

```bash
# Detect installed version (cross-platform)
node -e "
const p=require('path'),f=require('fs'),h=require('os').homedir();
const raw=process.env.COPILOT_CONFIG_DIR?.trim();
const d=raw==null||raw===''? p.join(h,'.claude'):raw==='~'?h:raw.startsWith('~/')||raw.startsWith('~\\\\')?p.join(h,raw.slice(2)):raw;
let v='';
// Try cache directory first
const b=p.join(d,'plugins','cache','omc','oh-my-copilot');
try{const vs=f.readdirSync(b).filter(x=>/^\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));if(vs.length)v=vs[vs.length-1]}catch{}
// Try .omc-version.json second
if(v==='')try{const j=JSON.parse(f.readFileSync('.omc-version.json','utf-8'));v=j.version||''}catch{}
// Try CLAUDE.md header third
if(v==='')for(const c of['.claude/CLAUDE.md',p.join(d,'CLAUDE.md')]){try{const m=f.readFileSync(c,'utf-8').match(/^# oh-my-copilot.*?(v?\d+\.\d+\.\d+)/m);if(m){v=m[1].replace(/^v/,'');break}}catch{}}
console.log('Installed:',v||'(not found)');
"
```

Then compare it against the published version. Pass the installed version printed above
as the argument:

```bash
node -e "const{spawnSync}=require('node:child_process');const installed=(process.argv[1]||'').trim();const r=spawnSync('npm',['view','oh-my-copilot','version'],{encoding:'utf8',shell:process.platform==='win32'});const latest=r.status===0?(r.stdout||'').trim():'';if(installed&&latest){if(installed===latest){console.log('You are on the latest version: v'+installed)}else{console.log('UPDATE AVAILABLE:');console.log('  Installed: v'+installed);console.log('  Latest:    v'+latest);console.log('To update, run: claude /install-plugin oh-my-copilot')}}else if(latest){console.log('Latest version available: v'+latest)}else{console.log('Latest version: (unavailable)')}" "INSTALLED_VERSION"
```

## Step 2.4: Clear Retired Setup Values

The `ultrawork` workflow was removed in 5.0.0 and the `defaultExecutionMode` config key is no longer read by any runtime surface. Upgrades from 4.x may still carry a dead persisted value in `.omc-config.json`. Clear it so the config matches the current contract:

The write goes through a temp file, so a failure leaves the existing config untouched:

```bash
node -e "const p=require('path'),f=require('fs'),os=require('os'),BS=String.fromCharCode(92);let d=(process.env.COPILOT_CONFIG_DIR||'').trim();if(d==='')d=p.join(os.homedir(),'.copilot');else if(d==='~')d=os.homedir();else if(d.slice(0,2)==='~/'||d.slice(0,2)==='~'+BS)d=p.join(os.homedir(),d.slice(2));const t=p.join(d,'.omc-config.json');if(f.existsSync(t)===false)process.exit(0);let c;try{c=JSON.parse(f.readFileSync(t,'utf8'))}catch{console.log('WARNING: '+t+' is not valid JSON. Existing config was not modified.');process.exit(0)}if(c===null||(typeof c==='object')===false||('defaultExecutionMode' in c)===false)process.exit(0);delete c.defaultExecutionMode;const tmp=t+'.tmp.'+process.pid;try{f.writeFileSync(tmp,JSON.stringify(c,null,2));f.renameSync(tmp,t);console.log('Cleared retired defaultExecutionMode key (ultrawork was removed in 5.0.0)')}catch(e){f.rmSync(tmp,{force:true});console.log('WARNING: Failed to clear retired defaultExecutionMode. Existing config was not modified.')}"
```

**Note:** Never write a new `defaultExecutionMode` value. Generic keywords no longer route through a configured execution mode; invoke `/oh-my-copilot:execute` or `/oh-my-copilot:team` directly instead.

**Resume-only boundary:** If `RESUMED_PHASE_TWO_BOUNDARY` is `true`, stop Phase 2 after this cleanup. Do not execute Steps 2.5 or 2.6, do not prompt for task-tool or team settings again, and do not save a new progress value. Return to the setup orchestrator with the original `RESUME_LAST_COMPLETED_STEP` unchanged.

## Step 2.5: Install OMC CLI Tool

The OMC CLI (`omc` command) provides standalone helper commands such as `omc hud`, `omc teleport`, and `omc team ...`.

First, check if the CLI is already installed:

```bash
node -e "const{spawnSync}=require('node:child_process');const r=spawnSync('omc',['--version'],{encoding:'utf8',shell:process.platform==='win32'});if(r.status===0){console.log('OMC CLI already installed: '+((r.stdout||'').split(/\r?\n/)[0]||'installed'));console.log('OMC_CLI_INSTALLED=true')}else{console.log('OMC_CLI_INSTALLED=false')}"
```

If `OMC_CLI_INSTALLED` is `"true"`, skip the rest of this step.

If `OMC_CLI_INSTALLED` is `"false"`, use AskUserQuestion:

**Question:** "Would you like to install the OMC CLI globally for standalone helper commands? (`omc`, `omc hud`, `omc teleport`)"

**Options:**
1. **Yes (Recommended)** - Install `oh-my-copilot` via `npm install -g`
2. **No - Skip** - Skip installation (can install manually later with `npm install -g oh-my-copilot`)

If user chooses **Yes**:

```bash
node -e "const{spawnSync}=require('node:child_process');const sh=process.platform==='win32';const run=(c,a)=>spawnSync(c,a,{encoding:'utf8',shell:sh});if((run('npm',['--version']).status===0)===false){console.log('WARNING: npm not found. Cannot install OMC CLI automatically.');console.log('Install Node.js/npm first, then run: npm install -g oh-my-copilot');process.exit(0)}const i=spawnSync('npm',['install','-g','oh-my-copilot'],{stdio:'inherit',shell:sh});if(i.status===0){console.log('OMC CLI installed successfully.');const v=run('omc',['--version']);console.log(v.status===0?'Verified: omc '+((v.stdout||'').split(/\r?\n/)[0]||'installed'):\"Installed but 'omc' not on PATH. You may need to restart your shell.\")}else{console.log('WARNING: Failed to install OMC CLI (permission issue or network error).');console.log('You can install manually later: npm install -g oh-my-copilot');console.log('On Linux/macOS you may need: sudo npm install -g oh-my-copilot')}"
```

**Note**: The CLI is optional. All core functionality is also available through the plugin system.

## Step 2.6: Select Task Management Tool

First, detect available task tools:

```bash
node -e "const{spawnSync}=require('node:child_process');const sh=process.platform==='win32';let found=false;for(const[cmd,label]of [['bd','beads (bd)'],['br','beads-rust (br)']]){const r=spawnSync(cmd,['--version'],{encoding:'utf8',shell:sh});if(r.status===0){found=true;console.log('Found '+label+': '+((r.stdout||'').split(/\r?\n/)[0]||'installed'))}}if(found===false)console.log('No external task tools found. Using built-in Tasks.')"
fi
```

If **neither** beads nor beads-rust is detected, skip this step (default to built-in).

If beads or beads-rust is detected, use AskUserQuestion:

**Question:** "Which task management tool should I use for tracking work?"

**Options:**
1. **Built-in Tasks (default)** - Use Claude Code's native TodoWrite or available task-list surface. Tasks are session-only.
2. **Beads (bd)** - Git-backed persistent tasks. Survives across sessions. [Only if detected]
3. **Beads-Rust (br)** - Lightweight Rust port of beads. [Only if detected]

(Only show options 2/3 if the corresponding tool is detected)

Store the preference:

Pass the user's selection (`builtin`, `beads`, or `beads-rust`) as the argument. The write
goes through a temp file, so a failure leaves the existing config untouched:

```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.copilot'),t=p.join(d,'.omc-config.json');const tool=process.argv[1];f.mkdirSync(p.dirname(t),{recursive:true});let c={};if(f.existsSync(t)){try{c=JSON.parse(f.readFileSync(t,'utf8'))}catch{console.error('ERROR: '+t+' is not valid JSON. Existing config was not modified.');process.exit(1)}}c.taskTool=tool;c.taskToolConfig={injectInstructions:true,useMcp:false};const tmp=t+'.tmp.'+process.pid;try{f.writeFileSync(tmp,JSON.stringify(c,null,2));f.renameSync(tmp,t);console.log('Task tool set to: '+tool)}catch(e){f.rmSync(tmp,{force:true});console.error('ERROR: Failed to update '+t+'. Existing config was not modified.');process.exit(1)}" "USER_CHOICE"
```

**Note:** The beads context instructions will be injected automatically on the next session start.

## Save Progress

If this phase was resumed at the Phase 2 boundary (`RESUMED_PHASE_TWO_BOUNDARY` is true), do NOT save; report `Resumed Phase 2: preserving lastCompletedStep=<RESUME_LAST_COMPLETED_STEP>` instead. Otherwise run:

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-progress.mjs" save 4
```

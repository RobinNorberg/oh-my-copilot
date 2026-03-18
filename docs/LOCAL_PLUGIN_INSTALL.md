# Local Plugin Installation & Distribution

How to install, package, and distribute oh-my-copilot for local teams using Copilot CLI (v1.0.2+).

## Quick Install (Direct from Local Path)

The simplest approach — install directly from a local directory:

```bash
copilot plugin install /path/to/oh-my-copilot
```

Copilot copies the plugin into `~/.copilot/installed-plugins/_direct/oh-my-copilot/`. Verify:

```bash
copilot plugin list
# Should show: oh-my-copilot (v4.7.8)
```

## Marketplace Install (Local Directory as Marketplace)

For repeated updates during development, register the directory as a local marketplace:

```bash
# 1. Add local directory as a marketplace
copilot plugin marketplace add /path/to/oh-my-copilot

# 2. Install the plugin from the local marketplace
copilot plugin install oh-my-copilot@oh-my-copilot

# 3. Restart Copilot CLI to pick up the plugin
```

### Commands Reference

```bash
# List configured marketplaces
copilot plugin marketplace list

# Update marketplace (re-read from source)
copilot plugin marketplace update oh-my-copilot

# Update the installed plugin
copilot plugin update oh-my-copilot@oh-my-copilot

# List installed plugins
copilot plugin list

# Uninstall
copilot plugin uninstall oh-my-copilot@oh-my-copilot

# Remove marketplace
copilot plugin marketplace remove oh-my-copilot
```

---

## Packaging & Distribution for Teams

### Option 1: Shared Network Drive / Mount

Place the built plugin on a shared path accessible to all team members.

**Maintainer (one-time setup):**

```bash
cd /path/to/oh-my-copilot
npm install
npm run build
# Copy to shared location (adjust path for your environment)
# Windows:
robocopy . "\\server\shared\copilot-plugins\oh-my-copilot" /MIR /XD node_modules/.cache .git .omc
# macOS/Linux:
rsync -av --exclude='node_modules/.cache' --exclude='.git' --exclude='.omc' . /mnt/shared/copilot-plugins/oh-my-copilot/
```

**Colleagues:**

```bash
copilot plugin install "\\server\shared\copilot-plugins\oh-my-copilot"
# or on macOS/Linux:
copilot plugin install /mnt/shared/copilot-plugins/oh-my-copilot
```

### Option 2: Git Clone (Internal Repo)

Push to an internal Git host (GitHub Enterprise, Azure DevOps, GitLab) and have colleagues clone + install.

**Maintainer:**

```bash
git remote add internal https://your-org.dev/repos/oh-my-copilot.git
git push internal dev
```

**Colleagues:**

```bash
git clone https://your-org.dev/repos/oh-my-copilot.git
cd oh-my-copilot
npm install && npm run build
copilot plugin install .
```

To update after upstream changes:

```bash
cd oh-my-copilot
git pull
npm install && npm run build
copilot plugin uninstall oh-my-copilot
copilot plugin install .
```

### Option 3: Tarball Distribution

Package as a tarball for easy sharing via Slack, email, or artifact storage.

**Maintainer:**

```bash
cd /path/to/oh-my-copilot
npm install && npm run build

# Create distributable tarball (includes pre-built artifacts)
tar czf oh-my-copilot-4.7.8.tar.gz \
  --exclude='node_modules/.cache' \
  --exclude='.git' \
  --exclude='.omc' \
  .claude-plugin/ agents/ bridge/ dist/ docs/ hooks/ scripts/ \
  skills/ src/ templates/ node_modules/ \
  package.json .mcp.json CLAUDE.md
```

**Colleagues:**

```bash
mkdir oh-my-copilot && cd oh-my-copilot
tar xzf /path/to/oh-my-copilot-4.7.8.tar.gz
copilot plugin install .
```

### Option 4: npm Pack (Private Registry or Local)

Use npm's built-in packaging, which respects `.npmignore` and `files` in `package.json`.

**Maintainer:**

```bash
cd /path/to/oh-my-copilot
npm install && npm run build
npm pack
# Creates oh-my-copilot-4.7.8.tgz
```

**Colleagues (from the .tgz):**

```bash
mkdir oh-my-copilot && cd oh-my-copilot
tar xzf /path/to/oh-my-copilot-4.7.8.tgz --strip-components=1
npm install --production
copilot plugin install .
```

**Or publish to a private npm registry:**

```bash
# Maintainer
npm publish --registry https://your-org.dev/npm/

# Colleagues
npm install -g oh-my-copilot --registry https://your-org.dev/npm/
```

---

## Post-Install Verification

After installing, verify the plugin works correctly:

```bash
# 1. Check plugin is listed
copilot plugin list
# Expected: oh-my-copilot (v4.7.8)

# 2. Test MCP server starts (non-interactive)
copilot -p "Call the t-notepad_stats tool" --allow-tool "t" --yolo

# 3. Test skills are loaded (non-interactive)
copilot -p "List all available skills from oh-my-copilot" --allow-tool "t" --yolo
```

Inside an interactive session:

```bash
# Run setup
/oh-my-copilot:omc-setup

# Test a skill
/oh-my-copilot:hud
```

---

## Hardening Checklist

When distributing to colleagues for hardening, share this checklist:

- [ ] `copilot plugin list` shows oh-my-copilot installed
- [ ] MCP tools respond (try `/oh-my-copilot:hud`)
- [ ] Skills are discoverable (try typing `autopilot: hello world`)
- [ ] Agent delegation works (try `/oh-my-copilot:team 1:executor "echo hello"`)
- [ ] State persistence works (`.omg/` directory created in project root)
- [ ] Hooks fire on session start (look for OMP banner/context in prompt)
- [ ] Report any errors, unexpected behavior, or missing functionality

---

## Plugin Structure

The plugin manifest at `.claude-plugin/plugin.json`:

```json
{
  "name": "oh-my-copilot",
  "version": "4.7.8",
  "description": "Multi-agent orchestration system for Copilot CLI",
  "agents": "./agents/",
  "skills": ["skills/*/SKILL.md"],
  "mcpServers": { "t": { "command": "node", "args": ["bridge/mcp-server.cjs"] } }
}
```

Key directories:

| Directory | Purpose |
|-----------|---------|
| `.claude-plugin/` | Plugin manifest and marketplace metadata |
| `agents/` | Agent definitions (`*.agent.md`) |
| `skills/` | Skill definitions (`*/SKILL.md`) |
| `bridge/` | Pre-built MCP server and CLI bridge |
| `dist/` | Compiled TypeScript output |
| `hooks/` | Hook definitions (project-level, not auto-loaded) |
| `scripts/` | Runtime scripts invoked by hooks and skills |
| `.mcp.json` | MCP server configuration |

## Development Workflow

After making changes to the plugin source:

```bash
# 1. Build (compiles TypeScript → dist/ and bridge/)
npm run build

# 2. Run tests
npm test

# 3. Re-install into Copilot CLI
copilot plugin uninstall oh-my-copilot
copilot plugin install .

# 4. Start a new Copilot CLI session to pick up changes
```

## Troubleshooting

**Plugin not loading:**
- Start a new Copilot CLI session after installation
- Check `copilot plugin list` shows the plugin
- Verify `.claude-plugin/plugin.json` exists and is valid JSON

**Skills not found:**
- Skills use the full prefix: `/oh-my-copilot:hud`, not `/hud`
- Run `/oh-my-copilot:omc-doctor` to diagnose issues

**MCP tools not responding:**
- Ensure `node` is on PATH
- Check that `bridge/mcp-server.cjs` exists (run `npm run build` if missing)
- Copilot sets MCP server CWD to the plugin install directory

**Old version persisting after update:**
- Uninstall first, then reinstall: `copilot plugin uninstall oh-my-copilot && copilot plugin install .`
- Verify with `copilot plugin list` that the version matches

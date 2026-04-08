# Phase 4: Completion

## Detect Upgrade from 2.x

Check if user has existing 2.x configuration:

```bash
ls ~/.copilot/commands/ralph-loop.md 2>/dev/null || ls ~/.copilot/commands/ultrawork.md 2>/dev/null
```

If found, this is an upgrade from 2.x. Set `IS_UPGRADE=true`.

## Show Welcome Message

### For New Users (IS_UPGRADE is not true):

Display this exact output as a code block:

```
   ██████╗ ██╗  ██╗     ███╗   ███╗██╗   ██╗
  ██╔═══██╗██║  ██║     ████╗ ████║╚██╗ ██╔╝
  ██║   ██║███████║     ██╔████╔██║ ╚████╔╝
  ██║   ██║██╔══██║     ██║╚██╔╝██║  ╚██╔╝
  ╚██████╔╝██║  ██║     ██║ ╚═╝ ██║   ██║
   ╚═════╝ ╚═╝  ╚═╝     ╚═╝     ╚═╝   ╚═╝
             ██████╗ ██████╗ ██████╗ ██╗██╗      ██████╗ ████████╗
            ██╔════╝██╔═══██╗██╔══██╗██║██║     ██╔═══██╗╚══██╔══╝
            ██║     ██║   ██║██████╔╝██║██║     ██║   ██║   ██║
            ██║     ██║   ██║██╔═══╝ ██║██║     ██║   ██║   ██║
            ╚██████╗╚██████╔╝██║     ██║███████╗╚██████╔╝   ██║
             ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝    ╚═╝
     Turbocharge your Copilot CLI with multi-agent orchestration

  ┌──────────────────────────────────────────────────────────────┐
  │  /autopilot          Autonomous end-to-end execution       │
  │  /plan               Strategic planning with interview      │
  │  /team N             Parallel coordinated agents            │
  │  /review             Run code review                       │
  │  /ai-slop-cleaner    Clean AI-generated code slop           │
  │  /simplify           Simplify the code, and fix issues      │
  │  /ralph              Loop until task is complete            │
  │  /deepinit           Deep codebase initialization           │
  │  /cancel             Stop any active mode                   │
  │  /omc-setup          Interactive setup wizard               │
  └──────────────────────────────────────────────────────────────┘

  Type '/autopilot create a todo-app' to engage the magic dust!
```

Then show this below the banner:

```
HUD STATUSLINE:
The status bar now shows OMC state. Restart Copilot CLI to see it.
```

### For Users Upgrading from 2.x (IS_UPGRADE is true):

Display the same banner and command table as shown for new users above, followed by:

```
Upgraded from 2.x - your existing commands (/ralph, /ultrawork, etc.) still work!

HUD STATUSLINE:
The status bar now shows OMC state. Restart Copilot CLI to see it.
```

## Optional Rule Templates

OMC includes rule templates you can copy to your project's `.copilot/rules/` directory for automatic context injection:

| Template | Purpose |
|----------|---------|
| `coding-style.md` | Code style, immutability, file organization |
| `testing.md` | TDD workflow, 80% coverage target |
| `security.md` | Secret management, input validation |
| `performance.md` | Model selection, context management |
| `git-workflow.md` | Commit conventions, PR workflow |
| `karpathy-guidelines.md` | Coding discipline -- think before coding, simplicity, surgical changes |

Copy with:
```bash
mkdir -p .copilot/rules
cp "${COPILOT_PLUGIN_ROOT}/templates/rules/"*.md .copilot/rules/
```

See `templates/rules/README.md` for details.

## Ask About Starring Repository

First, check if `gh` CLI is available and authenticated:

```bash
gh auth status &>/dev/null
```

### If gh is available and authenticated:

**Before prompting, check if the repository is already starred:**

```bash
gh api user/starred/RobinNorberg/oh-my-copilot &>/dev/null
```

**If already starred (exit code 0):**
- Skip the prompt entirely
- Continue to completion silently

**If NOT starred (exit code non-zero):**

Use AskUserQuestion:

**Question:** "If you're enjoying oh-my-copilot, would you like to support the project by starring it on GitHub?"

**Options:**
1. **Yes, star it!** - Star the repository
2. **No thanks** - Skip without further prompts
3. **Maybe later** - Skip without further prompts

If user chooses "Yes, star it!":

```bash
gh api -X PUT /user/starred/RobinNorberg/oh-my-copilot 2>/dev/null && echo "Thanks for starring!" || true
```

**Note:** Fail silently if the API call doesn't work - never block setup completion.

### If gh is NOT available or not authenticated:

```bash
echo ""
echo "If you enjoy oh-my-copilot, consider starring the repo:"
echo "  https://github.com/RobinNorberg/oh-my-copilot"
echo ""
```

## Mark Completion

Get the current OMC version and mark setup complete:

```bash
# Get current OMC version from copilot-instructions.md
OMC_VERSION=""
if [ -f ".copilot/copilot-instructions.md" ]; then
  OMC_VERSION=$(grep -m1 'OMC:VERSION:' .copilot/copilot-instructions.md 2>/dev/null | sed -E 's/.*OMC:VERSION:([^ ]+).*/\1/' || true)
elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/copilot-instructions.md" ]; then
  OMC_VERSION=$(grep -m1 'OMC:VERSION:' "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/copilot-instructions.md" 2>/dev/null | sed -E 's/.*OMC:VERSION:([^ ]+).*/\1/' || true)
fi
if [ -z "$OMC_VERSION" ]; then
  OMC_VERSION=$(omc --version 2>/dev/null | head -1 || true)
fi
if [ -z "$OMC_VERSION" ]; then
  OMC_VERSION="unknown"
fi

bash "${COPILOT_PLUGIN_ROOT}/scripts/setup-progress.sh" complete "$OMC_VERSION"
```

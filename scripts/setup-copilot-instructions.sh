#!/usr/bin/env bash
# setup-copilot-instructions.sh - Unified copilot-instructions.md download/merge script
# Usage: setup-copilot-instructions.sh <local|global>
#
# Handles: version extraction, backup, download, marker stripping, merge, version reporting.
# For global mode, also cleans up legacy hooks.

set -euo pipefail

MODE="${1:?Usage: setup-copilot-instructions.sh <local|global>}"
DOWNLOAD_URL="https://raw.githubusercontent.com/RobinNorberg/oh-my-copilot/main/docs/copilot-instructions.md"

# Determine target path
if [ "$MODE" = "local" ]; then
  mkdir -p .copilot
  TARGET_PATH=".copilot/copilot-instructions.md"
elif [ "$MODE" = "global" ]; then
  TARGET_PATH="$HOME/.copilot/copilot-instructions.md"
else
  echo "ERROR: Invalid mode '$MODE'. Use 'local' or 'global'." >&2
  exit 1
fi

# Extract old version before download
OLD_VERSION=$(grep -m1 'OMP:VERSION:' "$TARGET_PATH" 2>/dev/null | sed -E 's/.*OMP:VERSION:([^ ]+).*/\1/' || true)
if [ -z "$OLD_VERSION" ]; then
  OLD_VERSION=$(omp --version 2>/dev/null | head -1 || true)
fi
if [ -z "$OLD_VERSION" ]; then
  OLD_VERSION="none"
fi

# Backup existing
if [ -f "$TARGET_PATH" ]; then
  BACKUP_DATE=$(date +%Y-%m-%d_%H%M%S)
  BACKUP_PATH="${TARGET_PATH}.backup.${BACKUP_DATE}"
  cp "$TARGET_PATH" "$BACKUP_PATH"
  echo "Backed up existing copilot-instructions.md to $BACKUP_PATH"
fi

# Download fresh OMP content to temp file
TEMP_OMP=$(mktemp /tmp/omp-copilot-XXXXXX.md)
trap 'rm -f "$TEMP_OMP"' EXIT
curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_OMP"

if [ ! -s "$TEMP_OMP" ]; then
  echo "ERROR: Failed to download copilot-instructions.md. Aborting."
  echo "FALLBACK: Manually download from: $DOWNLOAD_URL"
  rm -f "$TEMP_OMP"
  exit 1
fi

# Strip existing markers from downloaded content (idempotency)
# Use awk for cross-platform compatibility (GNU/BSD)
if grep -q '<!-- OMP:START -->' "$TEMP_OMP"; then
  awk '/<!-- OMP:END -->/{p=0} p; /<!-- OMP:START -->/{p=1}' "$TEMP_OMP" > "${TEMP_OMP}.clean"
  mv "${TEMP_OMP}.clean" "$TEMP_OMP"
fi

if [ ! -f "$TARGET_PATH" ]; then
  # Fresh install: wrap in markers
  {
    echo '<!-- OMP:START -->'
    cat "$TEMP_OMP"
    echo '<!-- OMP:END -->'
  } > "$TARGET_PATH"
  rm -f "$TEMP_OMP"
  echo "Installed copilot-instructions.md (fresh)"
else
  # Merge: preserve user content outside OMP markers
  if grep -q '<!-- OMP:START -->' "$TARGET_PATH"; then
    # Has markers: remove ALL complete OMP blocks, preserve only real user text
    # Use perl -0 for a global multiline regex replace (portable across GNU/BSD environments)
    perl -0pe 's/^<!-- OMP:START -->\R[\s\S]*?^<!-- OMP:END -->(?:\R)?//msg; s/^<!-- User customizations(?: \([^)]+\))? -->\R?//mg; s/\A(?:[ \t]*\R)+//; s/(?:\R[ \t]*)+\z//;' \
      "$TARGET_PATH" > "${TARGET_PATH}.preserved"

    if grep -Eq '^<!-- OMP:(START|END) -->$' "${TARGET_PATH}.preserved"; then
      # Corrupted/unmatched markers remain: preserve the whole original file for manual recovery
      OLD_CONTENT=$(cat "$TARGET_PATH")
      {
        echo '<!-- OMP:START -->'
        cat "$TEMP_OMP"
        echo '<!-- OMP:END -->'
        echo ""
        echo "<!-- User customizations (recovered from corrupted markers) -->"
        printf '%s\n' "$OLD_CONTENT"
      } > "${TARGET_PATH}.tmp"
    else
      PRESERVED_CONTENT=$(cat "${TARGET_PATH}.preserved")
      {
        echo '<!-- OMP:START -->'
        cat "$TEMP_OMP"
        echo '<!-- OMP:END -->'
        if printf '%s' "$PRESERVED_CONTENT" | grep -q '[^[:space:]]'; then
          echo ""
          echo "<!-- User customizations -->"
          printf '%s\n' "$PRESERVED_CONTENT"
        fi
      } > "${TARGET_PATH}.tmp"
    fi

    mv "${TARGET_PATH}.tmp" "$TARGET_PATH"
    rm -f "${TARGET_PATH}.preserved"
    echo "Updated OMP section (user customizations preserved)"
  else
    # No markers: wrap new content in markers, append old content as user section
    OLD_CONTENT=$(cat "$TARGET_PATH")
    {
      echo '<!-- OMP:START -->'
      cat "$TEMP_OMP"
      echo '<!-- OMP:END -->'
      echo ""
      echo "<!-- User customizations (migrated from previous copilot-instructions.md) -->"
      printf '%s\n' "$OLD_CONTENT"
    } > "${TARGET_PATH}.tmp"
    mv "${TARGET_PATH}.tmp" "$TARGET_PATH"
    echo "Migrated existing copilot-instructions.md (added OMP markers, preserved old content)"
  fi
  rm -f "$TEMP_OMP"
fi

# Extract new version and report
NEW_VERSION=$(grep -m1 'OMP:VERSION:' "$TARGET_PATH" 2>/dev/null | sed -E 's/.*OMP:VERSION:([^ ]+).*/\1/' || true)
if [ -z "$NEW_VERSION" ]; then
  NEW_VERSION=$(omp --version 2>/dev/null | head -1 || true)
fi
if [ -z "$NEW_VERSION" ]; then
  NEW_VERSION="unknown"
fi
if [ "$OLD_VERSION" = "none" ]; then
  echo "Installed copilot-instructions.md: $NEW_VERSION"
elif [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  echo "copilot-instructions.md unchanged: $NEW_VERSION"
else
  echo "Updated copilot-instructions.md: $OLD_VERSION -> $NEW_VERSION"
fi

# Legacy hooks cleanup (global mode only)
if [ "$MODE" = "global" ]; then
  rm -f ~/.copilot/hooks/keyword-detector.sh
  rm -f ~/.copilot/hooks/stop-continuation.sh
  rm -f ~/.copilot/hooks/persistent-mode.sh
  rm -f ~/.copilot/hooks/session-start.sh
  echo "Legacy hooks cleaned"

  # Check for manual hook entries in settings.json
  SETTINGS_FILE="$HOME/.copilot/settings.json"
  if [ -f "$SETTINGS_FILE" ]; then
    if jq -e '.hooks' "$SETTINGS_FILE" > /dev/null 2>&1; then
      echo ""
      echo "NOTE: Found legacy hooks in settings.json. These should be removed since"
      echo "the plugin now provides hooks automatically. Remove the \"hooks\" section"
      echo "from ~/.copilot/settings.json to prevent duplicate hook execution."
    fi
  fi
fi

# Verify plugin installation
grep -q "oh-my-copilot" ~/.copilot/settings.json && echo "Plugin verified" || echo "Plugin NOT found - run: copilot /install-plugin oh-my-copilot"

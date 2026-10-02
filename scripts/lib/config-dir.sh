#!/usr/bin/env sh

resolve_claude_config_dir() {
  configured="${COPILOT_HOME:-$HOME/.copilot}"
  configured="${configured#${configured%%[![:space:]]*}}"
  configured="${configured%${configured##*[![:space:]]}}"
  [ -n "$configured" ] || configured="$HOME/.copilot"
  if [ "$configured" != "/" ]; then
    configured="${configured%/}"
  fi
  case "$configured" in
    \~)
      printf '%s\n' "$HOME"
      ;;
    \~/*)
      configured="${configured#\~/}"
      printf '%s/%s\n' "$HOME" "$configured"
      ;;
    \~\\*)
      configured="${configured#\~}"
      configured="${configured#\\}"
      printf '%s/%s\n' "$HOME" "$configured"
      ;;
    *)
      printf '%s\n' "$configured"
      ;;
  esac
}

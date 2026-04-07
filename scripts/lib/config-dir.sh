#!/usr/bin/env sh

resolve_copilot_config_dir() {
  configured="${COPILOT_CONFIG_DIR:-$HOME/.copilot}"
  configured="${configured%/}"
  case "$configured" in
    \~)
      printf '%s\n' "$HOME"
      ;;
    \~/*)
      configured="${configured#\~/}"
      printf '%s/%s\n' "$HOME" "$configured"
      ;;
    *)
      printf '%s\n' "$configured"
      ;;
  esac
}

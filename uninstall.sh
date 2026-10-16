#!/bin/sh
# Project Pulse uninstaller for macOS and Linux.
#   --remove-data   also delete reviews, settings, logs and backups (kept by default).
# Your projects are never touched.
#
#   sh uninstall.sh [--remove-data]
set -u

LABEL=com.project-pulse.service
OS=$(uname -s)
REMOVE_DATA=0
for arg in "$@"; do
  case "$arg" in
    --remove-data) REMOVE_DATA=1 ;;
    -h | --help) echo 'Usage: sh uninstall.sh [--remove-data]'; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  CYAN=$(printf '\033[36m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); PLAIN=$(printf '\033[0m')
else
  CYAN=''; GREEN=''; YELLOW=''; PLAIN=''
fi
step() { printf '  %s> %s%s\n' "$CYAN" "$1" "$PLAIN"; }
ok() { printf '    %s%s%s\n' "$GREEN" "$1" "$PLAIN"; }

printf '\n  Project Pulse uninstaller\n\n'
if [ -z "${HOME:-}" ]; then echo 'HOME is not set.' >&2; exit 1; fi
PULSE_HOME="$HOME/.project-pulse"
APP="$PULSE_HOME/app"
DATA="$PULSE_HOME/data"
STAMP=$(date +%Y%m%d-%H%M%S)

step 'Stopping the service and closing the Pulse window'
if [ "$OS" = Darwin ]; then launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; fi
if command -v pkill >/dev/null 2>&1; then
  pkill -f '\.project-pulse/app/service/server\.mjs' 2>/dev/null || true
  pkill -f '\.project-pulse/data/window-profile' 2>/dev/null || true
fi
ok 'Stopped'

CLAUDE=$(command -v claude || true)
if [ -n "$CLAUDE" ]; then
  step 'Removing the mod from Claude Code'
  backup="$DATA/backups/uninstall-$STAMP"
  mkdir -p "$backup"
  for file in "$HOME/.claude/settings.json" "$HOME/.claude/plugins/known_marketplaces.json" "$HOME/.claude/plugins/installed_plugins.json"; do
    if [ -f "$file" ]; then cp "$file" "$backup/"; fi
  done
  "$CLAUDE" plugin uninstall project-pulse@project-pulse-local --scope user || true
  "$CLAUDE" plugin marketplace remove project-pulse-local || true
  ok "Removed (settings backed up to $backup)"
fi

step 'Removing the Pulse tools from other AI tools'
NODE=$(command -v node || true)
if [ -f "$APP/bin/node.txt" ]; then NODE=$(head -n 1 "$APP/bin/node.txt"); fi
if [ -n "$NODE" ] && [ -f "$APP/bin/register-agents.mjs" ]; then
  "$NODE" "$APP/bin/register-agents.mjs" --remove --app "$APP" --backup "$DATA/backups/uninstall-agents-$STAMP" || true
fi

step 'Removing the login item'
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/project-pulse.desktop"
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/project-pulse.desktop"
ok 'Removed'

step 'Removing the app'
rm -rf "$APP"
if [ "$REMOVE_DATA" = 1 ]; then
  rm -rf "$PULSE_HOME"
  ok 'Removed the app and all Pulse data'
else
  ok "Removed the app. Your review history is kept in $DATA (run with --remove-data to delete it)."
fi

printf '\n  %sClaude Desktop: if you added the extension, remove "Project Pulse" in Settings > Extensions.%s\n\n' "$YELLOW" "$PLAIN"

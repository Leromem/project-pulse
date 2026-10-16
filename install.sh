#!/bin/sh
# Project Pulse installer for macOS and Linux. Per-user, no sudo needed. Run it again to update.
#
# What it does:
#   1. Copies the app to ~/.project-pulse/app (data lives in ~/.project-pulse/data, private to you).
#   2. Backs up the Claude Code files it changes to ~/.project-pulse/data/backups/<time>.
#   3. Adds the Project Pulse mod to Claude Code at USER scope (every project, now and future):
#      a local marketplace "project-pulse-local" plus the plugin "project-pulse".
#      The plugin also brings the Project Pulse MCP tools to Claude Code.
#   4. Builds the Claude Desktop extension (dist/ProjectPulse.mcpb) for you to add in Claude Desktop.
#      It also adds the Pulse MCP tools to other AI tools it finds (Codex CLI, Cursor, Gemini CLI,
#      Windsurf, VS Code Copilot), backing up each config first. Skip that with --no-agents.
#      --agent-instructions also adds a short "review finished tasks" note for Codex and Gemini CLI.
#   5. Starts the service when you log in: a LaunchAgent on macOS, an autostart entry on Linux
#      (plus a "Project Pulse" item in the Linux app menu that opens the window).
#   6. Starts the service.
# It does not touch your projects' files or your Claude Desktop config.
#
# macOS and Linux support is checked by unit tests and shell syntax checks, not yet on a real
# Mac or Linux desktop. If something does not work, the log is ~/.project-pulse/data/logs/pulse.log.
#
#   sh install.sh [--no-start] [--skip-claude] [--no-agents] [--agent-instructions]
set -eu

SOURCE=$(cd "$(dirname "$0")" && pwd -P)
LABEL=com.project-pulse.service
OS=$(uname -s)
NO_START=0
SKIP_CLAUDE=0
NO_AGENTS=0
AGENT_INSTRUCTIONS=0
for arg in "$@"; do
  case "$arg" in
    --no-start) NO_START=1 ;;
    --skip-claude) SKIP_CLAUDE=1 ;;
    --no-agents) NO_AGENTS=1 ;;
    --agent-instructions) AGENT_INSTRUCTIONS=1 ;;
    -h | --help) echo 'Usage: sh install.sh [--no-start] [--skip-claude] [--no-agents] [--agent-instructions]'; exit 0 ;;
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
note() { printf '    %s%s%s\n' "$YELLOW" "$1" "$PLAIN"; }
fail() { printf '  %s%s%s\n' "$YELLOW" "$1" "$PLAIN" >&2; exit 1; }
# Text placed in the LaunchAgent's XML, and one quoted argument on a .desktop Exec line.
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
desktop_arg() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/[\\"`$]/\\&/g' -e 's/%/%%/g')"; }

printf '\n  Project Pulse installer\n\n'
case "$OS" in
  Darwin | Linux) ;;
  *) fail 'This installer is for macOS and Linux. On Windows, run Install.cmd.' ;;
esac
[ -n "${HOME:-}" ] || fail 'HOME is not set.'
PULSE_HOME="$HOME/.project-pulse"
APP="$PULSE_HOME/app"
DATA="$PULSE_HOME/data"

# 1. Node.js 22.5+ (built-in SQLite)
step 'Checking Node.js'
NODE=$(command -v node || true)
[ -n "$NODE" ] || fail 'Node.js 22.5 or newer is required. Install it from https://nodejs.org and run this again.'
NODE_VERSION=$("$NODE" --version)
"$NODE" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 5) ? 0 : 1)' ||
  fail "Node.js $NODE_VERSION is too old. Project Pulse needs 22.5 or newer."
ok "Node.js $NODE_VERSION"

# 2. Stop a running copy (update case)
step 'Stopping any running Project Pulse service'
if [ "$OS" = Darwin ]; then launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; fi
if command -v pkill >/dev/null 2>&1; then pkill -f '\.project-pulse/app/service/server\.mjs' 2>/dev/null || true; fi

# 3. Copy the app (skipped when this script already runs from the installed copy)
step "Copying the app to $APP"
mkdir -p "$APP" "$DATA/logs"
if [ "$SOURCE" != "$(cd "$APP" && pwd -P)" ]; then
  for dir in service ui plugin bin desktop-extension integrations docs test; do
    if [ -d "$SOURCE/$dir" ]; then
      rm -rf "${APP:?}/$dir"
      cp -R "$SOURCE/$dir" "$APP/$dir"
    fi
  done
  for file in README.md LICENSE package.json install.sh uninstall.sh; do
    if [ -f "$SOURCE/$file" ]; then cp "$SOURCE/$file" "$APP/"; fi
  done
fi
printf '%s\n' "$NODE" >"$APP/bin/node.txt"
chmod +x "$APP/bin/start-service.sh" "$APP/bin/open-window.sh" "$APP/install.sh" "$APP/uninstall.sh"
ok 'Copied'

# 4. Keep the data folder (token, database, logs) private to you
step 'Restricting the data folder to your account'
chmod 700 "$DATA"
ok 'Only your account can read it'

# 5. Claude Code: the mod, at user scope
CLAUDE=$(command -v claude || true)
if [ "$SKIP_CLAUDE" = 1 ]; then
  note 'Skipped Claude Code registration (--skip-claude)'
elif [ -z "$CLAUDE" ]; then
  note 'Claude Code CLI not found on PATH: install it, then run this installer again to add the mod.'
else
  step 'Backing up the Claude Code files this step changes'
  backup="$DATA/backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  for file in "$HOME/.claude/settings.json" "$HOME/.claude/plugins/known_marketplaces.json" "$HOME/.claude/plugins/installed_plugins.json"; do
    if [ -f "$file" ]; then cp "$file" "$backup/"; fi
  done
  ok "Backed up to $backup"

  step 'Adding the Project Pulse mod to Claude Code (user scope: all projects)'
  if "$CLAUDE" plugin marketplace list 2>/dev/null | grep -q 'project-pulse-local'; then
    "$CLAUDE" plugin marketplace update project-pulse-local || true
  else
    "$CLAUDE" plugin marketplace add "$APP/plugin" || true
  fi
  if "$CLAUDE" plugin install project-pulse@project-pulse-local --scope user; then
    ok 'Mod installed. New Claude Code sessions load it (run /reload-plugins in an open one).'
  else
    note 'The plugin install reported a problem; see the lines above.'
  fi
fi

# 6. Claude Desktop extension package: manifest.json and server/index.mjs at the top of a zip
step 'Building the Claude Desktop extension'
MCPB="$APP/dist/ProjectPulse.mcpb"
stage=$(mktemp -d "${TMPDIR:-/tmp}/pulse-mcpb.XXXXXX")
mkdir -p "$APP/dist" "$stage/server"
cp "$APP/desktop-extension/manifest.json" "$stage/manifest.json"
cp "$APP/plugin/mcp/server.mjs" "$stage/server/index.mjs"
rm -f "$MCPB"
if command -v zip >/dev/null 2>&1; then
  (cd "$stage" && zip -q -r "$MCPB" manifest.json server)
elif command -v python3 >/dev/null 2>&1; then
  (cd "$stage" && python3 -m zipfile -c "$MCPB" manifest.json server)
fi
rm -rf "$stage"
if [ -f "$MCPB" ]; then
  if [ "$SOURCE" != "$(cd "$APP" && pwd -P)" ]; then
    mkdir -p "$SOURCE/dist" 2>/dev/null && cp "$MCPB" "$SOURCE/dist/" 2>/dev/null || true
  fi
  ok "Built $MCPB"
else
  note 'Could not build the extension: install zip (or python3) and run this again.'
fi

# 7. Other AI tools: register the Pulse MCP server where they are installed
if [ "$NO_AGENTS" = 1 ]; then
  note 'Skipped other AI tools (--no-agents)'
else
  step 'Adding the Pulse tools to other AI tools (Codex, Cursor, Gemini CLI, Windsurf, VS Code)'
  set -- "$APP/bin/register-agents.mjs" --app "$APP" --node "$NODE" --backup "$DATA/backups/agents-$(date +%Y%m%d-%H%M%S)"
  if [ "$AGENT_INSTRUCTIONS" = 1 ]; then set -- "$@" --instructions; fi
  "$NODE" "$@" || note 'Adding the other AI tools reported a problem; see the lines above.'
fi

# 8. Start at login
step 'Starting the service when you log in'
if [ "$OS" = Darwin ]; then
  # launchd runs node itself (not the detaching shell launcher), so it tracks the real process.
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$APP/service/server.mjs")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$PATH")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$(xml "$DATA/logs/launchd.log")</string>
</dict>
</plist>
EOF
  ok "LaunchAgent: $PLIST"
else
  AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
  MENU="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$AUTOSTART" "$MENU"
  cat >"$AUTOSTART/project-pulse.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Project Pulse service
Comment=Starts the Project Pulse service when you log in
Exec=/bin/sh $(desktop_arg "$APP/bin/start-service.sh")
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
  cat >"$MENU/project-pulse.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Project Pulse
Comment=Open the Project Pulse window
Exec=/bin/sh $(desktop_arg "$APP/bin/open-window.sh")
Icon=$APP/ui/icon.svg
Terminal=false
Categories=Development;
EOF
  ok 'Autostart: service at login. App menu: "Project Pulse" opens the window.'
fi

# 9. Start the service
if [ "$NO_START" = 0 ]; then
  step 'Starting the service'
  if [ "$OS" = Darwin ]; then
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || sh "$APP/bin/start-service.sh"
  else
    sh "$APP/bin/start-service.sh"
  fi
  up=0
  tries=0
  while [ "$up" = 0 ] && [ "$tries" -lt 15 ]; do
    sleep 1
    tries=$((tries + 1))
    if "$NODE" -e 'fetch("http://127.0.0.1:47821/api/health", { signal: AbortSignal.timeout(2000) }).then(r => r.json()).then(b => process.exit(b.app === "project-pulse" ? 0 : 1), () => process.exit(1))'; then
      up=1
    fi
  done
  if [ "$up" = 1 ]; then ok 'Running on http://127.0.0.1:47821 (local only)'; else note "Not answering yet; see $DATA/logs/pulse.log"; fi
fi

printf '\n  %sDone.%s\n' "$GREEN" "$PLAIN"
echo '  - Claude Code: reviews happen automatically after finished tasks. Type /pulse for one now, /pulse open for the window.'
if [ "$OS" = Darwin ] && [ -f "$MCPB" ]; then
  echo "  - Claude Desktop: open $MCPB (or Settings > Extensions > Advanced > Install Extension) to add the Pulse tools."
fi
echo "  - Open the window any time with /pulse open, or: sh \"$APP/bin/open-window.sh\""
echo "  - Uninstall with: sh \"$APP/uninstall.sh\""
echo ''

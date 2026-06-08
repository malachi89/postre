#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
runner="$repo_root/scripts/postre-local-runner.mjs"
label="com.postre.local"
plist="$HOME/Library/LaunchAgents/$label.plist"
node_path="$(command -v node)"

if [ ! -f "$runner" ]; then
  echo "Runner not found at $runner" >&2
  exit 1
fi

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  printf '%s' "$value"
}

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$node_path")</string>
    <string>$(xml_escape "$runner")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$repo_root")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$repo_root/postre-local-runner.launchd.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$repo_root/postre-local-runner.launchd.err.log")</string>
</dict>
</plist>
PLIST

launchctl unload "$plist" >/dev/null 2>&1 || true
launchctl load "$plist"
launchctl start "$label" >/dev/null 2>&1 || true

echo "PostRE Local installed and started."
echo "Open http://localhost:5500 after the initial npm/prisma setup finishes."
echo "Logs: $repo_root/postre-local-runner.log and $repo_root/postre-local-server.log"

#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
runner="$repo_root/scripts/postre-local-runner.mjs"
label="com.postre.local"
plist="$HOME/Library/LaunchAgents/$label.plist"
node_path="$(command -v node)"

if [ -f "$plist" ]; then
  launchctl load "$plist" >/dev/null 2>&1 || true
  launchctl start "$label" >/dev/null 2>&1 || true
  echo "PostRE Local LaunchAgent started."
else
  nohup "$node_path" "$runner" >/dev/null 2>&1 &
  echo "PostRE Local runner started without installing autostart."
fi

echo "Open http://localhost:5500 after startup finishes."

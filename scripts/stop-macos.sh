#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
label="com.postre.local"
plist="$HOME/Library/LaunchAgents/$label.plist"

if [ -f "$plist" ]; then
  launchctl stop "$label" >/dev/null 2>&1 || true
  launchctl unload "$plist" >/dev/null 2>&1 || true
fi

for pid_file in "$repo_root/postre-local-server.pid" "$repo_root/postre-local-runner.pid"; do
  if [ -f "$pid_file" ]; then
    pid="$(head -n 1 "$pid_file" || true)"
    if [ -n "$pid" ]; then
      kill "-$pid" >/dev/null 2>&1 || kill "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$pid_file"
  fi
done

echo "PostRE Local stopped."

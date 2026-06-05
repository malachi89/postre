#!/usr/bin/env bash
set -euo pipefail

label="com.postre.local"
plist="$HOME/Library/LaunchAgents/$label.plist"

"$(cd "$(dirname "$0")" && pwd)/stop-macos.sh"
rm -f "$plist"

echo "PostRE Local LaunchAgent removed."

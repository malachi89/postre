#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

# Kill anything still holding port 5500 before starting
lsof -ti :5500 2>/dev/null | xargs kill -9 2>/dev/null || true

cd "$repo_root"

# Ensure production build exists
if [ ! -f ".next/BUILD_ID" ]; then
  echo "No production build found. Running npm run build..."
  npm run build
fi

echo "Starting PostRE production server..."
nohup npm run start > "$repo_root/postre-server.log" 2>&1 &

echo "PostRE Local started."
echo "Open http://localhost:5500 after startup finishes."
echo "Server logs: tail -f $repo_root/postre-server.log"

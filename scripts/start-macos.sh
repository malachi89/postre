#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

# Kill anything still holding port 5500 before starting
lsof -ti :5500 2>/dev/null | xargs kill -9 2>/dev/null || true

cd "$repo_root"
(npm run start > /dev/null 2>&1 &)

echo "PostRE Local started."
echo "Open http://localhost:5500 after startup finishes."

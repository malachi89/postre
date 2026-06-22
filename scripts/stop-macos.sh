#!/usr/bin/env bash
set -euo pipefail

# Force-kill anything on port 5500 and related processes
lsof -ti :5500 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "next.*5500" 2>/dev/null || true
pkill -f "postre-local-runner" 2>/dev/null || true

echo "PostRE Local stopped."

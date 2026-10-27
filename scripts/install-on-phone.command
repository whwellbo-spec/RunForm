#!/bin/zsh
# Double-click in Finder: test, build, sync into the iOS project, and open Xcode.
cd "$(dirname "$0")/.." || exit 1
echo "== Installing packages ==" && { [ -d node_modules/jspdf ] || npm ci --no-audit --no-fund; } && \
echo "== Testing ==" && npm test && \
echo "== Building ==" && npm run build && \
echo "== Syncing to iOS ==" && npx cap sync ios && \
echo "== Opening Xcode ==" && npx cap open ios && \
echo "\nDone. In Xcode, pick your iPhone at the top and press Run (▶)."
echo "\nPress Return to close."; read

#!/usr/bin/env bash
# Sets the date-based release version (YYYY.M.D) everywhere and increments the iOS build number.
# Apple requires dotted integers that only ever increase, so the year is part of the version; the
# app shows it with a "v" prefix. Several uploads on the same day keep the version and use
# ios/scripts/bump-build.sh instead.
# Usage: scripts/set-version.sh              # today's date, e.g. 2026.10.17
#        scripts/set-version.sh 2026.10.17
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(date +%Y.%-m.%-d)}"
[[ "$VERSION" =~ ^20[0-9]{2}\.([1-9]|1[0-2])\.([1-9]|[12][0-9]|3[01])$ ]] || {
  echo "Expected YYYY.M.D without leading zeros, e.g. 2026.10.7" >&2; exit 1; }

PBXPROJ="$ROOT/ios/AgentAnywhere.xcodeproj/project.pbxproj"
CURRENT="$(grep -oE 'MARKETING_VERSION = [^;]+;' "$PBXPROJ" | head -1 | sed -E 's/MARKETING_VERSION = (.*);/\1/')"
if [[ "$CURRENT" != "$VERSION" && "$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | tail -1)" != "$VERSION" ]]; then
  echo "Version must increase: current $CURRENT, requested $VERSION" >&2; exit 1
fi

if [[ "$CURRENT" != "$VERSION" ]]; then
  "$ROOT/ios/scripts/bump-build.sh" >/dev/null
fi
sed -i '' -E "s/MARKETING_VERSION = [^;]+;/MARKETING_VERSION = $VERSION;/" "$PBXPROJ"

# Bridge (also the Mac app's version, read by mac/scripts/build-app.sh) and the account server.
for pkg in bridge server; do
  npm --prefix "$ROOT/$pkg" version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
done
sed -i '' -E "s/export const BRIDGE_VERSION = '[^']+';/export const BRIDGE_VERSION = '$VERSION';/" "$ROOT/bridge/src/server.ts"

BUILD="$(grep -oE 'CURRENT_PROJECT_VERSION = [0-9]+;' "$PBXPROJ" | head -1 | grep -oE '[0-9]+')"
echo "AgentAnywhere v$VERSION (build $BUILD)"

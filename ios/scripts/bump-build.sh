#!/usr/bin/env bash
# Sets the iOS build number for every target (the app and its notification extension must match).
# Usage: ios/scripts/bump-build.sh          # increments the current build number
#        ios/scripts/bump-build.sh 42       # sets it to 42
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)/AgentAnywhere.xcodeproj/project.pbxproj"
current="$(grep -oE 'CURRENT_PROJECT_VERSION = [0-9]+;' "$PROJECT" | grep -oE '[0-9]+' | sort -n | tail -1)"
next="${1:-$((current + 1))}"
[[ "$next" =~ ^[1-9][0-9]*$ ]] || { echo "Build number must be a positive integer" >&2; exit 1; }
(( next > current )) || { echo "Build number must increase: current $current, requested $next" >&2; exit 1; }
sed -i '' -E "s/CURRENT_PROJECT_VERSION = [0-9]+;/CURRENT_PROJECT_VERSION = $next;/" "$PROJECT"
version="$(grep -oE 'MARKETING_VERSION = [^;]+;' "$PROJECT" | head -1 | sed -E 's/MARKETING_VERSION = (.*);/\1/')"
echo "AgentAnywhere $version ($next)"

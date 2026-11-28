#!/bin/bash
set -euo pipefail

# Pin an official Node 22 LTS release; never download "latest" at build time.
NODE_VERSION="22.23.0"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MAC="$ROOT/mac"
CACHE="$MAC/.build/node-cache/v$NODE_VERSION"
DIST="$MAC/dist"
IDENTITY="${SIGN_IDENTITY:--}"

[[ "$(uname -s)" == Darwin ]] || { echo "This script requires macOS." >&2; exit 1; }
if [[ -n "${NOTARY_PROFILE:-}" && "$IDENTITY" == - ]]; then
    echo "NOTARY_PROFILE requires SIGN_IDENTITY (Developer ID Application)." >&2
    exit 1
fi
mkdir -p "$CACHE" "$DIST" "$MAC/.build/module-cache" "$MAC/.build/swiftpm"/{config,security,cache}
export CLANG_MODULE_CACHE_PATH="$MAC/.build/module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$MAC/.build/module-cache"
SWIFT_FLAGS=(--package-path "$MAC" --disable-sandbox --cache-path "$MAC/.build/swiftpm/cache"
    --config-path "$MAC/.build/swiftpm/config" --security-path "$MAC/.build/swiftpm/security" -c release)
ARCH_FLAGS=(--arch arm64 --arch x86_64)
if ! swift build "${SWIFT_FLAGS[@]}" "${ARCH_FLAGS[@]}"; then
    echo "Universal Swift build unavailable; falling back to the host architecture." >&2
    ARCH_FLAGS=(--arch "$(uname -m)")
    swift build "${SWIFT_FLAGS[@]}" "${ARCH_FLAGS[@]}"
fi
BIN_DIR="$(swift build "${SWIFT_FLAGS[@]}" "${ARCH_FLAGS[@]}" --show-bin-path)"
npm --prefix "$ROOT/bridge" run bundle
VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$ROOT/bridge/package.json")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Expected numeric package version" >&2; exit 1; }
BUILD_NUMBER="$(node --input-type=module - "$MAC/.build/ota-last-build" "${BUILD_NUMBER:-}" "$(date -u +%Y%m%d%H%M%S)" <<'NODE'
import fs from 'node:fs';
const [state, override, timestamp] = process.argv.slice(2);
const previous = fs.existsSync(state) ? fs.readFileSync(state, 'utf8').trim() : '0';
if (!/^\d+$/.test(previous) || (override && !/^[1-9]\d*$/.test(override))) throw new Error('Invalid BUILD_NUMBER');
const next = override ? BigInt(override) : (BigInt(timestamp) > BigInt(previous) ? BigInt(timestamp) : BigInt(previous) + 1n);
if (next <= BigInt(previous)) throw new Error('BUILD_NUMBER must exceed the previous local build');
fs.writeFileSync(state, String(next) + '\n');
console.log(String(next));
NODE
)"

# Downloads are atomic. Cached archives are rechecked on EVERY build, before extraction.
# A checksum failure is fatal, never a reason to silently omit an architecture.
BASE="https://nodejs.org/dist/v$NODE_VERSION"
download() {
    local name="$1"
    if [[ ! -f "$CACHE/$name" ]]; then
        curl --fail --location --retry 3 --connect-timeout 20 "$BASE/$name" -o "$CACHE/$name.partial"
        mv "$CACHE/$name.partial" "$CACHE/$name"
    fi
}
download SHASUMS256.txt
NODE_INPUTS=()
for arch in arm64 x64; do
    archive="node-v$NODE_VERSION-darwin-$arch.tar.gz"
    download "$archive"
    checksum="$(awk -v name="$archive" '$2 == name { print $1 }' "$CACHE/SHASUMS256.txt")"
    [[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || { echo "Missing or invalid checksum for $archive" >&2; exit 1; }
    (cd "$CACHE" && echo "$checksum  $archive" | shasum -a 256 -c -)
    # Extract again from the verified archive, avoiding stale or modified cached executables.
    tar -xzf "$CACHE/$archive" -C "$CACHE" "node-v$NODE_VERSION-darwin-$arch/bin/node" "node-v$NODE_VERSION-darwin-$arch/LICENSE"
    if [[ ${#ARCH_FLAGS[@]} -eq 4 || "$arch" == "$(uname -m | sed 's/x86_64/x64/')" ]]; then
        NODE_INPUTS+=("$CACHE/node-v$NODE_VERSION-darwin-$arch/bin/node")
    fi
done

APP="$DIST/AgentAnywhere.app"
# Fixed paths inside the ignored dist directory only.
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bridge"
cp "$BIN_DIR/AgentAnywhere" "$APP/Contents/MacOS/AgentAnywhere"
if [[ ${#NODE_INPUTS[@]} -eq 2 ]]; then
    lipo -create "${NODE_INPUTS[@]}" -output "$APP/Contents/Resources/node"
else
    cp "${NODE_INPUTS[0]}" "$APP/Contents/Resources/node"
fi
chmod 755 "$APP/Contents/MacOS/AgentAnywhere" "$APP/Contents/Resources/node"
cp "$ROOT/bridge/dist/bridge.mjs" "$APP/Contents/Resources/bridge/bridge.mjs"
cp "$CACHE/node-v$NODE_VERSION-darwin-arm64/LICENSE" "$APP/Contents/Resources/Node-LICENSE.txt"
for bundle in "$BIN_DIR/"*.bundle; do
    [[ -d "$bundle" ]] && ditto "$bundle" "$APP/Contents/Resources/$(basename "$bundle")"
done
FONT_BUNDLE="$APP/Contents/Resources/AgentAnywhere_AgentAnywhereMac.bundle"
# The native SwiftPM and Xcode universal builders use different bundle layouts.
[[ -f "$FONT_BUNDLE/SpaceGrotesk.ttf" || -f "$FONT_BUNDLE/Contents/Resources/SpaceGrotesk.ttf" ]] || {
    echo "SwiftPM font resource bundle missing" >&2; exit 1;
}
ICONSET="$MAC/.build/AgentAnywhere.iconset"
mkdir -p "$ICONSET"
swift "$MAC/scripts/make-icon.swift" "$MAC/.build/AgentAnywhere-icon.png"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$MAC/.build/AgentAnywhere-icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    twice=$((size * 2))
    sips -z "$twice" "$twice" "$MAC/.build/AgentAnywhere-icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AgentAnywhere.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.deanhilarious.agentanywhere.mac</string>
<key>CFBundleName</key><string>AgentTote</string>
<key>CFBundleDisplayName</key><string>AgentTote</string>
<key>CFBundleExecutable</key><string>AgentAnywhere</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
<key>CFBundleIconFile</key><string>AgentAnywhere</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHumanReadableCopyright</key><string>Copyright © $(date +%Y) AgentTote. All rights reserved.</string>
</dict></plist>
PLIST
mkdir -p "$APP/Contents/Resources/en.lproj" "$APP/Contents/Resources/zh-Hans.lproj"
printf '"CFBundleDisplayName" = "AgentTote";\n"CFBundleName" = "AgentTote";\n' > "$APP/Contents/Resources/en.lproj/InfoPlist.strings"
printf '"CFBundleDisplayName" = "口袋智能体";\n"CFBundleName" = "口袋智能体";\n' > "$APP/Contents/Resources/zh-Hans.lproj/InfoPlist.strings"
for language in en zh-Hans; do
    cp "$ROOT/ios/AgentAnywhere/$language.lproj/Localizable.strings" "$APP/Contents/Resources/$language.lproj/"
done
plutil -insert AAUpdateFeedURL -string "${AA_UPDATE_FEED_URL:-https://agent-anywhere.nuts-claw.tech/updates/mac/latest.json}" "$APP/Contents/Info.plist"
if [[ -f "$MAC/ota-public-key.txt" ]]; then
    OTA_PUBLIC_KEY="$(node --input-type=module - "$MAC/ota-public-key.txt" <<'NODE'
import fs from 'node:fs';
const key = fs.readFileSync(process.argv[2], 'utf8').trim();
if (Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key) throw new Error('Invalid OTA public key');
console.log(key);
NODE
)"
    plutil -insert AAUpdatePublicKey -string "$OTA_PUBLIC_KEY" "$APP/Contents/Info.plist"
else
    echo "OTA public key missing; automatic updates will be disabled."
fi
plutil -lint "$APP/Contents/Info.plist"
SIGN_FLAGS=(--force --sign "$IDENTITY" --options runtime)
if [[ "$IDENTITY" != - ]]; then SIGN_FLAGS+=(--timestamp); fi
NODE_ENTITLEMENTS="$MAC/.build/node-entitlements.plist"
cp "$MAC/scripts/node-entitlements.plist" "$NODE_ENTITLEMENTS"
if [[ ${#NODE_INPUTS[@]} -eq 1 && "$(uname -m)" == arm64 ]]; then
    plutil -remove 'com\.apple\.security\.cs\.allow-unsigned-executable-memory' "$NODE_ENTITLEMENTS"
fi
codesign "${SIGN_FLAGS[@]}" --entitlements "$NODE_ENTITLEMENTS" "$APP/Contents/Resources/node"
codesign "${SIGN_FLAGS[@]}" "$APP"
codesign --verify --strict --verbose=2 "$APP/Contents/Resources/node"
codesign --verify --deep --strict --verbose=2 "$APP"
# Exercise V8 JIT and the bundled bridge under the actual signature (no dev runtime).
"$APP/Contents/Resources/node" -e 'let f = new Function("x", "return x + 1"); for (let i=0;i<100000;i++) f(i); console.log(process.version)'
"$APP/Contents/Resources/node" "$APP/Contents/Resources/bridge/bridge.mjs" --help >/dev/null

notarize() {
    local artifact="$1" result="$MAC/.build/notary-result.json"
    xcrun notarytool submit "$artifact" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json > "$result"
    cat "$result"
    local status
    status="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).status" "$result")"
    [[ "$status" == Accepted ]] || { echo "Notarization did not reach Accepted: $status" >&2; exit 1; }
}
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
    ZIP="$MAC/.build/AgentAnywhere-notarize.zip"
    ditto -c -k --keepParent "$APP" "$ZIP"
    notarize "$ZIP"
    xcrun stapler staple "$APP"
    xcrun stapler validate "$APP"
fi
STAGE="$(mktemp -d "$MAC/.build/dmg-stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/AgentAnywhere.app"
ln -s /Applications "$STAGE/Applications"
DMG="$DIST/AgentAnywhere-$VERSION.dmg"
hdiutil create -volname AgentTote -srcfolder "$STAGE" -ov -format UDZO "$DMG"
codesign "${SIGN_FLAGS[@]}" "$DMG"
codesign --verify --verbose=2 "$DMG"
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
    notarize "$DMG"
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
fi
echo "Built $APP"
echo "Built $DMG"

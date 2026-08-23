#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MACOS_ROOT="$ROOT/apps/macos"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT/build/macos}"
REPOSITORY_NODE_VERSION="$(tr -d '[:space:]' < "$ROOT/.node-version")"
ACTIVE_NODE_VERSION="$(node -p 'process.versions.node')"
NODE_VERSION="${NODE_VERSION:-$ACTIVE_NODE_VERSION}"
MCP_VERSION="$(node -p "require('$ROOT/package.json').version")"
COMPANION_VERSION="${COMPANION_VERSION:-$MCP_VERSION}"
BUILD_NUMBER="${BUILD_NUMBER:-1}"
CODESIGN_IDENTITY="${CODESIGN_IDENTITY:--}"
NODE_ENTITLEMENTS="$MACOS_ROOT/Distribution/BundledNode.entitlements"
HOST_ARCH="$(uname -m)"
ARCH="${ARCH:-$HOST_ARCH}"

if [[ ! "$REPOSITORY_NODE_VERSION" =~ ^[1-9][0-9]*(\.[0-9]+){0,2}$ ]]; then
    echo "The repository .node-version must contain a concrete major, minor, or patch release; got '$REPOSITORY_NODE_VERSION'." >&2
    exit 2
fi
if [[ ! "$NODE_VERSION" =~ ^[1-9][0-9]*\.[0-9]+\.[0-9]+$ ]]; then
    echo "The bundled Node runtime must resolve to an exact release; got '$NODE_VERSION'." >&2
    exit 2
fi
if [ "$NODE_VERSION" != "$REPOSITORY_NODE_VERSION" ] \
    && [[ "$NODE_VERSION" != "$REPOSITORY_NODE_VERSION".* ]]; then
    echo "Active Node $NODE_VERSION does not satisfy repository runtime $REPOSITORY_NODE_VERSION from .node-version." >&2
    echo "Select the repository runtime before packaging, or provide a matching exact NODE_VERSION." >&2
    exit 2
fi

if [ "$ARCH" != "$HOST_ARCH" ]; then
    echo "Cross-architecture packaging is not supported yet. Build $ARCH on a $ARCH Mac." >&2
    exit 2
fi

case "$ARCH" in
    arm64)
        NODE_ARCH="arm64"
        ;;
    x86_64)
        NODE_ARCH="x64"
        ;;
    *)
        echo "Unsupported macOS architecture: $ARCH" >&2
        exit 2
        ;;
esac

WORK_DIR="$OUTPUT_DIR/work-$ARCH"
APP="$WORK_DIR/Hypervibe.app"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
SERVER_STAGE="$WORK_DIR/server"
NODE_ARCHIVE_NAME="node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
NODE_ARCHIVE="$WORK_DIR/$NODE_ARCHIVE_NAME"
NODE_SHASUMS="$WORK_DIR/node-v$NODE_VERSION-SHASUMS256.txt"
NODE_DIR="$WORK_DIR/node-v$NODE_VERSION-darwin-$NODE_ARCH"
DMG_STAGE="$WORK_DIR/dmg"
DMG="$OUTPUT_DIR/Hypervibe-$COMPANION_VERSION-$ARCH.dmg"

rm -rf "$WORK_DIR"
mkdir -p \
    "$CONTENTS/MacOS" \
    "$RESOURCES/runtime" \
    "$RESOURCES/licenses" \
    "$RESOURCES/server" \
    "$SERVER_STAGE" \
    "$DMG_STAGE"
export CLANG_MODULE_CACHE_PATH="$WORK_DIR/module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$WORK_DIR/module-cache"
mkdir -p "$CLANG_MODULE_CACHE_PATH"

echo "Building Hypervibe MCP $MCP_VERSION"
npm run build --prefix "$ROOT"

echo "Building macOS Companion $COMPANION_VERSION ($BUILD_NUMBER)"
swift build --package-path "$MACOS_ROOT" -c release --product HypervibeCompanion
swift build --package-path "$MACOS_ROOT" -c release --product HypervibeMCPLauncher
swift build --package-path "$MACOS_ROOT" -c release --product HypervibeCompanionUpdater
SWIFT_BIN_DIR="$(swift build --package-path "$MACOS_ROOT" -c release --show-bin-path)"

echo "Downloading Node.js v$NODE_VERSION for $NODE_ARCH"
curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" \
    --output "$NODE_SHASUMS"
NODE_SHA256="$(awk -v archive="$NODE_ARCHIVE_NAME" '$2 == archive { print $1 }' "$NODE_SHASUMS")"
if [[ ! "$NODE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Node.js v$NODE_VERSION did not publish one SHA-256 digest for $NODE_ARCHIVE_NAME." >&2
    exit 2
fi
curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v$NODE_VERSION/$NODE_ARCHIVE_NAME" \
    --output "$NODE_ARCHIVE"
printf '%s  %s\n' "$NODE_SHA256" "$NODE_ARCHIVE" | shasum -a 256 --check
tar -xzf "$NODE_ARCHIVE" -C "$WORK_DIR"

echo "Installing production server dependencies with bundled Node.js"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$SERVER_STAGE/"
PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" ci \
    --omit=dev \
    --ignore-scripts=false \
    --prefix "$SERVER_STAGE"
cp -R "$ROOT/dist" "$SERVER_STAGE/dist"

cp "$SWIFT_BIN_DIR/HypervibeCompanion" "$CONTENTS/MacOS/HypervibeCompanion"
cp "$SWIFT_BIN_DIR/HypervibeMCPLauncher" "$CONTENTS/MacOS/hypervibe-mcp"
cp "$SWIFT_BIN_DIR/HypervibeCompanionUpdater" "$CONTENTS/MacOS/hypervibe-updater"
cp "$NODE_DIR/bin/node" "$RESOURCES/runtime/node"
cp "$NODE_DIR/LICENSE" "$RESOURCES/runtime/LICENSE"
cp -R "$SERVER_STAGE/dist" "$RESOURCES/server/dist"
cp -R "$SERVER_STAGE/node_modules" "$RESOURCES/server/node_modules"
cp "$SERVER_STAGE/package.json" "$SERVER_STAGE/package-lock.json" "$RESOURCES/server/"
cp "$ROOT/LICENSE" "$RESOURCES/licenses/Hypervibe-LICENSE"
cp "$MACOS_ROOT/Distribution/Info.plist" "$CONTENTS/Info.plist"

plutil -replace CFBundleShortVersionString -string "$COMPANION_VERSION" "$CONTENTS/Info.plist"
plutil -replace CFBundleVersion -string "$BUILD_NUMBER" "$CONTENTS/Info.plist"

ICONSET="$WORK_DIR/AppIcon.iconset"
swift "$MACOS_ROOT/Distribution/GenerateAppIcon.swift" "$ICONSET"
iconutil --convert icns --output "$RESOURCES/AppIcon.icns" "$ICONSET"

# Sign nested native dependencies before the executables and app bundle.
while IFS= read -r -d '' candidate; do
    if file "$candidate" | grep -q "Mach-O"; then
        if [ "$CODESIGN_IDENTITY" = "-" ]; then
            if [ "$candidate" = "$RESOURCES/runtime/node" ]; then
                codesign --force --sign - --timestamp=none \
                    --entitlements "$NODE_ENTITLEMENTS" "$candidate"
            else
                codesign --force --sign - --timestamp=none "$candidate"
            fi
        else
            if [ "$candidate" = "$RESOURCES/runtime/node" ]; then
                codesign --force --options runtime --timestamp \
                    --entitlements "$NODE_ENTITLEMENTS" \
                    --sign "$CODESIGN_IDENTITY" "$candidate"
            else
                codesign --force --options runtime --timestamp \
                    --sign "$CODESIGN_IDENTITY" "$candidate"
            fi
        fi
    fi
done < <(find "$RESOURCES" -type f -print0)

if [ "$CODESIGN_IDENTITY" = "-" ]; then
    codesign --force --sign - --timestamp=none "$CONTENTS/MacOS/hypervibe-mcp"
    codesign --force --sign - --timestamp=none "$CONTENTS/MacOS/hypervibe-updater"
    codesign --force --sign - --timestamp=none "$CONTENTS/MacOS/HypervibeCompanion"
    codesign --force --sign - --timestamp=none "$APP"
else
    codesign --force --options runtime --timestamp \
        --sign "$CODESIGN_IDENTITY" "$CONTENTS/MacOS/hypervibe-mcp"
    codesign --force --options runtime --timestamp \
        --sign "$CODESIGN_IDENTITY" "$CONTENTS/MacOS/hypervibe-updater"
    codesign --force --options runtime --timestamp \
        --sign "$CODESIGN_IDENTITY" "$CONTENTS/MacOS/HypervibeCompanion"
    codesign --force --options runtime --timestamp \
        --sign "$CODESIGN_IDENTITY" "$APP"
fi

node "$ROOT/scripts/smoke-macos-mcp.mjs" \
    "$CONTENTS/MacOS/hypervibe-mcp" \
    "$ROOT" \
    "$WORK_DIR/smoke-data"

codesign --verify --deep --strict --verbose=2 "$APP"

cp -R "$APP" "$DMG_STAGE/Hypervibe.app"
ln -s /Applications "$DMG_STAGE/Applications"
rm -f "$DMG"
hdiutil create \
    -volname "Hypervibe" \
    -srcfolder "$DMG_STAGE" \
    -ov \
    -format UDZO \
    "$DMG"

if [ "$CODESIGN_IDENTITY" != "-" ]; then
    codesign --force --timestamp --sign "$CODESIGN_IDENTITY" "$DMG"
fi

if [ -n "${NOTARY_PROFILE:-}" ]; then
    if [ "$CODESIGN_IDENTITY" = "-" ]; then
        echo "NOTARY_PROFILE requires a Developer ID CODESIGN_IDENTITY." >&2
        exit 2
    fi
    NOTARY_KEYCHAIN_ARGS=()
    if [ -n "${NOTARY_KEYCHAIN:-}" ]; then
        NOTARY_KEYCHAIN_ARGS=(--keychain "$NOTARY_KEYCHAIN")
    fi
    xcrun notarytool submit "$DMG" \
        --keychain-profile "$NOTARY_PROFILE" \
        "${NOTARY_KEYCHAIN_ARGS[@]}" \
        --wait
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
fi

echo "Created $DMG"

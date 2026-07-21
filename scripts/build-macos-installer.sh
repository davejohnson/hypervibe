#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MACOS_ROOT="$ROOT/apps/macos"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT/build/macos}"
NODE_VERSION="${NODE_VERSION:-22.17.1}"
VERSION="${VERSION:-$(node -p "require('$ROOT/package.json').version")}"
BUILD_NUMBER="${BUILD_NUMBER:-1}"
CODESIGN_IDENTITY="${CODESIGN_IDENTITY:--}"
HOST_ARCH="$(uname -m)"
ARCH="${ARCH:-$HOST_ARCH}"

if [ "$ARCH" != "$HOST_ARCH" ]; then
    echo "Cross-architecture packaging is not supported yet. Build $ARCH on a $ARCH Mac." >&2
    exit 2
fi

case "$ARCH" in
    arm64)
        NODE_ARCH="arm64"
        NODE_SHA256="a983f4f2a7b71512b78d7935b9ccf6b72120a255810070afd635c4146bca7b31"
        ;;
    x86_64)
        NODE_ARCH="x64"
        NODE_SHA256="b925103150fac0d23a44a45b2d88a01b73e5fff101e5dcfbae98d32c08d4bee3"
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
NODE_ARCHIVE="$WORK_DIR/node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
NODE_DIR="$WORK_DIR/node-v$NODE_VERSION-darwin-$NODE_ARCH"
DMG_STAGE="$WORK_DIR/dmg"
DMG="$OUTPUT_DIR/Hypervibe-$VERSION-$ARCH.dmg"

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

echo "Building Hypervibe server"
npm run build --prefix "$ROOT"

echo "Building macOS companion"
swift build --package-path "$MACOS_ROOT" -c release --product HypervibeCompanion
swift build --package-path "$MACOS_ROOT" -c release --product HypervibeMCPLauncher
SWIFT_BIN_DIR="$(swift build --package-path "$MACOS_ROOT" -c release --show-bin-path)"

echo "Downloading Node.js v$NODE_VERSION for $NODE_ARCH"
curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz" \
    --output "$NODE_ARCHIVE"
echo "$NODE_SHA256  $NODE_ARCHIVE" | shasum -a 256 --check
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
cp "$NODE_DIR/bin/node" "$RESOURCES/runtime/node"
cp "$NODE_DIR/LICENSE" "$RESOURCES/runtime/LICENSE"
cp -R "$SERVER_STAGE/dist" "$RESOURCES/server/dist"
cp -R "$SERVER_STAGE/node_modules" "$RESOURCES/server/node_modules"
cp "$SERVER_STAGE/package.json" "$SERVER_STAGE/package-lock.json" "$RESOURCES/server/"
cp "$ROOT/LICENSE" "$RESOURCES/licenses/Hypervibe-LICENSE"
cp "$MACOS_ROOT/Distribution/Info.plist" "$CONTENTS/Info.plist"

plutil -replace CFBundleShortVersionString -string "$VERSION" "$CONTENTS/Info.plist"
plutil -replace CFBundleVersion -string "$BUILD_NUMBER" "$CONTENTS/Info.plist"

ICONSET="$WORK_DIR/AppIcon.iconset"
swift "$MACOS_ROOT/Distribution/GenerateAppIcon.swift" "$ICONSET"
iconutil --convert icns --output "$RESOURCES/AppIcon.icns" "$ICONSET"

# Sign nested native dependencies before the executables and app bundle.
while IFS= read -r -d '' candidate; do
    if file "$candidate" | grep -q "Mach-O"; then
        if [ "$CODESIGN_IDENTITY" = "-" ]; then
            codesign --force --sign - --timestamp=none "$candidate"
        else
            codesign --force --options runtime --timestamp \
                --sign "$CODESIGN_IDENTITY" "$candidate"
        fi
    fi
done < <(find "$RESOURCES" -type f -print0)

if [ "$CODESIGN_IDENTITY" = "-" ]; then
    codesign --force --sign - --timestamp=none "$CONTENTS/MacOS/hypervibe-mcp"
    codesign --force --sign - --timestamp=none "$CONTENTS/MacOS/HypervibeCompanion"
    codesign --force --sign - --timestamp=none "$APP"
else
    codesign --force --options runtime --timestamp \
        --sign "$CODESIGN_IDENTITY" "$CONTENTS/MacOS/hypervibe-mcp"
    codesign --force --options runtime --timestamp \
        --sign "$CODESIGN_IDENTITY" "$CONTENTS/MacOS/HypervibeCompanion"
    codesign --force --options runtime --timestamp \
        --sign "$CODESIGN_IDENTITY" "$APP"
fi

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
    xcrun notarytool submit "$DMG" \
        --keychain-profile "$NOTARY_PROFILE" \
        --wait
    xcrun stapler staple "$DMG"
fi

echo "Created $DMG"

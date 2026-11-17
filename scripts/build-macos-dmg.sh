#!/bin/bash

# Packages a built Hypervibe.app into a drag-to-Applications disk image whose
# window shows the app, an arrow and an outlined Applications drop target.
#
# usage: build-macos-dmg.sh <Hypervibe.app> <output.dmg> <work-directory>

set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "usage: build-macos-dmg.sh <Hypervibe.app> <output.dmg> <work-directory>" >&2
    exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$1"
DMG="$2"
WORK_DIR="$3"
STAGE="$WORK_DIR/dmg"
BACKGROUND_DIR="$WORK_DIR/dmg-background"
WRITABLE_DMG="$WORK_DIR/layout.dmg"
MOUNT_DEVICE=""

detach() {
    if [ -n "$MOUNT_DEVICE" ]; then
        hdiutil detach "$MOUNT_DEVICE" >/dev/null 2>&1 \
            || hdiutil detach -force "$MOUNT_DEVICE" >/dev/null 2>&1 \
            || true
        MOUNT_DEVICE=""
    fi
}
trap detach EXIT

rm -rf "$STAGE" "$BACKGROUND_DIR" "$WRITABLE_DMG" "$DMG"
mkdir -p "$STAGE/.background"

cp -R "$APP" "$STAGE/Hypervibe.app"
ln -s /Applications "$STAGE/Applications"

swift "$ROOT/apps/macos/Distribution/GenerateInstallerBackground.swift" "$BACKGROUND_DIR"
tiffutil -cathidpicheck \
    "$BACKGROUND_DIR/background.png" \
    "$BACKGROUND_DIR/background@2x.png" \
    -out "$STAGE/.background/background.tiff" >/dev/null 2>&1

# Finder stores the window layout on the volume, so it has to be written to a
# mounted read-write image before compressing.
hdiutil create \
    -volname "Hypervibe" \
    -srcfolder "$STAGE" \
    -fs HFS+ \
    -format UDRW \
    -ov \
    "$WRITABLE_DMG" >/dev/null

ATTACH_OUTPUT="$(hdiutil attach -readwrite -noverify -noautoopen "$WRITABLE_DMG")"
MOUNT_DEVICE="$(printf '%s\n' "$ATTACH_OUTPUT" | awk 'NR==1 {print $1}')"
MOUNT_POINT="$(printf '%s\n' "$ATTACH_OUTPUT" | sed -n 's|^.*\(/Volumes/.*\)$|\1|p' | tail -1)"
if [ -z "$MOUNT_DEVICE" ] || [ ! -d "$MOUNT_POINT" ]; then
    echo "Could not mount the installer image to arrange its window." >&2
    exit 1
fi

# The volume is addressed by path, not name: another mounted Hypervibe image
# shares the name and macOS mounts this one as "Hypervibe 1". Window bounds
# are {left, top, right, bottom} including a 28 point title bar; icon
# positions match GenerateInstallerBackground.swift.
if ! osascript - "$MOUNT_POINT" <<'APPLESCRIPT'
on run arguments
    set volumeAlias to POSIX file (item 1 of arguments) as alias
    tell application "Finder"
        -- Finder can take a few seconds to notice a newly mounted volume.
        set installerVolume to missing value
        repeat 40 times
            try
                set installerVolume to container volumeAlias
                exit repeat
            on error
                delay 0.5
            end try
        end repeat
        if installerVolume is missing value then error "Finder did not show the mounted installer volume."
        open installerVolume
        set installerWindow to container window of installerVolume
        set current view of installerWindow to icon view
        set toolbar visible of installerWindow to false
        set statusbar visible of installerWindow to false
        set bounds of installerWindow to {200, 160, 740, 568}
        set viewOptions to icon view options of installerWindow
        set arrangement of viewOptions to not arranged
        set icon size of viewOptions to 112
        set text size of viewOptions to 13
        set background picture of viewOptions to file ".background:background.tiff" of installerVolume
        set position of item "Hypervibe.app" of installerVolume to {150, 200}
        set position of item "Applications" of installerVolume to {390, 200}
        update installerVolume without registering applications
        delay 1
        close installerWindow
    end tell
end run
APPLESCRIPT
then
    echo "Finder could not arrange the installer window. If macOS blocked it, allow this terminal to control Finder under System Settings > Privacy & Security > Automation, then build again." >&2
    exit 1
fi

sync
if [ ! -s "$MOUNT_POINT/.DS_Store" ]; then
    echo "Finder did not save the installer window layout." >&2
    exit 1
fi
rm -rf "$MOUNT_POINT/.fseventsd"
detach

hdiutil convert "$WRITABLE_DMG" -format UDZO -ov -o "$DMG" >/dev/null
rm -f "$WRITABLE_DMG"

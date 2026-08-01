#!/bin/bash

set -euo pipefail

required_variables=(
    MACOS_CERTIFICATE_P12_BASE64
    MACOS_CERTIFICATE_PASSWORD
    APP_STORE_CONNECT_KEY_ID
    APP_STORE_CONNECT_ISSUER_ID
    APP_STORE_CONNECT_PRIVATE_KEY
    GITHUB_ENV
    RUNNER_TEMP
)
missing_variables=()
for variable in "${required_variables[@]}"; do
    if [ -z "${!variable:-}" ]; then
        missing_variables+=("$variable")
    fi
done
if [ "${#missing_variables[@]}" -gt 0 ]; then
    echo "Missing required macOS release signing input(s): ${missing_variables[*]}" >&2
    exit 2
fi

CODESIGN_IDENTITY="${CODESIGN_IDENTITY:-Developer ID Application: David Johnson (4AW333LW3U)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-hypervibe-notary}"
KEYCHAIN_PATH="$RUNNER_TEMP/hypervibe-signing.keychain-db"
CERTIFICATE_PATH="$RUNNER_TEMP/hypervibe-developer-id.p12"
PRIVATE_KEY_PATH="$RUNNER_TEMP/AuthKey_${APP_STORE_CONNECT_KEY_ID}.p8"
KEYCHAIN_PASSWORD="$(openssl rand -hex 24)"

cleanup_on_error() {
    security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
    rm -f "$CERTIFICATE_PATH" "$PRIVATE_KEY_PATH" "$KEYCHAIN_PATH"
}
trap cleanup_on_error ERR

security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
rm -f "$CERTIFICATE_PATH" "$PRIVATE_KEY_PATH" "$KEYCHAIN_PATH"

printf '%s' "$MACOS_CERTIFICATE_P12_BASE64" | base64 --decode > "$CERTIFICATE_PATH"
printf '%s' "$APP_STORE_CONNECT_PRIVATE_KEY" > "$PRIVATE_KEY_PATH"
chmod 600 "$CERTIFICATE_PATH" "$PRIVATE_KEY_PATH"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security import "$CERTIFICATE_PATH" \
    -k "$KEYCHAIN_PATH" \
    -P "$MACOS_CERTIFICATE_PASSWORD" \
    -T /usr/bin/codesign \
    -t cert \
    -f pkcs12
security set-key-partition-list \
    -S apple-tool:,apple: \
    -s \
    -k "$KEYCHAIN_PASSWORD" \
    "$KEYCHAIN_PATH" >/dev/null
security list-keychains -d user -s "$KEYCHAIN_PATH"

if ! security find-identity -v -p codesigning "$KEYCHAIN_PATH" | grep -Fq "$CODESIGN_IDENTITY"; then
    echo "The imported PKCS#12 does not contain the expected Developer ID Application identity." >&2
    exit 2
fi

xcrun notarytool store-credentials "$NOTARY_PROFILE" \
    --key "$PRIVATE_KEY_PATH" \
    --key-id "$APP_STORE_CONNECT_KEY_ID" \
    --issuer "$APP_STORE_CONNECT_ISSUER_ID" \
    --keychain "$KEYCHAIN_PATH" \
    --validate

{
    echo "CODESIGN_IDENTITY=$CODESIGN_IDENTITY"
    echo "NOTARY_PROFILE=$NOTARY_PROFILE"
    echo "NOTARY_KEYCHAIN=$KEYCHAIN_PATH"
} >> "$GITHUB_ENV"

trap - ERR
echo "Configured ephemeral Developer ID signing and notarization credentials."

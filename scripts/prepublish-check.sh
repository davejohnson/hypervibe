#!/usr/bin/env bash
set -euo pipefail

echo "Running prepublish safety checks..."
echo

# Capture npm pack dry-run output
PACK_OUTPUT=$(npm pack --dry-run 2>&1)

# Check for sensitive files
SENSITIVE_PATTERNS='\.db$|\.secret-key$|\.env$|\.env\.'
if echo "$PACK_OUTPUT" | grep -qE "$SENSITIVE_PATTERNS"; then
  echo "FAIL: Sensitive files would be included in the package:"
  echo "$PACK_OUTPUT" | grep -E "$SENSITIVE_PATTERNS"
  exit 1
fi

# Check dist/ files for hardcoded secrets (actual key values, not prefix references)
# Match keys with sufficient length to be real secrets, not just prefix checks like startsWith('sk_test_')
SECRET_PATTERNS='sk_live_[a-zA-Z0-9]{10,}|sk_test_[a-zA-Z0-9]{10,}|pk_live_[a-zA-Z0-9]{10,}|pk_test_[a-zA-Z0-9]{10,}|AKIA[A-Z0-9]{16,}|ghp_[a-zA-Z0-9]{30,}|whsec_[a-zA-Z0-9]{10,}'
if [ -d dist ]; then
  FOUND=$(grep -rlE "$SECRET_PATTERNS" dist/ 2>/dev/null || true)
  if [ -n "$FOUND" ]; then
    echo "FAIL: Hardcoded secrets found in dist/ files:"
    echo "$FOUND"
    grep -rnE "$SECRET_PATTERNS" dist/ 2>/dev/null | head -20
    exit 1
  fi
fi

FLY_HELPER_TARGETS=(
  "darwin-x64/hypervibe-fly-wireguard"
  "darwin-arm64/hypervibe-fly-wireguard"
  "linux-x64/hypervibe-fly-wireguard"
  "linux-arm64/hypervibe-fly-wireguard"
  "win32-x64/hypervibe-fly-wireguard.exe"
  "win32-arm64/hypervibe-fly-wireguard.exe"
)
for helper in "${FLY_HELPER_TARGETS[@]}"; do
  if [ ! -f "dist/native/fly-wireguard/$helper" ]; then
    echo "FAIL: Missing Fly.io WireGuard helper target: $helper"
    exit 1
  fi
done
for license in \
  coder-websocket-LICENSE \
  google-btree-LICENSE \
  golang-x-crypto-LICENSE \
  golang-x-net-LICENSE \
  golang-x-sys-LICENSE \
  golang-x-time-LICENSE \
  wireguard-go-LICENSE \
  wintun-LICENSE \
  gvisor-LICENSE; do
  if [ ! -f "dist/native/fly-wireguard/licenses/$license" ]; then
    echo "FAIL: Missing Fly.io WireGuard helper license: $license"
    exit 1
  fi
done

# Print summary
FILE_COUNT=$(echo "$PACK_OUTPUT" | grep -cE '^\d|^npm' | head -1 || true)
TOTAL_LINE=$(echo "$PACK_OUTPUT" | tail -1)
echo "OK: No sensitive files or hardcoded secrets detected."
echo
echo "Package contents:"
echo "$PACK_OUTPUT" | tail -5
echo
echo "Prepublish check passed."

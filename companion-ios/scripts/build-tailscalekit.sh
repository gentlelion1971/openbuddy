#!/bin/bash
# build-tailscalekit.sh
# Builds TailscaleKit.xcframework from source and places it in ThirdParty/.
#
# TailscaleKit is the official Swift framework wrapping libtailscale
# (tailscale/libtailscale, swift/TailscaleKit/). It is NOT available as a
# Swift Package, so it must be built from source with Go, the same way
# Tailscale's own Aperture sample app does it (see the libtailscale repo,
# swift/Examples/TailscaleKitHello/ and its Makefile).
#
# Requirements (on the Mac):
#   - Go (https://go.dev/dl/ or `brew install go`)
#   - Xcode 16.2 or later (xcodebuild must be on PATH)
#
# Usage:
#   ./scripts/build-tailscalekit.sh
#
# The script clones libtailscale (shallow), runs `make ios-fat`, and copies
# the resulting TailscaleKit.xcframework into ThirdParty/. The clone is kept
# in ThirdParty/libtailscale-src so the TailscaleKitHello example stays
# available for reference. Re-running the script rebuilds from a fresh clone.
#
# The Swift code in this app was verified against libtailscale commit
# d1dc45d0 (2026-11-22). If the build breaks against a newer main, check out
# that commit in ThirdParty/libtailscale-src and re-run `make ios-fat` there.
# (The build script does not pin a commit by default, so a newer TailscaleKit
# is picked up when the APIs used here have not changed.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
THIRDPARTY="$ROOT/ThirdParty"
SRC="$THIRDPARTY/libtailscale-src"
OUT="$THIRDPARTY/TailscaleKit.xcframework"

command -v go >/dev/null 2>&1 || {
  echo "error: Go is not installed. Install it from https://go.dev/dl/ (or 'brew install go') and re-run this script." >&2
  exit 1
}
command -v xcodebuild >/dev/null 2>&1 || {
  echo "error: xcodebuild is not on PATH. Install Xcode 16.2+ from the App Store, run it once, then re-run this script." >&2
  exit 1
}
command -v git >/dev/null 2>&1 || {
  echo "error: git is not installed." >&2
  exit 1
}

echo "Cloning libtailscale into $SRC ..."
rm -rf "$SRC"
git clone --depth 1 https://github.com/tailscale/libtailscale.git "$SRC"

cd "$SRC"
COMMIT="$(git rev-parse HEAD)"
echo "libtailscale commit: $COMMIT"

echo "Building TailscaleKit.xcframework (make ios-fat; this downloads the Go toolchain modules and takes a few minutes)..."
make ios-fat

# The Makefile places the framework under the repo; find it wherever it lands.
BUILT="$(find "$SRC" -name 'TailscaleKit.xcframework' -maxdepth 4 -type d | head -n 1)"
if [ -z "$BUILT" ]; then
  echo "error: TailscaleKit.xcframework was not produced by 'make ios-fat'." >&2
  echo "Check the Makefile targets in $SRC (swift/Makefile) — the target name may have changed — then re-run." >&2
  exit 1
fi

rm -rf "$OUT"
cp -R "$BUILT" "$OUT"
echo "$COMMIT" > "$THIRDPARTY/TAILSCALEKIT_VERSION"
echo "Copied $BUILT to $OUT"
echo "Done. Open LocalAgentCompanion.xcodeproj in Xcode and build."

#!/bin/sh
# Build the native sworm-setup installers into install/dist/.
#
#   macOS:   clang (xcode command line tools)
#   windows: x86_64-w64-mingw32-gcc (brew install mingw-w64)
#   linux:   gcc, only when building on linux
#
# Every build uses -Os and gets stripped, and the code links against
# system libraries only, so each binary lands in the tens of KB.
# The script prints the sizes at the end so you can check.
#
# Missing toolchains are skipped with a note, not an error.

set -u

cd "$(dirname "$0")"
OUT=dist
mkdir -p "$OUT"

build_macos() {
  if ! command -v clang >/dev/null 2>&1; then
    echo "skip macos: clang not found (install the xcode command line tools)"
    return
  fi
  if ! clang -Os -Wall -Wextra -o "$OUT/sworm-setup-macos" sworm-setup.c; then
    # Some machines have a command line tools SDK newer than the active
    # clang, and linking fails with a tapi error. Retry against the
    # newest SDK inside Xcode.app, which matches its clang.
    XSDK=$(ls -d /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX*.sdk 2>/dev/null | sort -V | tail -1)
    if [ -z "$XSDK" ]; then
      echo "fail macos: clang could not build, see the error above"
      return
    fi
    echo "retrying macos build with -isysroot $XSDK"
    clang -Os -Wall -Wextra -isysroot "$XSDK" \
      -o "$OUT/sworm-setup-macos" sworm-setup.c || return
  fi
  strip "$OUT/sworm-setup-macos" 2>/dev/null || true
  echo "built $OUT/sworm-setup-macos"
}

build_windows() {
  if ! command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      echo "mingw-w64 not found, trying: brew install mingw-w64"
      brew install mingw-w64 || true
    fi
  fi
  if ! command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
    echo "skip windows: x86_64-w64-mingw32-gcc not available"
    return
  fi
  x86_64-w64-mingw32-gcc -Os -Wall -Wextra -o "$OUT/sworm-setup-windows.exe" \
    sworm-setup.c -lwininet || return
  x86_64-w64-mingw32-strip "$OUT/sworm-setup-windows.exe" 2>/dev/null || true
  echo "built $OUT/sworm-setup-windows.exe"
}

build_linux() {
  if [ "$(uname -s)" != "Linux" ]; then
    echo "skip linux: build on a linux machine or in docker for this one"
    return
  fi
  if ! command -v gcc >/dev/null 2>&1; then
    echo "skip linux: gcc not found"
    return
  fi
  gcc -Os -Wall -Wextra -o "$OUT/sworm-setup-linux" sworm-setup.c || return
  strip "$OUT/sworm-setup-linux" 2>/dev/null || true
  echo "built $OUT/sworm-setup-linux"
}

build_macos
build_windows
build_linux

echo
ls -la "$OUT"

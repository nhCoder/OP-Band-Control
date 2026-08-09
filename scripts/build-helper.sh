#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

SDK_ROOT=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}
if [ -z "$SDK_ROOT" ] && [ -d "$HOME/Library/Android/sdk" ]; then
    SDK_ROOT="$HOME/Library/Android/sdk"
fi
if [ -z "$SDK_ROOT" ]; then
    printf '%s\n' 'error: set ANDROID_SDK_ROOT (Android SDK platform 35 is required)' >&2
    exit 1
fi

ANDROID_JAR="$SDK_ROOT/platforms/android-35/android.jar"
D8="$SDK_ROOT/build-tools/35.0.0/d8"
if [ ! -f "$ANDROID_JAR" ]; then
    printf 'error: missing %s\n' "$ANDROID_JAR" >&2
    exit 1
fi
if [ ! -x "$D8" ]; then
    printf 'error: missing executable %s\n' "$D8" >&2
    exit 1
fi
if ! command -v javac >/dev/null 2>&1 || ! command -v jar >/dev/null 2>&1; then
    printf '%s\n' 'error: JDK javac and jar are required' >&2
    exit 1
fi

BUILD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opband-helper.XXXXXX")
cleanup() {
    rm -rf "$BUILD_DIR"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$BUILD_DIR/classes" "$BUILD_DIR/dex" "$PROJECT_DIR/bin"

(
    CDPATH= cd -- "$PROJECT_DIR"
    # Paths below are relative and source file names are deliberately space-free.
    # shellcheck disable=SC2046
    javac \
        -encoding UTF-8 \
        -source 8 \
        -target 8 \
        -Xlint:all,-options \
        -classpath "$ANDROID_JAR" \
        -d "$BUILD_DIR/classes" \
        $(find helper-src -type f -name '*.java' -print | sort)
)

(
    CDPATH= cd -- "$BUILD_DIR/classes"
    # shellcheck disable=SC2046
    "$D8" \
        --min-api 31 \
        --release \
        --output "$BUILD_DIR/dex" \
        $(find . -type f -name '*.class' -print | sort)
)

rm -f "$PROJECT_DIR/bin/opband.jar"
(CDPATH= cd -- "$BUILD_DIR/dex" && jar cf "$PROJECT_DIR/bin/opband.jar" classes.dex)
chmod 0644 "$PROJECT_DIR/bin/opband.jar"
printf 'built %s\n' "$PROJECT_DIR/bin/opband.jar"

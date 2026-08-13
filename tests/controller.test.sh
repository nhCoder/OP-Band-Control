#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opband-controller-test.XXXXXX")
cleanup() {
    rm -rf "$STATE_DIR"
}
trap cleanup EXIT HUP INT TERM

CONTROL="$ROOT_DIR/bin/control.sh"
STUB="$ROOT_DIR/tests/fixtures/app_process_stub.sh"
FLOCK_STUB="$ROOT_DIR/tests/fixtures/flock_compat_stub.sh"
STUB_LOG="$STATE_DIR/helper-calls.log"
chmod 0755 "$STUB"
chmod 0755 "$FLOCK_STUB"
: > "$STUB_LOG"

run_control() {
    OPBAND_STATE_DIR="$STATE_DIR" OPBAND_APP_PROCESS="$STUB" \
        OPBAND_STUB_LOG="$STUB_LOG" sh "$CONTROL" "$@"
}

run_control_mkdir() {
    OPBAND_STATE_DIR="$STATE_DIR" OPBAND_APP_PROCESS="$STUB" \
        OPBAND_STUB_LOG="$STUB_LOG" \
        OPBAND_LOCK_BACKEND=mkdir OPBAND_LOCK_WAIT_SECONDS=2 \
        sh "$CONTROL" "$@"
}

expect_failure() {
    expected_code=$1
    expected_text=$2
    shift 2
    output_file="$STATE_DIR/output"
    set +e
    run_control "$@" > "$output_file"
    status=$?
    set -e
    [ "$status" -eq "$expected_code" ] || {
        printf 'expected exit %s, got %s for: %s\n' "$expected_code" "$status" "$*" >&2
        exit 1
    }
    grep -q "$expected_text" "$output_file" || {
        printf 'missing %s in failure for: %s\n' "$expected_text" "$*" >&2
        exit 1
    }
}

expect_failure 65 UNSAFE_SUPPLEMENTAL_ONLY apply 1 32 - custom
expect_failure 65 UNSAFE_SUPPLEMENTAL_ONLY apply 1 29,67,69 - custom
expect_failure 65 UNSAFE_SUPPLEMENTAL_ONLY apply 1 - 75 custom
expect_failure 65 UNSAFE_SUPPLEMENTAL_ONLY apply 1 - 29,76 custom
expect_failure 65 UNSAFE_SUPPLEMENTAL_ONLY apply 1 - 80 custom
expect_failure 65 UNSAFE_SUPPLEMENTAL_ONLY apply 1 - 81,82,83,84,86,89,95 custom
expect_failure 65 UNSAFE_SUPPLEMENTAL_ONLY apply 1 - 75,80 custom
expect_failure 65 INVALID_PROFILE_SELECTION apply 1 - 78 nsa
expect_failure 65 INVALID_PROFILE_SELECTION apply 1 - 261 nsa
expect_failure 65 INVALID_PROFILE_SELECTION apply 1 3 75 nsa
expect_failure 65 INVALID_PROFILE_SELECTION apply 1 3 80 nsa
expect_failure 65 INVALID_PROFILE_SELECTION apply 1 88 - nsa
expect_failure 65 INVALID_BANDS apply 1 1,1 - custom
expect_failure 65 INVALID_BANDS apply 1 15 - custom
expect_failure 65 INVALID_BANDS apply 1 - 259 custom
expect_failure 64 UNKNOWN_COMMAND unsupported

# A malformed successful-looking helper response must fail closed instead of
# exiting zero or attempting a radio mutation.
: > "$STUB_LOG"
output_file="$STATE_DIR/malformed-output"
set +e
OPBAND_STATE_DIR="$STATE_DIR" OPBAND_APP_PROCESS="$STUB" \
    OPBAND_STUB_LOG="$STUB_LOG" OPBAND_STUB_SELECTION_MODE=malformed \
    sh "$CONTROL" reset 1 > "$output_file"
status=$?
set -e
[ "$status" -eq 70 ]
grep -q '"code":"INVALID_BACKEND_RESPONSE"' "$output_file"
! grep -q '^reset ' "$STUB_LOG"

run_control status 1 | grep -q '"ok":true'
: > "$STUB_LOG"
run_control reset 1 | grep -q '"operation":"reset"'
run_control reset 1 | grep -q '"changed":false,"noOp":true'
! grep -q '^reset ' "$STUB_LOG"
run_control settings | grep -q '"profile":"adaptive"'
run_control settings | grep -q '"reapply":false'

# A restricted selection still performs exactly one helper reset and reports a
# real change. The no-op guard applies only to a confirmed automatic selection.
: > "$STUB_LOG"
OPBAND_STATE_DIR="$STATE_DIR" OPBAND_APP_PROCESS="$STUB" \
    OPBAND_STUB_LOG="$STUB_LOG" OPBAND_STUB_SELECTION_MODE=restricted \
    sh "$CONTROL" reset 1 | grep -q '"changed":true,"noOp":false'
[ "$(grep -c '^reset 1$' "$STUB_LOG")" -eq 1 ]

# A legacy WebUI may still submit the old lte-plus band restriction. It must be
# converted to a reset so guessed bands cannot suppress a valid CA combination.
: > "$STUB_LOG"
run_control apply 1 1,3 - lte-plus | grep -q '"operation":"reset"'
run_control apply 1 - - lte-plus | grep -q '"operation":"reset"'
! grep -q '^reset ' "$STUB_LOG"
run_control settings | grep -q '"profile":"lte-plus"'
run_control settings | grep -q '"applied":false'
run_control settings | grep -q '"reapply":false'

# An automatic SIM must not overwrite a confirmed restriction tracked for the
# other SIM merely because LTE+ safeguard is a no-op on the selected SIM.
printf '%s\n' custom > "$STATE_DIR/config/profile"
printf '%s\n' 40 > "$STATE_DIR/config/lte"
printf '%s\n' - > "$STATE_DIR/config/nr"
printf '%s\n' true > "$STATE_DIR/config/applied"
printf '%s\n' true > "$STATE_DIR/config/reapply"
printf '%s\n' 2 > "$STATE_DIR/config/sub_id"
: > "$STUB_LOG"
run_control apply 1 - - lte-plus | grep -q '"settingsPreservedForSubId":2'
! grep -q '^reset ' "$STUB_LOG"
run_control settings | grep -q '"profile":"custom"'
run_control settings | grep -q '"lte":\[40\]'
run_control settings | grep -q '"applied":true'
run_control settings | grep -q '"reapply":true'
run_control settings | grep -q '"subId":2'

# Return to an unconfigured state for the ownership checks below.
printf '%s\n' lte-plus > "$STATE_DIR/config/profile"
printf '%s\n' - > "$STATE_DIR/config/lte"
printf '%s\n' - > "$STATE_DIR/config/nr"
printf '%s\n' false > "$STATE_DIR/config/applied"
printf '%s\n' false > "$STATE_DIR/config/reapply"
printf '%s\n' 1 > "$STATE_DIR/config/sub_id"

# LTE+ must not erase a non-automatic OEM, carrier, or third-party selection
# that this module cannot prove it owns.
: > "$STUB_LOG"
output_file="$STATE_DIR/unowned-output"
set +e
OPBAND_STATE_DIR="$STATE_DIR" OPBAND_APP_PROCESS="$STUB" \
    OPBAND_STUB_LOG="$STUB_LOG" OPBAND_STUB_SELECTION_MODE=restricted \
    sh "$CONTROL" apply 1 1,3 - lte-plus > "$output_file"
status=$?
set -e
[ "$status" -eq 65 ]
grep -q '"code":"UNOWNED_SELECTION"' "$output_file"
! grep -q '^reset ' "$STUB_LOG"

# If this module genuinely owns the active restriction on the same SIM, the
# safeguard performs one reset and retains its selected profile.
printf '%s\n' custom > "$STATE_DIR/config/profile"
printf '%s\n' 1,3 > "$STATE_DIR/config/lte"
printf '%s\n' - > "$STATE_DIR/config/nr"
printf '%s\n' true > "$STATE_DIR/config/applied"
printf '%s\n' true > "$STATE_DIR/config/reapply"
printf '%s\n' 1 > "$STATE_DIR/config/sub_id"
OPBAND_STATE_DIR="$STATE_DIR" OPBAND_APP_PROCESS="$STUB" \
    OPBAND_STUB_LOG="$STUB_LOG" OPBAND_STUB_SELECTION_MODE=restricted \
    sh "$CONTROL" apply 1 1,3 - lte-plus | grep -q '"profile":"lte-plus"'
[ "$(grep -c '^reset 1$' "$STUB_LOG")" -eq 1 ]
run_control settings | grep -q '"profile":"lte-plus"'
run_control settings | grep -q '"reapply":false'

# Upgrades must not reapply a confirmed restriction saved by the former LTE+
# implementation. The first opted-in boot run clears it and disables reapply.
printf '%s\n' lte-plus > "$STATE_DIR/config/profile"
printf '%s\n' 1,3 > "$STATE_DIR/config/lte"
printf '%s\n' - > "$STATE_DIR/config/nr"
printf '%s\n' true > "$STATE_DIR/config/applied"
printf '%s\n' true > "$STATE_DIR/config/reapply"
printf '%s\n' 1 > "$STATE_DIR/config/sub_id"
OPBAND_INTERNAL=1 run_control __boot-reapply | grep -q '"operation":"reset"'
run_control settings | grep -q '"profile":"adaptive"'
run_control settings | grep -q '"reapply":false'
run_control settings | grep -q '"applied":false'

# Android toybox supports non-blocking flock but not util-linux's `flock -w`.
# A compatibility stub makes the old implementation fail and the polling
# implementation succeed even on hosts that do not ship flock.
mkdir "$STATE_DIR/flock-bin"
ln -s "$FLOCK_STUB" "$STATE_DIR/flock-bin/flock"
PATH="$STATE_DIR/flock-bin:$PATH" OPBAND_STATE_DIR="$STATE_DIR" \
    OPBAND_APP_PROCESS="$STUB" OPBAND_LOCK_BACKEND=flock \
    OPBAND_LOCK_WAIT_SECONDS=0 sh "$CONTROL" reset 1 \
    | grep -q '"operation":"reset"'

# The mkdir fallback must recover abandoned legacy and malformed locks instead
# of reporting BUSY forever after a killed process or interrupted lock write.
mkdir "$STATE_DIR/control.lock.d"
printf '%s\n' 999999 > "$STATE_DIR/control.lock.d/pid"
run_control_mkdir reset 1 | grep -q '"operation":"reset"'
[ ! -d "$STATE_DIR/control.lock.d" ]

mkdir "$STATE_DIR/control.lock.d"
printf '%s\n' invalid > "$STATE_DIR/control.lock.d/pid"
run_control_mkdir reset 1 | grep -q '"operation":"reset"'
[ ! -d "$STATE_DIR/control.lock.d" ]

# A positively live owner is never reaped merely because another request asks
# for the lock.
mkdir "$STATE_DIR/control.lock.d"
printf '%s 0\n' "$$" > "$STATE_DIR/control.lock.d/owner"
printf '%s\n' "$$" > "$STATE_DIR/control.lock.d/pid"
output_file="$STATE_DIR/live-lock-output"
set +e
OPBAND_STATE_DIR="$STATE_DIR" OPBAND_APP_PROCESS="$STUB" \
    OPBAND_LOCK_BACKEND=mkdir OPBAND_LOCK_WAIT_SECONDS=0 \
    sh "$CONTROL" reset 1 > "$output_file"
status=$?
set -e
[ "$status" -eq 75 ]
grep -q '"code":"BUSY"' "$output_file"
[ -d "$STATE_DIR/control.lock.d" ]
rm -f "$STATE_DIR/control.lock.d/owner" "$STATE_DIR/control.lock.d/pid"
rmdir "$STATE_DIR/control.lock.d"

printf '%s\n' 'Controller validation tests passed.'

#!/system/bin/sh

MODDIR=${0%/*}
CONTROL="$MODDIR/bin/control.sh"

if [ ! -x "$CONTROL" ]; then
    printf '%s\n' '{"ok":false,"error":{"code":"CONTROLLER_MISSING","message":"Controller is not executable"}}'
    exit 69
fi

# KernelSU's module action is the emergency escape hatch. If a guarded change is
# pending, roll it back first so the normal reset cannot be blocked by the
# watchdog state; then restore Android's automatic channel selection.
settings=$("$CONTROL" settings 2>/dev/null) || settings=
pending=$(printf '%s\n' "$settings" \
    | sed -n 's/.*"pendingToken":"\([0-9a-fA-F][0-9a-fA-F]*\)".*/\1/p' \
    | head -n 1)
if [ "${#pending}" -eq 32 ]; then
    "$CONTROL" rollback "$pending" >/dev/null 2>&1 || {
        printf '%s\n' '{"ok":false,"error":{"code":"ROLLBACK_FAILED","message":"The pending selection could not be restored; wait for the watchdog and try again"}}'
        exit 69
    }
fi

"$CONTROL" reset

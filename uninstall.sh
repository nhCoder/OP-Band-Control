#!/system/bin/sh

MODDIR=${0%/*}
CONTROL="$MODDIR/bin/control.sh"

if [ -x "$CONTROL" ]; then
    OPBAND_INTERNAL=1 "$CONTROL" __restore-all
    restore_status=$?
    "$CONTROL" set-reapply off >/dev/null 2>&1 || true
    if [ "$restore_status" -ne 0 ]; then
        command -v logger >/dev/null 2>&1 \
            && logger -t opband-control \
                'Uninstall could not restore every saved subscription baseline; fallback state was retained' \
                2>/dev/null
    fi
fi

# The small fallback state is intentionally retained if a SIM was unavailable,
# allowing a manual recovery from its exact RadioAccessSpecifier token.
exit 0

#!/system/bin/sh

MODDIR=${0%/*}
CONTROL="$MODDIR/bin/control.sh"

[ -x "$CONTROL" ] || exit 0

# A watchdog cannot survive a reboot. Recover any still-pending change before
# considering the separately opt-in, previously confirmed boot selection.
settings=$("$CONTROL" settings 2>/dev/null) || exit 0
pending=$(printf '%s\n' "$settings" \
    | sed -n 's/.*"pendingToken":"\([0-9a-fA-F][0-9a-fA-F]*\)".*/\1/p' \
    | head -n 1)
if [ "${#pending}" -eq 32 ]; then
    "$CONTROL" rollback "$pending" >/dev/null 2>&1 || {
        "$CONTROL" set-reapply off >/dev/null 2>&1 || true
        exit 0
    }
    settings=$("$CONTROL" settings 2>/dev/null) || exit 0
fi

case "$settings" in *'"reapply":true'*) ;; *) exit 0 ;; esac
case "$settings" in *'"applied":true'*) ;; *) exit 0 ;; esac

# Telephony can become ready shortly after the boot-completed hook. Retry a
# bounded number of times; a final failure disables reapply to avoid boot loops.
attempt=1
while [ "$attempt" -le 3 ]; do
    if OPBAND_INTERNAL=1 "$CONTROL" __boot-reapply >/dev/null 2>&1; then
        exit 0
    fi
    [ "$attempt" -eq 3 ] || sleep 6
    attempt=$((attempt + 1))
done

"$CONTROL" set-reapply off >/dev/null 2>&1 || true
command -v logger >/dev/null 2>&1 \
    && logger -t opband-control 'Boot reapply failed and was disabled' 2>/dev/null
exit 0

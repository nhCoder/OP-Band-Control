#!/bin/sh

# Host-only fixture for controller validation. app_process receives three
# launcher arguments before the helper command; discard them here.
shift 3
command=${1:-}
shift || true

if [ -n "${OPBAND_STUB_LOG:-}" ]; then
    printf '%s' "$command" >> "$OPBAND_STUB_LOG"
    for argument in "$@"; do printf ' %s' "$argument" >> "$OPBAND_STUB_LOG"; done
    printf '\n' >> "$OPBAND_STUB_LOG"
fi

case "$command" in
    selection)
        sub_id=${1:-1}
        if [ "${OPBAND_STUB_SELECTION_MODE:-auto}" = malformed ]; then
            printf '{"ok":true,"selection":{"auto":true,"lte":[],"nr":[]}}\n'
        elif [ "${OPBAND_STUB_SELECTION_MODE:-auto}" = restricted ]; then
            printf '{"ok":true,"subId":%s,"selection":{"auto":false,"lte":[1,3],"nr":[]},"restoreToken":"3:1,3:"}\n' "$sub_id"
        else
            printf '{"ok":true,"subId":%s,"selection":{"auto":true,"lte":[],"nr":[]},"restoreToken":"auto"}\n' "$sub_id"
        fi
        ;;
    reset)
        sub_id=${1:-1}
        printf '{"ok":true,"operation":"reset","subId":%s,"selection":{"auto":true,"lte":[],"nr":[]},"restoreToken":"auto","changed":true,"noOp":false}\n' "$sub_id"
        ;;
    apply|restore)
        sub_id=${1:-1}
        printf '{"ok":true,"operation":"%s","subId":%s,"selection":{"auto":false,"lte":[1,3],"nr":[]},"restoreToken":"auto"}\n' "$command" "$sub_id"
        ;;
    status)
        printf '%s\n' '{"ok":true,"selectedSubId":1,"subscriptions":[{"subId":1,"slotIndex":0,"defaultData":true}],"selection":{"auto":true,"lte":[],"nr":[]},"capability":{"read":true,"write":true}}'
        ;;
    *)
        printf '%s\n' '{"ok":false,"error":{"code":"STUB_USAGE","message":"Unexpected helper command"}}'
        exit 64
        ;;
esac

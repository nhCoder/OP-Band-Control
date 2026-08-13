#!/system/bin/sh
# OP Band Control's only privileged controller. It uses Android telephony APIs via
# app_process; it never writes QMI/NV/EFS data and never changes SELinux policy.

umask 077

MODULE_ID=opbandcontrol
KSU_MODULE=$MODULE_ID
export KSU_MODULE

BIN_DIR=$(CDPATH= cd -- "${0%/*}" 2>/dev/null && pwd)
MODDIR=${BIN_DIR%/bin}
JAR="$BIN_DIR/opband.jar"
CONTROL="$BIN_DIR/control.sh"
STATE_DIR=${OPBAND_STATE_DIR:-/data/adb/opband-control}
FALLBACK_DIR="$STATE_DIR/config"
LOG_FILE="$STATE_DIR/opband.log"
LOCK_FILE="$STATE_DIR/control.lock"
LOCK_DIR="$STATE_DIR/control.lock.d"
LOCK_OWNER_FILE="$LOCK_DIR/owner"
APP_PROCESS=${OPBAND_APP_PROCESS:-app_process}

PATH="/data/adb/ksu/bin:/data/adb/magisk:/system/bin:/system/xbin:$PATH"
export PATH

# Finite 3GPP/Android band identifiers accepted as mutation input. These are a
# syntax and safety policy, not a claim that the current modem supports them.
# Actual bands reported at runtime are returned by the helper status command.
LTE_ALLOWED_CSV=1,2,3,4,5,6,7,8,9,10,11,12,13,14,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,65,66,67,68,69,70,71,72,73,74,85,87,88
NR_ALLOWED_CSV=1,2,3,5,7,8,12,14,18,20,25,26,28,29,30,34,38,39,40,41,46,48,50,51,53,65,66,70,71,74,75,76,77,78,79,80,81,82,83,84,86,89,90,91,92,93,94,95,96,257,258,260,261
LTE_ALLOWED_WORDS='1 2 3 4 5 6 7 8 9 10 11 12 13 14 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 65 66 67 68 69 70 71 72 73 74 85 87 88'
NR_ALLOWED_WORDS='1 2 3 5 7 8 12 14 18 20 25 26 28 29 30 34 38 39 40 41 46 48 50 51 53 65 66 70 71 74 75 76 77 78 79 80 81 82 83 84 86 89 90 91 92 93 94 95 96 257 258 260 261'

LOCK_MODE=
LOCK_OWNER=
HELPER_OUTPUT=
HELPER_RC=0
NORMALIZED=
ORDINARY_BAND_COUNT=0

ensure_state_dir() {
    [ -d "$STATE_DIR" ] || mkdir -p "$STATE_DIR" 2>/dev/null || return 1
    [ -d "$FALLBACK_DIR" ] || mkdir -p "$FALLBACK_DIR" 2>/dev/null || return 1
    chmod 0700 "$STATE_DIR" "$FALLBACK_DIR" 2>/dev/null || true
    return 0
}

json_escape() {
    local value
    value=$1
    printf '%s' "$value" | sed \
        -e 's/\\/\\\\/g' \
        -e 's/"/\\"/g' \
        -e 's/	/\\t/g' \
        -e 's//\\r/g'
}

die_json() {
    local code message exit_code escaped_code escaped_message
    code=$1
    message=$2
    exit_code=${3:-64}
    escaped_code=$(json_escape "$code")
    escaped_message=$(json_escape "$message")
    printf '{"ok":false,"error":{"code":"%s","message":"%s"}}\n' \
        "$escaped_code" "$escaped_message"
    exit "$exit_code"
}

log_event() {
    local level action message timestamp size
    level=$1
    action=$2
    shift 2
    message=$*
    ensure_state_dir || return 0
    message=$(printf '%s' "$message" | tr '\r\n\t' '   ' | cut -c 1-360)
    timestamp=$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || date)
    printf '%s [%s] %s %s\n' "$timestamp" "$level" "$action" "$message" >> "$LOG_FILE" 2>/dev/null || true
    chmod 0600 "$LOG_FILE" 2>/dev/null || true
    size=$(wc -c < "$LOG_FILE" 2>/dev/null | tr -d ' ')
    case "$size" in ''|*[!0-9]*) size=0 ;; esac
    if [ "$size" -gt 262144 ]; then
        tail -n 1200 "$LOG_FILE" > "$LOG_FILE.rotate.$$" 2>/dev/null \
            && mv -f "$LOG_FILE.rotate.$$" "$LOG_FILE" 2>/dev/null
    fi
}

process_start_time() {
    local pid fields
    pid=$1
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    [ -r "/proc/$pid/stat" ] || return 1
    fields=$(sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null) || return 1
    set -- $fields
    [ "$#" -ge 20 ] || return 1
    case "${20}" in ''|*[!0-9]*) return 1 ;; esac
    printf '%s\n' "${20}"
}

lock_signature() {
    local owner pid
    owner=$(sed -n '1p' "$LOCK_OWNER_FILE" 2>/dev/null)
    pid=$(sed -n '1p' "$LOCK_DIR/pid" 2>/dev/null)
    printf '%s|%s\n' "$owner" "$pid"
}

lock_owner_is_live() {
    local owner pid started current cmdline
    owner=$(sed -n '1p' "$LOCK_OWNER_FILE" 2>/dev/null)
    case "$owner" in
        *' '*)
            pid=${owner%% *}
            started=${owner#* }
            case "$pid:$started" in
                *[!0-9:]*) return 1 ;;
            esac
            kill -0 "$pid" 2>/dev/null || return 1
            [ "$started" != 0 ] || return 0
            current=$(process_start_time "$pid" 2>/dev/null) || return 0
            [ "$current" = "$started" ]
            return $?
            ;;
    esac

    # Compatibility with locks left by older module versions, which recorded
    # only a PID. A reused PID owned by an unrelated process is not a live lock.
    pid=$(sed -n '1p' "$LOCK_DIR/pid" 2>/dev/null)
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    kill -0 "$pid" 2>/dev/null || return 1
    if [ -r "/proc/$pid/cmdline" ]; then
        cmdline=$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || return 0
        case "$cmdline" in *control.sh*) return 0 ;; *) return 1 ;; esac
    fi
    return 0
}

reclaim_stale_lock_dir() {
    local expected current
    expected=$1
    current=$(lock_signature)
    [ "$current" = "$expected" ] || return 1
    lock_owner_is_live && return 1
    rm -f "$LOCK_OWNER_FILE" "$LOCK_DIR/pid" 2>/dev/null || return 1
    rmdir "$LOCK_DIR" 2>/dev/null
}

release_lock() {
    local current
    case "$LOCK_MODE" in
        flock)
            flock -u 9 2>/dev/null || true
            exec 9>&- 2>/dev/null || true
            ;;
        mkdir)
            current=$(sed -n '1p' "$LOCK_OWNER_FILE" 2>/dev/null)
            if [ -n "$LOCK_OWNER" ] && [ "$current" = "$LOCK_OWNER" ]; then
                rm -f "$LOCK_OWNER_FILE" "$LOCK_DIR/pid" 2>/dev/null || true
                rmdir "$LOCK_DIR" 2>/dev/null || true
            fi
            ;;
    esac
    LOCK_MODE=
    LOCK_OWNER=
}

trap 'release_lock' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

acquire_lock() {
    local attempts backend wait_seconds started signature stale_signature
    ensure_state_dir || return 1

    backend=${OPBAND_LOCK_BACKEND:-auto}
    case "$backend" in auto|flock|mkdir) ;; *) backend=auto ;; esac
    wait_seconds=${OPBAND_LOCK_WAIT_SECONDS:-15}
    case "$wait_seconds" in ''|*[!0-9]*) wait_seconds=15 ;; esac
    [ "$wait_seconds" -le 60 ] || wait_seconds=60

    if [ "$backend" != mkdir ] && command -v flock >/dev/null 2>&1; then
        exec 9>"$LOCK_FILE" || return 1
        attempts=0
        while :; do
            # Android's toybox flock has -n but no util-linux-compatible -w.
            # Polling preserves the bounded wait on both Android and BusyBox.
            if flock -n 9 2>/dev/null; then
                LOCK_MODE=flock
                return 0
            fi
            [ "$attempts" -lt "$wait_seconds" ] || break
            sleep 1
            attempts=$((attempts + 1))
        done
        exec 9>&- 2>/dev/null || true
        return 1
    fi
    [ "$backend" != flock ] || return 1

    attempts=0
    stale_signature=
    while :; do
        if mkdir "$LOCK_DIR" 2>/dev/null; then
            started=$(process_start_time "$$" 2>/dev/null) || started=0
            LOCK_OWNER="$$ $started"
            if ! printf '%s\n' "$LOCK_OWNER" > "$LOCK_OWNER_FILE" 2>/dev/null; then
                LOCK_OWNER=
                rmdir "$LOCK_DIR" 2>/dev/null || true
                return 1
            fi
            printf '%s\n' "$$" > "$LOCK_DIR/pid" 2>/dev/null || true
            LOCK_MODE=mkdir
            return 0
        fi
        signature=$(lock_signature)
        if ! lock_owner_is_live && [ -n "$stale_signature" ] \
                && [ "$signature" = "$stale_signature" ]; then
            reclaim_stale_lock_dir "$signature" && continue
        fi
        if lock_owner_is_live; then stale_signature=; else stale_signature=$signature; fi
        [ "$attempts" -lt "$wait_seconds" ] || return 1
        sleep 1
        attempts=$((attempts + 1))
    done
}

valid_config_key() {
    local suffix
    case "$1" in
        profile|lte|nr|reapply|applied|sub_id|baseline_sub_ids|pending_token|pending_sub|pending_restore|pending_expires|pending_prev_profile|pending_prev_lte|pending_prev_nr|pending_prev_applied|pending_prev_sub)
            return 0
            ;;
        baseline_*)
            suffix=${1#baseline_}
            valid_sub_id "$suffix"
            return $?
            ;;
    esac
    return 1
}

config_get() {
    local key value status
    key=$1
    valid_config_key "$key" || return 1
    if command -v ksud >/dev/null 2>&1; then
        value=$(KSU_MODULE="$MODULE_ID" ksud module config get "$key" 2>/dev/null)
        status=$?
        if [ "$status" -eq 0 ] && [ -n "$value" ]; then
            printf '%s\n' "$value"
            return 0
        fi
    fi
    [ -f "$FALLBACK_DIR/$key" ] || return 1
    sed -n '1p' "$FALLBACK_DIR/$key"
}

config_set() {
    local key value ksud_ok file_ok temporary
    key=$1
    value=$2
    valid_config_key "$key" || return 1
    case "$value" in *'
'*) return 1 ;; esac
    ensure_state_dir || return 1
    ksud_ok=false
    file_ok=false
    if command -v ksud >/dev/null 2>&1; then
        if KSU_MODULE="$MODULE_ID" ksud module config set "$key" "$value" >/dev/null 2>&1; then
            ksud_ok=true
        fi
    fi
    temporary="$FALLBACK_DIR/.$key.$$"
    if printf '%s\n' "$value" > "$temporary" 2>/dev/null \
            && chmod 0600 "$temporary" 2>/dev/null \
            && mv -f "$temporary" "$FALLBACK_DIR/$key" 2>/dev/null; then
        file_ok=true
    else
        rm -f "$temporary" 2>/dev/null || true
    fi
    [ "$ksud_ok" = true ] || [ "$file_ok" = true ]
}

config_value() {
    local key fallback value
    key=$1
    fallback=$2
    value=$(config_get "$key" 2>/dev/null) || value=$fallback
    [ -n "$value" ] || value=$fallback
    printf '%s\n' "$value"
}

valid_sub_id() {
    local value
    value=$1
    case "$value" in ''|*[!0-9]*) return 1 ;; esac
    [ "${#value}" -le 10 ] || return 1
    case "$value" in 0|[1-9]|[1-9][0-9]*) return 0 ;; esac
    return 1
}

valid_profile() {
    case "$1" in adaptive|coverage|lte-plus|nsa|custom) return 0 ;; esac
    return 1
}

valid_bool() {
    [ "$1" = true ] || [ "$1" = false ]
}

valid_token() {
    local value
    value=$1
    [ "${#value}" -eq 32 ] || return 1
    case "$value" in *[!0-9a-fA-F]*) return 1 ;; esac
    return 0
}

valid_restore_token() {
    local value
    value=$1
    [ "$value" = auto ] && return 0
    [ -n "$value" ] && [ "${#value}" -le 4096 ] || return 1
    case "$value" in *[!0-9,:\;]*) return 1 ;; esac
    return 0
}

valid_band_csv() {
    local rat csv allowed seen old_ifs band
    rat=$1
    csv=$2
    [ "$csv" = - ] && return 0
    case "$csv" in ''|,*|*,|*,,*|*[!0-9,]*) return 1 ;; esac
    [ "${#csv}" -le 256 ] || return 1
    case "$rat" in
        lte) allowed=$LTE_ALLOWED_CSV ;;
        nr) allowed=$NR_ALLOWED_CSV ;;
        *) return 1 ;;
    esac
    seen=,
    old_ifs=$IFS
    IFS=,
    set -- $csv
    IFS=$old_ifs
    for band in "$@"; do
        case "$band" in 0|[1-9]|[1-9][0-9]*) ;; *) return 1 ;; esac
        case ",$allowed," in *",$band,"*) ;; *) return 1 ;; esac
        case "$seen" in *",$band,"*) return 1 ;; esac
        seen="$seen$band,"
    done
    return 0
}

normalize_band_csv() {
    local rat csv order result band
    rat=$1
    csv=$2
    valid_band_csv "$rat" "$csv" || return 1
    if [ "$csv" = - ]; then
        NORMALIZED=-
        return 0
    fi
    case "$rat" in lte) order=$LTE_ALLOWED_WORDS ;; nr) order=$NR_ALLOWED_WORDS ;; esac
    result=
    for band in $order; do
        case ",$csv," in
            *",$band,"*)
                if [ -z "$result" ]; then result=$band; else result="$result,$band"; fi
                ;;
        esac
    done
    NORMALIZED=$result
    return 0
}

count_ordinary_bands() {
    local rat csv old_ifs band count
    rat=$1
    csv=$2
    count=0
    if [ "$csv" != - ]; then
        old_ifs=$IFS
        IFS=,
        set -- $csv
        IFS=$old_ifs
        for band in "$@"; do
            case "$rat:$band" in
                lte:29|lte:32|lte:67|lte:69|nr:29|nr:75|nr:76|nr:80|nr:81|nr:82|nr:83|nr:84|nr:86|nr:89|nr:95) ;;
                *) count=$((count + 1)) ;;
            esac
        done
    fi
    ORDINARY_BAND_COUNT=$count
}

csv_json_array() {
    local csv
    csv=$1
    if [ "$csv" = - ] || [ -z "$csv" ]; then
        printf '[]'
    else
        printf '[%s]' "$csv"
    fi
}

run_helper() {
    if command -v timeout >/dev/null 2>&1; then
        CLASSPATH="$JAR" timeout 22 "$APP_PROCESS" /system/bin \
            --nice-name=opband-helper io.github.opband.Main "$@"
    else
        CLASSPATH="$JAR" "$APP_PROCESS" /system/bin \
            --nice-name=opband-helper io.github.opband.Main "$@"
    fi
}

capture_helper() {
    local stderr_file helper_stderr
    ensure_state_dir || {
        HELPER_OUTPUT='{"ok":false,"error":{"code":"STATE_UNAVAILABLE","message":"State directory is unavailable"}}'
        HELPER_RC=73
        return
    }
    stderr_file="$STATE_DIR/.helper-stderr.$$"
    : > "$stderr_file"
    HELPER_OUTPUT=$(run_helper "$@" 2> "$stderr_file")
    HELPER_RC=$?
    if [ -s "$stderr_file" ]; then
        helper_stderr=$(tr '\r\n\t' '   ' < "$stderr_file" | cut -c 1-300)
        log_event WARN helper "$helper_stderr"
    fi
    rm -f "$stderr_file" 2>/dev/null || true
    case "$HELPER_OUTPUT" in
        \{*\}) ;;
        *)
            HELPER_OUTPUT='{"ok":false,"error":{"code":"INVALID_HELPER_OUTPUT","message":"The Android helper did not return JSON"}}'
            [ "$HELPER_RC" -ne 0 ] || HELPER_RC=70
            ;;
    esac
}

extract_sub_id() {
    local json
    json=$1
    printf '%s\n' "$json" | sed -n 's/.*"subId":\([0-9][0-9]*\).*/\1/p' | head -n 1
}

extract_restore_token() {
    local json
    json=$1
    printf '%s\n' "$json" | sed -n 's/.*"restoreToken":"\([^"]*\)".*/\1/p' | head -n 1
}

append_json_fields() {
    local json fields base
    json=$1
    fields=$2
    case "$json" in
        \{*\})
            base=${json%?}
            printf '%s,%s}\n' "$base" "$fields"
            ;;
        *) printf '%s\n' "$json" ;;
    esac
}

baseline_key() {
    local sub_id
    sub_id=$1
    printf 'baseline_%s\n' "$sub_id"
}

store_baseline_once() {
    local sub_id restore_token key existing ids new_ids
    sub_id=$1
    restore_token=$2
    valid_sub_id "$sub_id" || return 1
    valid_restore_token "$restore_token" || return 1
    key=$(baseline_key "$sub_id")
    existing=$(config_get "$key" 2>/dev/null) || existing=
    if [ -n "$existing" ]; then
        valid_restore_token "$existing"
        return $?
    fi
    config_set "$key" "$restore_token" || return 1
    ids=$(config_value baseline_sub_ids '')
    case "$ids" in '' ) new_ids=$sub_id ;; * )
        case ",$ids," in *",$sub_id,"*) new_ids=$ids ;; *) new_ids="$ids,$sub_id" ;; esac
        ;;
    esac
    config_set baseline_sub_ids "$new_ids"
}

read_current_selection() {
    local requested_sub
    requested_sub=$1
    if [ -n "$requested_sub" ]; then
        capture_helper selection "$requested_sub"
    else
        capture_helper selection
    fi
    [ "$HELPER_RC" -eq 0 ] || return "$HELPER_RC"
    CURRENT_SUB=$(extract_sub_id "$HELPER_OUTPUT")
    CURRENT_RESTORE=$(extract_restore_token "$HELPER_OUTPUT")
    if ! valid_sub_id "$CURRENT_SUB" || ! valid_restore_token "$CURRENT_RESTORE"; then
        HELPER_OUTPUT='{"ok":false,"error":{"code":"INVALID_BACKEND_RESPONSE","message":"Radio backend returned an incomplete selection response"}}'
        HELPER_RC=70
        return 70
    fi
    return 0
}

persist_current_settings() {
    local profile lte nr applied sub_id
    profile=$1
    lte=$2
    nr=$3
    applied=$4
    sub_id=$5
    valid_profile "$profile" || return 1
    valid_band_csv lte "$lte" || return 1
    valid_band_csv nr "$nr" || return 1
    valid_bool "$applied" || return 1
    valid_sub_id "$sub_id" || return 1
    config_set profile "$profile" \
        && config_set lte "$lte" \
        && config_set nr "$nr" \
        && config_set applied "$applied" \
        && config_set sub_id "$sub_id"
}

clear_pending() {
    config_set pending_token none \
        && config_set pending_expires 0
}

rollback_pending_locked() {
    local requested_token reason pending_token pending_sub pending_restore previous_profile
    local previous_lte previous_nr previous_applied previous_sub fields
    requested_token=$1
    reason=$2
    pending_token=$(config_value pending_token none)
    if [ "$pending_token" != "$requested_token" ]; then
        return 2
    fi
    pending_sub=$(config_value pending_sub '')
    pending_restore=$(config_value pending_restore '')
    valid_sub_id "$pending_sub" || return 65
    valid_restore_token "$pending_restore" || return 65

    capture_helper restore "$pending_sub" "$pending_restore"
    [ "$HELPER_RC" -eq 0 ] || {
        log_event ERROR rollback "$reason failed for subscription $pending_sub"
        return "$HELPER_RC"
    }

    previous_profile=$(config_value pending_prev_profile adaptive)
    previous_lte=$(config_value pending_prev_lte -)
    previous_nr=$(config_value pending_prev_nr -)
    previous_applied=$(config_value pending_prev_applied false)
    previous_sub=$(config_value pending_prev_sub "$pending_sub")
    valid_profile "$previous_profile" || previous_profile=adaptive
    valid_band_csv lte "$previous_lte" || previous_lte=-
    valid_band_csv nr "$previous_nr" || previous_nr=-
    valid_bool "$previous_applied" || previous_applied=false
    valid_sub_id "$previous_sub" || previous_sub=$pending_sub
    persist_current_settings \
        "$previous_profile" "$previous_lte" "$previous_nr" \
        "$previous_applied" "$previous_sub" || return 73
    clear_pending || return 73
    log_event WARN rollback "$reason restored subscription $pending_sub"
    fields='"rolledBack":true,"reason":"'$(json_escape "$reason")'"'
    ROLLBACK_OUTPUT=$(append_json_fields "$HELPER_OUTPUT" "$fields")
    return 0
}

generate_token() {
    local value now
    value=$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \r\n')
    if valid_token "$value"; then
        printf '%s\n' "$value"
        return
    fi
    now=$(date +%s 2>/dev/null || printf '0')
    printf '%08x%08x%08x%08x\n' "$now" "$$" "$((now + $$))" "$((now ^ $$))"
}

start_watchdog() {
    local token
    token=$1
    (
        trap '' HUP
        sleep 45
        OPBAND_INTERNAL=1 "$CONTROL" __watchdog "$token"
    ) </dev/null >/dev/null 2>&1 &
}

command_status() {
    [ "$#" -le 1 ] || die_json USAGE 'status expects [subId]' 64
    if [ "$#" -eq 1 ]; then valid_sub_id "$1" || die_json INVALID_SUBSCRIPTION 'Invalid subscription ID' 65; fi
    capture_helper status "$@"
    printf '%s\n' "$HELPER_OUTPUT"
    exit "$HELPER_RC"
}

command_selection() {
    [ "$#" -le 1 ] || die_json USAGE 'selection expects [subId]' 64
    if [ "$#" -eq 1 ]; then valid_sub_id "$1" || die_json INVALID_SUBSCRIPTION 'Invalid subscription ID' 65; fi
    capture_helper selection "$@"
    printf '%s\n' "$HELPER_OUTPUT"
    exit "$HELPER_RC"
}

command_apply() {
    local requested_sub profile lte nr active_pending sub_id pre_restore previous_profile
    local previous_lte previous_nr previous_applied previous_sub token now expires apply_output fields
    local lte_anchor_count nr_ordinary_count
    requested_sub=
    profile=custom
    case "$#" in
        2)
            lte=$1
            nr=$2
            ;;
        3)
            if valid_profile "$3"; then
                lte=$1
                nr=$2
                profile=$3
            else
                requested_sub=$1
                lte=$2
                nr=$3
            fi
            ;;
        4)
            requested_sub=$1
            lte=$2
            nr=$3
            profile=$4
            ;;
        *) die_json USAGE 'apply expects [subId] <lteCsv|-> <nrCsv|-> [profile]' 64 ;;
    esac
    [ -z "$requested_sub" ] || valid_sub_id "$requested_sub" \
        || die_json INVALID_SUBSCRIPTION 'Invalid subscription ID' 65
    valid_profile "$profile" || die_json INVALID_PROFILE 'Unknown profile ID' 65
    [ "$profile" != adaptive ] \
        || die_json INVALID_PROFILE 'The adaptive profile must use reset' 65
    normalize_band_csv lte "$lte" \
        || die_json INVALID_BANDS 'LTE bands must be unique identifiers in the standards-level input allowlist' 65
    lte=$NORMALIZED
    normalize_band_csv nr "$nr" \
        || die_json INVALID_BANDS 'NR bands must be unique identifiers in the standards-level input allowlist' 65
    nr=$NORMALIZED

    # Older WebUI versions submitted lte-plus as a numbered LTE band
    # restriction. That is the opposite of a safe CA preference: Android's API
    # controls bands/channels to scan and cannot request carrier aggregation.
    # Preserve backwards compatibility while clearing the harmful restriction.
    if [ "$profile" = lte-plus ]; then
        log_event INFO apply 'LTE+ safeguard requested; preserving automatic selection'
        command_clear_selection "$requested_sub" lte-plus
        return
    fi

    [ "$lte" != - ] || [ "$nr" != - ] \
        || die_json EMPTY_SELECTION_REQUIRES_RESET 'Use reset for an automatic/empty selection' 65

    count_ordinary_bands lte "$lte"
    lte_anchor_count=$ORDINARY_BAND_COUNT
    count_ordinary_bands nr "$nr"
    nr_ordinary_count=$ORDINARY_BAND_COUNT
    [ $((lte_anchor_count + nr_ordinary_count)) -gt 0 ] \
        || die_json UNSAFE_SUPPLEMENTAL_ONLY 'Supplemental downlink/uplink bands cannot be the entire selection; include an ordinary LTE or NR serving band' 65
    case "$profile" in
        nsa)
            [ "$lte_anchor_count" -ge 1 ] \
                || die_json INVALID_PROFILE_SELECTION '5G NSA candidate requires an LTE anchor band' 65
            [ "$nr_ordinary_count" -ge 1 ] \
                || die_json INVALID_PROFILE_SELECTION '5G NSA candidate requires a non-supplemental NR band' 65
            ;;
    esac

    acquire_lock || die_json BUSY 'Another radio change is in progress' 75
    active_pending=$(config_value pending_token none)
    if [ "$active_pending" != none ]; then
        die_json PENDING_CHANGE 'Confirm or roll back the pending radio change first' 75
    fi

    read_current_selection "$requested_sub" || {
        printf '%s\n' "$HELPER_OUTPUT"
        exit "$HELPER_RC"
    }
    sub_id=$CURRENT_SUB
    pre_restore=$CURRENT_RESTORE
    store_baseline_once "$sub_id" "$pre_restore" \
        || die_json PERSIST_FAILED 'Could not persist the uninstall baseline; no change was made' 73

    previous_profile=$(config_value profile adaptive)
    previous_lte=$(config_value lte -)
    previous_nr=$(config_value nr -)
    previous_applied=$(config_value applied false)
    previous_sub=$(config_value sub_id "$sub_id")
    valid_profile "$previous_profile" || previous_profile=adaptive
    valid_band_csv lte "$previous_lte" || previous_lte=-
    valid_band_csv nr "$previous_nr" || previous_nr=-
    valid_bool "$previous_applied" || previous_applied=false
    valid_sub_id "$previous_sub" || previous_sub=$sub_id

    capture_helper apply "$sub_id" "$lte" "$nr"
    if [ "$HELPER_RC" -ne 0 ]; then
        log_event ERROR apply "helper rejected change for subscription $sub_id"
        printf '%s\n' "$HELPER_OUTPUT"
        exit "$HELPER_RC"
    fi

    token=$(generate_token)
    valid_token "$token" || {
        capture_helper restore "$sub_id" "$pre_restore"
        die_json TOKEN_FAILED 'Could not create a rollback token; the prior selection was restored' 70
    }
    now=$(date +%s 2>/dev/null)
    case "$now" in ''|*[!0-9]*) now=0 ;; esac
    expires=$((now + 45))
    if ! config_set pending_token "$token" \
            || ! config_set pending_sub "$sub_id" \
            || ! config_set pending_restore "$pre_restore" \
            || ! config_set pending_expires "$expires" \
            || ! config_set pending_prev_profile "$previous_profile" \
            || ! config_set pending_prev_lte "$previous_lte" \
            || ! config_set pending_prev_nr "$previous_nr" \
            || ! config_set pending_prev_applied "$previous_applied" \
            || ! config_set pending_prev_sub "$previous_sub" \
            || ! persist_current_settings "$profile" "$lte" "$nr" true "$sub_id"; then
        capture_helper restore "$sub_id" "$pre_restore"
        clear_pending || true
        die_json PERSIST_FAILED 'Could not persist the fail-safe state; the prior selection was restored' 73
    fi

    apply_output=$HELPER_OUTPUT
    log_event INFO apply "pending change for subscription $sub_id; rollback armed"
    release_lock
    start_watchdog "$token"
    fields='"pendingToken":"'$token'","rollbackAt":'"${expires}000"',"watchdogSeconds":45'
    append_json_fields "$apply_output" "$fields"
}

command_confirm() {
    local token current
    [ "$#" -eq 1 ] || die_json USAGE 'confirm expects <pendingToken>' 64
    token=$1
    valid_token "$token" || die_json INVALID_TOKEN 'Invalid pending-change token' 65
    acquire_lock || die_json BUSY 'Another radio change is in progress' 75
    current=$(config_value pending_token none)
    [ "$current" = "$token" ] || die_json TOKEN_MISMATCH 'No matching pending radio change' 65
    clear_pending || die_json PERSIST_FAILED 'Could not confirm the radio change' 73
    log_event INFO confirm 'radio change kept by user'
    printf '{"ok":true,"confirmed":true,"pendingToken":"%s"}\n' "$token"
}

command_rollback() {
    local token status
    [ "$#" -eq 1 ] || die_json USAGE 'rollback expects <pendingToken>' 64
    token=$1
    valid_token "$token" || die_json INVALID_TOKEN 'Invalid pending-change token' 65
    acquire_lock || die_json BUSY 'Another radio change is in progress' 75
    rollback_pending_locked "$token" user
    status=$?
    case "$status" in
        0) printf '%s\n' "$ROLLBACK_OUTPUT" ;;
        2) die_json TOKEN_MISMATCH 'No matching pending radio change' 65 ;;
        *)
            if [ -n "$HELPER_OUTPUT" ]; then printf '%s\n' "$HELPER_OUTPUT"; else die_json ROLLBACK_FAILED 'Could not restore the prior radio selection' 69; fi
            exit "$status"
            ;;
    esac
}

command_clear_selection() {
    local requested_sub saved_profile sub_id reset_output owned_applied owned_sub owned_reapply
    requested_sub=$1
    saved_profile=$2
    acquire_lock || die_json BUSY 'Another radio change is in progress' 75
    [ "$(config_value pending_token none)" = none ] \
        || die_json PENDING_CHANGE 'Confirm or roll back the pending radio change first' 75
    read_current_selection "$requested_sub" || {
        printf '%s\n' "$HELPER_OUTPUT"
        exit "$HELPER_RC"
    }
    sub_id=$CURRENT_SUB

    # Re-sending an empty system-selection list is not harmless on every modem:
    # some firmware tears down the current LTE secondary carriers while it
    # re-evaluates the same automatic policy. The selection helper represents an
    # already-automatic/empty selection with the exact restore token "auto", so
    # treat that state as an idempotent success and never call the radio setter.
    if [ "$CURRENT_RESTORE" = auto ]; then
        owned_applied=$(config_value applied false)
        owned_reapply=$(config_value reapply false)
        owned_sub=$(config_value sub_id '')
        if valid_sub_id "$owned_sub" && [ "$owned_sub" != "$sub_id" ] \
                && { [ "$owned_applied" = true ] || [ "$owned_reapply" = true ]; }; then
            log_event INFO reset "subscription $sub_id was already automatic; radio write and subscription $owned_sub state changes skipped"
            reset_output=$(append_json_fields "$HELPER_OUTPUT" \
                '"operation":"reset","changed":false,"noOp":true,"profile":"'"$saved_profile"'","settingsPreservedForSubId":'"$owned_sub")
            append_json_fields "$reset_output" \
                '"message":"Band selection was already automatic; no radio write was made and the other SIM settings were preserved"'
            return
        fi
        persist_current_settings "$saved_profile" - - false "$sub_id" \
            || die_json PERSIST_FAILED 'Selection was already automatic, but its state could not be persisted' 73
        config_set reapply false \
            || die_json PERSIST_FAILED 'Selection was already automatic, but boot reapply could not be disabled' 73
        log_event INFO reset "subscription $sub_id was already automatic; radio write skipped"
        reset_output=$(append_json_fields "$HELPER_OUTPUT" \
            '"operation":"reset","changed":false,"noOp":true,"profile":"'"$saved_profile"'"')
        append_json_fields "$reset_output" \
            '"message":"Band selection was already automatic; no radio write was made"'
        return
    fi

    # The LTE+ safeguard is intentionally narrower than the explicit Restore
    # defaults action. A non-empty system selection may belong to another root
    # tool, an OEM policy, or the carrier. Clear it here only when our confirmed
    # state says this module applied a restriction to this exact subscription.
    if [ "$saved_profile" = lte-plus ]; then
        owned_applied=$(config_value applied false)
        owned_sub=$(config_value sub_id '')
        if [ "$owned_applied" != true ] || [ "$owned_sub" != "$sub_id" ]; then
            log_event WARN apply "subscription $sub_id has a restriction not owned by this module; radio write skipped"
            die_json UNOWNED_SELECTION 'A non-automatic selection is active but was not applied by this module; use Restore defaults only if you intend to clear it' 65
        fi
    fi

    store_baseline_once "$sub_id" "$CURRENT_RESTORE" \
        || die_json PERSIST_FAILED 'Could not persist the uninstall baseline; no change was made' 73

    capture_helper reset "$sub_id"
    [ "$HELPER_RC" -eq 0 ] || {
        log_event ERROR reset "helper rejected reset for subscription $sub_id"
        printf '%s\n' "$HELPER_OUTPUT"
        exit "$HELPER_RC"
    }
    persist_current_settings "$saved_profile" - - false "$sub_id" \
        || die_json PERSIST_FAILED 'Reset succeeded, but its state could not be persisted' 73
    config_set reapply false \
        || die_json PERSIST_FAILED 'Reset succeeded, but boot reapply could not be disabled' 73
    log_event INFO reset "automatic selection restored for subscription $sub_id"
    append_json_fields "$HELPER_OUTPUT" \
        '"profile":"'"$saved_profile"'","message":"Automatic band selection restored; carrier aggregation remains modem/network controlled"'
}

command_reset() {
    local requested_sub
    [ "$#" -le 1 ] || die_json USAGE 'reset expects [subId]' 64
    requested_sub=
    if [ "$#" -eq 1 ]; then
        valid_sub_id "$1" || die_json INVALID_SUBSCRIPTION 'Invalid subscription ID' 65
        requested_sub=$1
    fi
    command_clear_selection "$requested_sub" adaptive
}

command_settings() {
    local profile lte nr reapply applied sub_id pending_token pending_expires baseline key
    local stored_baseline lte_json nr_json sub_json pending_json rollback_json
    profile=$(config_value profile adaptive)
    lte=$(config_value lte -)
    nr=$(config_value nr -)
    reapply=$(config_value reapply false)
    applied=$(config_value applied false)
    sub_id=$(config_value sub_id '')
    pending_token=$(config_value pending_token none)
    pending_expires=$(config_value pending_expires 0)
    valid_profile "$profile" || profile=adaptive
    valid_band_csv lte "$lte" || lte=-
    valid_band_csv nr "$nr" || nr=-
    valid_bool "$reapply" || reapply=false
    valid_bool "$applied" || applied=false
    valid_sub_id "$sub_id" || sub_id=
    valid_token "$pending_token" || pending_token=none
    case "$pending_expires" in ''|*[!0-9]*) pending_expires=0 ;; esac
    baseline=false
    if [ -n "$sub_id" ]; then
        key=$(baseline_key "$sub_id")
        stored_baseline=$(config_get "$key" 2>/dev/null) || stored_baseline=
        if valid_restore_token "$stored_baseline"; then baseline=true; fi
    fi
    lte_json=$(csv_json_array "$lte")
    nr_json=$(csv_json_array "$nr")
    if [ -n "$sub_id" ]; then sub_json=$sub_id; else sub_json=null; fi
    if [ "$pending_token" = none ]; then
        pending_json=null
        rollback_json=null
    else
        pending_json='"'$pending_token'"'
        rollback_json="${pending_expires}000"
    fi
    printf '{"ok":true,"profile":"%s","lte":%s,"nr":%s,"reapply":%s,"applied":%s,"subId":%s,"baselineCaptured":%s,"pendingToken":%s,"rollbackAt":%s}\n' \
        "$profile" "$lte_json" "$nr_json" "$reapply" "$applied" "$sub_json" \
        "$baseline" "$pending_json" "$rollback_json"
}

command_set_reapply() {
    local value applied pending
    [ "$#" -eq 1 ] || die_json USAGE 'set-reapply expects on or off' 64
    case "$1" in on|true) value=true ;; off|false) value=false ;; *)
        die_json INVALID_VALUE 'set-reapply accepts only on or off' 65 ;;
    esac
    acquire_lock || die_json BUSY 'Another settings change is in progress' 75
    if [ "$value" = true ]; then
        applied=$(config_value applied false)
        pending=$(config_value pending_token none)
        [ "$applied" = true ] \
            || die_json NOT_CONFIGURED 'Apply and confirm a selection before enabling boot reapply' 65
        [ "$pending" = none ] \
            || die_json PENDING_CHANGE 'Confirm or roll back the pending radio change first' 75
    fi
    config_set reapply "$value" || die_json PERSIST_FAILED 'Could not persist boot reapply setting' 73
    log_event INFO settings "boot reapply set to $value"
    printf '{"ok":true,"reapply":%s}\n' "$value"
}

command_logs() {
    local limit sample first line escaped
    [ "$#" -le 1 ] || die_json USAGE 'logs expects [limit]' 64
    limit=${1:-100}
    case "$limit" in ''|*[!0-9]*) die_json INVALID_LIMIT 'Log limit must be 1 through 500' 65 ;; esac
    [ "$limit" -ge 1 ] && [ "$limit" -le 500 ] \
        || die_json INVALID_LIMIT 'Log limit must be 1 through 500' 65
    ensure_state_dir || die_json STATE_UNAVAILABLE 'State directory is unavailable' 73
    sample="$STATE_DIR/.logs.$$"
    if [ -f "$LOG_FILE" ]; then tail -n "$limit" "$LOG_FILE" > "$sample"; else : > "$sample"; fi
    printf '{"ok":true,"logs":"'
    first=true
    while IFS= read -r line || [ -n "$line" ]; do
        escaped=$(json_escape "$line")
        if [ "$first" = true ]; then first=false; else printf '\\n'; fi
        printf '%s' "$escaped"
    done < "$sample"
    rm -f "$sample" 2>/dev/null || true
    printf '"}\n'
}

command_clear_logs() {
    [ "$#" -eq 0 ] || die_json USAGE 'clear-logs takes no arguments' 64
    acquire_lock || die_json BUSY 'Another operation is in progress' 75
    : > "$LOG_FILE" || die_json LOG_FAILED 'Could not clear the log' 73
    chmod 0600 "$LOG_FILE" 2>/dev/null || true
    printf '{"ok":true,"cleared":true}\n'
}

command_watchdog() {
    local token expires now current status
    [ "${OPBAND_INTERNAL:-0}" = 1 ] || die_json FORBIDDEN 'Internal command' 77
    [ "$#" -eq 1 ] || die_json USAGE 'Internal watchdog token missing' 64
    token=$1
    valid_token "$token" || die_json INVALID_TOKEN 'Invalid pending-change token' 65
    expires=$(config_value pending_expires 0)
    now=$(date +%s 2>/dev/null)
    case "$expires:$now" in *[!0-9:]*) expires=0; now=0 ;; esac
    if [ "$expires" -gt "$now" ]; then sleep "$((expires - now))"; fi
    acquire_lock || exit 75
    current=$(config_value pending_token none)
    [ "$current" = "$token" ] || exit 0
    rollback_pending_locked "$token" watchdog
    status=$?
    [ "$status" -eq 0 ] && printf '%s\n' "$ROLLBACK_OUTPUT"
    exit "$status"
}

command_boot_reapply() {
    local pending status reapply applied profile sub_id lte nr
    [ "${OPBAND_INTERNAL:-0}" = 1 ] || die_json FORBIDDEN 'Internal command' 77
    [ "$#" -eq 0 ] || die_json USAGE 'Internal command takes no arguments' 64
    acquire_lock || die_json BUSY 'Another radio operation is in progress' 75
    pending=$(config_value pending_token none)
    if [ "$pending" != none ]; then
        rollback_pending_locked "$pending" boot-recovery || {
            status=$?
            [ "$status" -eq 2 ] || exit "$status"
        }
    fi
    reapply=$(config_value reapply false)
    applied=$(config_value applied false)
    profile=$(config_value profile adaptive)
    sub_id=$(config_value sub_id '')
    lte=$(config_value lte -)
    nr=$(config_value nr -)
    [ "$reapply" = true ] && [ "$applied" = true ] \
        || die_json NOT_CONFIGURED 'No confirmed selection is configured for boot reapply' 65
    valid_sub_id "$sub_id" || die_json INVALID_STATE 'Stored subscription is invalid' 65
    valid_band_csv lte "$lte" || die_json INVALID_STATE 'Stored LTE selection is invalid' 65
    valid_band_csv nr "$nr" || die_json INVALID_STATE 'Stored NR selection is invalid' 65

    # Migrate a confirmed legacy lte-plus restriction instead of reapplying it
    # after upgrade. Automatic selection leaves all CA combinations available.
    if [ "$profile" = lte-plus ]; then
        capture_helper reset "$sub_id"
        [ "$HELPER_RC" -eq 0 ] || {
            printf '%s\n' "$HELPER_OUTPUT"
            exit "$HELPER_RC"
        }
        persist_current_settings adaptive - - false "$sub_id" \
            || die_json PERSIST_FAILED 'Legacy LTE+ restriction was cleared, but state migration failed' 73
        config_set reapply false || true
        log_event INFO boot 'legacy LTE+ restriction cleared; boot reapply disabled'
        printf '%s\n' "$HELPER_OUTPUT"
        return
    fi

    [ "$lte" != - ] || [ "$nr" != - ] \
        || die_json INVALID_STATE 'Stored selection is empty' 65
    capture_helper apply "$sub_id" "$lte" "$nr"
    [ "$HELPER_RC" -eq 0 ] || {
        printf '%s\n' "$HELPER_OUTPUT"
        exit "$HELPER_RC"
    }
    log_event INFO boot "confirmed selection reapplied to subscription $sub_id"
    printf '%s\n' "$HELPER_OUTPUT"
}

command_restore_all() {
    local ids restored failed old_ifs sub_id key token
    [ "${OPBAND_INTERNAL:-0}" = 1 ] || die_json FORBIDDEN 'Internal command' 77
    [ "$#" -eq 0 ] || die_json USAGE 'Internal command takes no arguments' 64
    acquire_lock || die_json BUSY 'Another radio operation is in progress' 75
    config_set pending_token none || true
    ids=$(config_value baseline_sub_ids '')
    if [ -z "$ids" ]; then
        config_set reapply false || true
        printf '{"ok":true,"restored":0,"failed":0}\n'
        return
    fi
    case "$ids" in ,*|*,|*,,*|*[!0-9,]*) die_json INVALID_STATE 'Stored baseline subscription list is invalid' 65 ;; esac
    restored=0
    failed=0
    old_ifs=$IFS
    IFS=,
    set -- $ids
    IFS=$old_ifs
    for sub_id in "$@"; do
        valid_sub_id "$sub_id" || { failed=$((failed + 1)); continue; }
        key=$(baseline_key "$sub_id")
        token=$(config_value "$key" '')
        valid_restore_token "$token" || { failed=$((failed + 1)); continue; }
        capture_helper restore "$sub_id" "$token"
        if [ "$HELPER_RC" -eq 0 ]; then
            restored=$((restored + 1))
            log_event INFO uninstall "baseline restored for subscription $sub_id"
        else
            failed=$((failed + 1))
            log_event ERROR uninstall "baseline restore failed for subscription $sub_id"
        fi
    done
    config_set reapply false || true
    config_set applied false || true
    config_set profile adaptive || true
    printf '{"ok":%s,"restored":%s,"failed":%s}\n' \
        "$([ "$failed" -eq 0 ] && printf true || printf false)" "$restored" "$failed"
    [ "$failed" -eq 0 ]
}

command=${1:-}
[ -n "$command" ] || die_json USAGE 'Missing command' 64
shift

case "$command" in
    status) command_status "$@" ;;
    selection) command_selection "$@" ;;
    apply) command_apply "$@" ;;
    confirm) command_confirm "$@" ;;
    rollback) command_rollback "$@" ;;
    reset) command_reset "$@" ;;
    settings) [ "$#" -eq 0 ] || die_json USAGE 'settings takes no arguments' 64; command_settings ;;
    set-reapply) command_set_reapply "$@" ;;
    logs) command_logs "$@" ;;
    clear-logs) command_clear_logs "$@" ;;
    __watchdog) command_watchdog "$@" ;;
    __boot-reapply) command_boot_reapply "$@" ;;
    __restore-all) command_restore_all "$@" ;;
    *) die_json UNKNOWN_COMMAND 'Unknown command' 64 ;;
esac

#!/system/bin/sh

SKIPUNZIP=0

if ! command -v ui_print >/dev/null 2>&1; then
    ui_print() { printf '%s\n' "$*"; }
fi
if ! command -v abort >/dev/null 2>&1; then
    abort() { ui_print "! $*"; exit 1; }
fi

device_api=${API:-$(getprop ro.build.version.sdk 2>/dev/null)}
case "$device_api" in ''|*[!0-9]*) abort 'Could not determine Android API level' ;; esac
[ "$device_api" -ge 31 ] || abort 'Android 12 / API 31 or newer is required'

device_arch=${ARCH:-$(getprop ro.product.cpu.abi 2>/dev/null)}
[ -n "$device_arch" ] || device_arch=unknown

device_model=$(getprop ro.product.model 2>/dev/null)
device_maker=$(getprop ro.product.manufacturer 2>/dev/null)
device_rom=$(getprop ro.build.display.id 2>/dev/null)
ui_print '***************************************'
ui_print ' OP Band Control — guarded Android backend'
ui_print '***************************************'
ui_print "- Device: $device_maker $device_model"
ui_print "- Android API: $device_api"
ui_print "- ABI: $device_arch"
[ -z "$device_rom" ] || ui_print "- ROM: $device_rom"

[ -s "$MODPATH/bin/opband.jar" ] || abort 'Android helper jar is missing'
[ -s "$MODPATH/bin/control.sh" ] || abort 'Controller is missing'

if command -v set_perm >/dev/null 2>&1; then
    set_perm "$MODPATH/bin/control.sh" 0 0 0755
    set_perm "$MODPATH/customize.sh" 0 0 0755
    set_perm "$MODPATH/boot-completed.sh" 0 0 0755
    set_perm "$MODPATH/action.sh" 0 0 0755
    set_perm "$MODPATH/uninstall.sh" 0 0 0755
    set_perm "$MODPATH/bin/opband.jar" 0 0 0644
else
    chmod 0755 "$MODPATH/bin/control.sh" "$MODPATH/customize.sh" \
        "$MODPATH/boot-completed.sh" \
        "$MODPATH/action.sh" "$MODPATH/uninstall.sh"
    chmod 0644 "$MODPATH/bin/opband.jar"
fi

# Create only the private fallback container. Missing values intentionally resolve
# to adaptive/off, so installing or updating never enables boot reapply.
mkdir -p /data/adb/opband-control/config 2>/dev/null || true
chmod 0700 /data/adb/opband-control /data/adb/opband-control/config 2>/dev/null || true

ui_print '- Boot reapply is OFF by default and must be explicitly enabled.'
ui_print '- Numbered restriction writes have a 45-second confirm-or-rollback watchdog.'
ui_print '- No QMI/NV writes and no permissive SELinux changes are included.'

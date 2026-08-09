#!/system/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

module_version=$(sed -n 's/^version=//p' module.prop)
package_version=$(node --input-type=module --eval \
  "import fs from 'node:fs'; process.stdout.write(JSON.parse(fs.readFileSync('package.json', 'utf8')).version)")
case "$module_version" in
  ''|*[!0-9.]*) echo 'module.prop must contain one numeric semantic version.' >&2; exit 1 ;;
esac
saved_ifs=$IFS
IFS=.
set -- $module_version
IFS=$saved_ifs
if [ "$#" -ne 3 ]; then
  echo 'module.prop version must use x.y.z format.' >&2
  exit 1
fi
for version_part in "$@"; do
  case "$version_part" in
    0|[1-9]|[1-9][0-9]*) ;;
    *) echo 'module.prop version contains an invalid numeric segment.' >&2; exit 1 ;;
  esac
done
if [ "$module_version" != "$package_version" ]; then
  echo "Version mismatch: module.prop=$module_version package.json=$package_version" >&2
  exit 1
fi
if ! grep -Fq "./styles/app.css?v=$module_version" webroot/index.html \
    || ! grep -Fq "./js/app.js?v=$module_version" webroot/index.html; then
  echo "WebUI cache-busting versions must match module.prop: $module_version" >&2
  exit 1
fi

required_files='module.prop customize.sh action.sh uninstall.sh bin/control.sh bin/opband.jar webroot/index.html webroot/styles/app.css webroot/js/app.js webroot/js/api.js webroot/js/subscriptions.js'

for file in $required_files; do
  if [ ! -f "$file" ]; then
    echo "Missing required module file: $file" >&2
    exit 1
  fi
done

for script in customize.sh action.sh uninstall.sh boot-completed.sh bin/control.sh scripts/package.sh scripts/build-helper.sh tests/controller.test.sh tests/fixtures/app_process_stub.sh tests/fixtures/flock_compat_stub.sh; do
  if [ -f "$script" ]; then
    sh -n "$script"
  fi
done

sh tests/controller.test.sh

for javascript in webroot/js/*.js webroot/js/vendor/*.js; do
  node --check "$javascript"
done

node --test tests/*.test.mjs

if grep -R -n -E '<script[^>]+src="https?://|<link[^>]+href="https?://' webroot; then
  echo 'Remote WebUI assets are forbidden in the root-capable WebView.' >&2
  exit 1
fi

if grep -R -n -E 'setenforce[[:space:]]+0|persist\.radio|/dev/diag|qmicli|QPST' --exclude='validate.sh' bin helper-src customize.sh action.sh uninstall.sh boot-completed.sh 2>/dev/null; then
  echo 'Forbidden modem or SELinux mutation found.' >&2
  exit 1
fi

if ! grep -q "default-src 'self'" webroot/index.html; then
  echo 'WebUI CSP is missing.' >&2
  exit 1
fi

if ! grep -q 'Looper.prepareMainLooper()' helper-src/io/github/opband/Main.java; then
  echo 'The app_process helper must prepare a main Looper before Android services.' >&2
  exit 1
fi

if ! grep -q 'ensureTelephonyFrameworkInitialized()' helper-src/io/github/opband/Main.java \
    || ! grep -q 'getTelephonyServiceManager' helper-src/io/github/opband/Main.java; then
  echo 'The standalone helper must initialize Android mainline telephony services.' >&2
  exit 1
fi

if ! grep -q 'getCompleteActiveSubscriptionInfoList' helper-src/io/github/opband/TelephonyBackend.java \
    || ! grep -q 'getSubscriptionIds' helper-src/io/github/opband/TelephonyBackend.java \
    || ! grep -q 'isActiveSubscriptionId' helper-src/io/github/opband/TelephonyBackend.java; then
  echo 'Layered subscription discovery and write-time verification are required.' >&2
  exit 1
fi

if ! grep -q 'ServiceState.STATE_IN_SERVICE' helper-src/io/github/opband/TelephonyBackend.java; then
  echo 'Service registration must contribute to the live connection state.' >&2
  exit 1
fi

echo 'Validation passed.'

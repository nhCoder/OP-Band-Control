#!/system/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DIST_DIR="$ROOT_DIR/dist"
STAGE_DIR="$ROOT_DIR/.build/module"
VERSION=$(sed -n 's/^version=//p' "$ROOT_DIR/module.prop" | head -n 1)
ARCHIVE="$DIST_DIR/op-band-control-v${VERSION}.zip"

if [ -x "$ROOT_DIR/scripts/build-helper.sh" ]; then
  "$ROOT_DIR/scripts/build-helper.sh"
else
  sh "$ROOT_DIR/scripts/build-helper.sh"
fi

sh "$ROOT_DIR/scripts/validate.sh"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR" "$DIST_DIR"

for path in \
  module.prop \
  skip_mount \
  customize.sh \
  boot-completed.sh \
  action.sh \
  uninstall.sh \
  LICENSE \
  THIRD_PARTY_NOTICES.md \
  bin \
  webroot; do
  cp -R "$ROOT_DIR/$path" "$STAGE_DIR/"
done

find "$STAGE_DIR" -type f -name '.DS_Store' -delete
find "$STAGE_DIR" -type f -exec chmod 0644 {} \;
chmod 0755 "$STAGE_DIR/customize.sh" "$STAGE_DIR/boot-completed.sh" "$STAGE_DIR/action.sh" "$STAGE_DIR/uninstall.sh" "$STAGE_DIR/bin/control.sh"

rm -f "$ARCHIVE"
(
  cd "$STAGE_DIR"
  zip -q -r -9 "$ARCHIVE" .
)

echo "$ARCHIVE"

#!/bin/sh

# Models Android toybox flock: non-blocking FD locking is accepted, while the
# util-linux-only timeout spelling that caused false BUSY responses is rejected.
case " $* " in
    *' -w '*) exit 64 ;;
esac

case "${1:-}" in
    -n|-u) exit 0 ;;
    *) exit 64 ;;
esac

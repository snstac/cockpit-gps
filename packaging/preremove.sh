#!/bin/sh
# Runs before remove on both deb (arg "remove") and rpm (arg "0").
set -e
if [ "$1" = "remove" ] || [ "$1" = "0" ]; then
    systemctl disable --now gps-integrity.service >/dev/null 2>&1 || true
fi
exit 0

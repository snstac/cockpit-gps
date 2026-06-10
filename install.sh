#!/bin/sh
# Convenience installer: builds the plugin and installs it via the Makefile.
# For prebuilt installs (no build tools), use the release tarball instead.
set -eu

WITH_INTEGRITY=0
USER_INSTALL=0
for a in "$@"; do
    case "$a" in
        --with-integrity) WITH_INTEGRITY=1 ;;
        --user) USER_INSTALL=1 ;;
        -h|--help)
            echo "usage: ./install.sh [--user] [--with-integrity]"
            exit 0 ;;
        *) echo "unknown option: $a" >&2; exit 1 ;;
    esac
done

echo "Building..."
make

if [ "$USER_INSTALL" = 1 ]; then
    make devel-install
    echo "Installed for current user (~/.local/share/cockpit/gps)."
    [ "$WITH_INTEGRITY" = 1 ] && echo "Note: --with-integrity needs a system install; skipped."
else
    sudo make install
    if [ "$WITH_INTEGRITY" = 1 ]; then
        sudo make install-integrity
        sudo systemctl daemon-reload
        sudo systemctl enable --now gps-integrity.service
        echo "Started gps-integrity.service"
    fi
fi
echo "Done. Open Cockpit and click GPS (reload an open tab to pick it up)."

#!/bin/sh
# Remove the Cockpit GPS plugin (+ integrity monitor) installed via the Makefile.
set -eu

if [ "${1:-}" = "--user" ]; then
    make devel-uninstall
    echo "Removed user install."
    exit 0
fi

sudo make uninstall
if [ -f /etc/systemd/system/gps-integrity.service ]; then
    sudo make uninstall-integrity
    echo "Removed integrity monitor (config and /var/lib/gps-integrity left in place)."
fi
echo "Done."

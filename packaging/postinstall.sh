#!/bin/sh
# Runs after install/upgrade on both deb and rpm.
set -e
# Pick up the (optional) integrity unit; the service is not auto-enabled.
systemctl daemon-reload >/dev/null 2>&1 || true
exit 0

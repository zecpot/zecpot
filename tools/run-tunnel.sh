#!/bin/bash
# Started by launchd (see tools/install-services.sh). Connects zecpot.com to this Mac.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec cloudflared --no-autoupdate tunnel run --url http://localhost:8787 "${TUNNEL_NAME:-zecpot}"

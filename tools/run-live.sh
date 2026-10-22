#!/bin/bash
# Started by launchd (see tools/install-services.sh). Runs the live zecPOT server.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
set -a; source ./.env; set +a
exec /usr/bin/caffeinate -i npm run serve

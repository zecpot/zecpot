#!/usr/bin/env bash
# Writes ~/snarkpot/.env from the wallets setup-pool.sh already created.
# Reads only: it creates no new addresses and never prints a recovery phrase.
#
#   bash tools/write-env.sh
set -euo pipefail

ZINGO_BIN="${ZINGO_BIN:-$HOME/bin/zingo-cli}"
SERVER="${LIGHTWALLETD:-https://zec.rocks:443}"
BASE="${SNARKPOT_WALLETS:-$HOME/.snarkpot}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env"

if [ -e "${ENV_FILE}" ]; then
  echo "${ENV_FILE} already exists; not overwriting it. Delete or rename it first to regenerate." >&2
  exit 1
fi
command -v jq >/dev/null || { echo "needs jq: brew install jq" >&2; exit 1; }
for wallet in inbox ops; do
  [ -e "${BASE}/${wallet}/zingo-wallet.dat" ] || { echo "no ${wallet} wallet in ${BASE}/${wallet}; run tools/setup-pool.sh first" >&2; exit 1; }
done

json() { "${ZINGO_BIN}" --data-dir "${BASE}/$1" --server "${SERVER}" --nosync "${@:2}" 2>/dev/null | sed -n '/^[{[]/,$p'; }

# The Orchard/Ironwood-only address setup-pool.sh created (no Sapling, no transparent receiver).
pick='[.[] | select(.has_orchard and (.has_sapling | not) and (.has_transparent | not))] | last | .encoded_address'
INBOX_ADDR="$(json inbox addresses | jq -r "${pick}")"
OPS_ADDR="$(json ops addresses | jq -r "${pick}")"
INBOX_UFVK="$(json inbox export_ufvk | jq -r .ufvk)"
for v in "${INBOX_ADDR}" "${OPS_ADDR}" "${INBOX_UFVK}"; do
  if [ -z "${v}" ] || [ "${v}" = "null" ]; then echo "could not read an address or the viewing key from zingo-cli; stopping" >&2; exit 1; fi
done

umask 077
cat > "${ENV_FILE}" <<EOF
SNARKPOT_MODE=live
ZINGO_BIN=${ZINGO_BIN}
LIGHTWALLETD=${SERVER}
INBOX_DATA_DIR=${BASE}/inbox
OPS_DATA_DIR=${BASE}/ops
POOL_ADDRESS=${INBOX_ADDR}
OPS_ADDRESS=${OPS_ADDR}
POOL_VIEWING_KEY=${INBOX_UFVK}
# Register a Zilkroad account with OPS_ADDRESS (it pays for purchases):
POOL_ZILKROAD_ADDRESS=${OPS_ADDR}
# Paste the zilkroad.com session cookie between the quotes once signed in:
ZILKROAD_COOKIE=''
EOF
echo "Wrote ${ENV_FILE} (readable only by you)."
echo "POOL_ADDRESS (players pay here): ${INBOX_ADDR}"
echo "OPS_ADDRESS  (fund this first):  ${OPS_ADDR}"

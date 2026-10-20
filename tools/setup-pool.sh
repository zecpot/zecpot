#!/usr/bin/env bash
# Creates the two SNARKPOT wallets (inbox + ops) with zingo-cli and prints the
# values for .env. Run once, on the machine that will run the engine.
#
#   ZINGO_BIN=/path/to/zingo-cli ./tools/setup-pool.sh
#
# It prints both wallets' recovery phrases and birthdays. Write them down offline: they are
# the only way to recover the pot if this machine dies.
#
# Plain ASCII on purpose: macOS ships bash 3.2, which misreads some UTF-8
# characters placed right after a variable name.
set -euo pipefail

ZINGO_BIN="${ZINGO_BIN:-zingo-cli}"
SERVER="${LIGHTWALLETD:-https://zec.rocks:443}"
BASE="${SNARKPOT_WALLETS:-$HOME/.snarkpot}"

command -v "${ZINGO_BIN}" >/dev/null || { echo "zingo-cli not found; set ZINGO_BIN (see README, Going live)" >&2; exit 1; }
command -v jq >/dev/null || { echo "needs jq: brew install jq" >&2; exit 1; }

# A default zingo-cli build goes online only through the Nym mixnet and needs
# nym-proxy beside it. A direct-connection build (makers run-cli --nakednet
# --features nakednet-test-mode) does not. So this is only a warning.
BIN_DIR="$(cd "$(dirname "$(command -v "${ZINGO_BIN}")")" && pwd)"
if [ ! -x "${BIN_DIR}/nym-proxy" ] && [ ! -x "${ZINGO_NYM_PROXY:-/nonexistent}" ] && ! command -v nym-proxy >/dev/null; then
  echo "Note: no nym-proxy next to ${BIN_DIR}/zingo-cli. Fine for a direct-connection build;" >&2
  echo "a default (mixnet) build will fail to go online without it." >&2
fi

# Runs one zingo-cli command for wallet $1 and prints only its JSON.
# On failure, shows zingo-cli's own error and stops.
z() {
  local wallet="$1"; shift
  local out err
  err="$(mktemp)"
  if ! out="$("${ZINGO_BIN}" --data-dir "${BASE}/${wallet}" --server "${SERVER}" --waitsync "$@" 2>"${err}")"; then
    echo "zingo-cli ${1} failed for the ${wallet} wallet:" >&2
    tail -n 5 "${err}" >&2
    rm -f "${err}"
    exit 1
  fi
  rm -f "${err}"
  printf '%s\n' "${out}" | sed -n '/^[{[]/,$p'
}

for wallet in inbox ops; do
  mkdir -p "${BASE}/${wallet}"
  chmod 700 "${BASE}/${wallet}"
  if [ ! -e "${BASE}/${wallet}/zingo-wallet.dat" ]; then
    echo "Creating the ${wallet} wallet in ${BASE}/${wallet} (first run syncs, give it a minute)" >&2
  fi
done

# Orchard receiver only (no Sapling, no transparent). After NU6.3 this receiver is the Ironwood receiver.
INBOX_ADDR="$(z inbox new_address o | jq -r .encoded_address)"
OPS_ADDR="$(z ops new_address o | jq -r .encoded_address)"
INBOX_UFVK="$(z inbox export_ufvk | jq -r .ufvk)"
for v in "${INBOX_ADDR}" "${OPS_ADDR}" "${INBOX_UFVK}"; do
  if [ -z "${v}" ] || [ "${v}" = "null" ]; then echo "zingo-cli returned an empty value; stopping" >&2; exit 1; fi
done

echo
echo "=== Recovery phrases (write these down on paper, never commit or paste them) ==="
for wallet in inbox ops; do
  echo "--- ${wallet}"
  "${ZINGO_BIN}" --data-dir "${BASE}/${wallet}" --server "${SERVER}" --nosync recovery_info 2>/dev/null \
    | sed -n 's/^ *seed phrase: /phrase:   /p; s/^ *birthday: /birthday: /p'
done
echo
echo "=== Add to ~/snarkpot/.env ==="
cat <<EOF
SNARKPOT_MODE=live
ZINGO_BIN=${ZINGO_BIN}
LIGHTWALLETD=${SERVER}
INBOX_DATA_DIR=${BASE}/inbox
OPS_DATA_DIR=${BASE}/ops
POOL_ADDRESS=${INBOX_ADDR}
OPS_ADDRESS=${OPS_ADDR}
POOL_VIEWING_KEY=${INBOX_UFVK}
# Register a Zilkroad account with OPS_ADDRESS (it pays for purchases), then:
POOL_ZILKROAD_ADDRESS=${OPS_ADDR}
ZILKROAD_COOKIE=
EOF

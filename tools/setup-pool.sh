#!/usr/bin/env bash
# Creates the two SNARKPOT wallets (inbox + ops) with zingo-cli and prints the
# values for .env. Run once, on the machine that will run the engine.
#
#   ZINGO_BIN=/path/to/zingo-cli ./tools/setup-pool.sh
#
# It prints both wallets' recovery phrases. Write them down offline: they are
# the only way to recover the pot if this machine dies.
set -euo pipefail

ZINGO_BIN="${ZINGO_BIN:-zingo-cli}"
SERVER="${LIGHTWALLETD:-https://zec.rocks:443}"
BASE="${SNARKPOT_WALLETS:-$HOME/.snarkpot}"

command -v "$ZINGO_BIN" >/dev/null || { echo "zingo-cli not found; set ZINGO_BIN (see README \"Going live\")" >&2; exit 1; }
command -v jq >/dev/null || { echo "needs jq (brew install jq)" >&2; exit 1; }

z() { local w="$1"; shift; "$ZINGO_BIN" --data-dir "$BASE/$w" --server "$SERVER" --waitsync "$@" 2>/dev/null | sed -n '/^[{[]/,$p'; }

for w in inbox ops; do
  mkdir -p "$BASE/$w"
  chmod 700 "$BASE/$w"
  if [ ! -e "$BASE/$w/zingo-wallet.dat" ]; then
    echo "Creating $w wallet in $BASE/$w…" >&2
  fi
done

# Orchard receiver only (no Sapling, no transparent). After NU6.3 this receiver is the Ironwood receiver.
INBOX_ADDR=$(z inbox new_address o | jq -r .encoded_address)
OPS_ADDR=$(z ops new_address o | jq -r .encoded_address)
INBOX_UFVK=$(z inbox export_ufvk | jq -r .ufvk)

echo
echo "=== Recovery phrases (write these down offline, never commit them) ==="
echo "--- inbox"; "$ZINGO_BIN" --data-dir "$BASE/inbox" --server "$SERVER" --nosync recovery_info 2>/dev/null
echo "--- ops";   "$ZINGO_BIN" --data-dir "$BASE/ops"   --server "$SERVER" --nosync recovery_info 2>/dev/null
echo
echo "=== Add to .env ==="
cat <<EOF
SNARKPOT_MODE=live
ZINGO_BIN=$ZINGO_BIN
LIGHTWALLETD=$SERVER
INBOX_DATA_DIR=$BASE/inbox
OPS_DATA_DIR=$BASE/ops
POOL_ADDRESS=$INBOX_ADDR
OPS_ADDRESS=$OPS_ADDR
POOL_VIEWING_KEY=$INBOX_UFVK
# Register a Zilkroad account with OPS_ADDRESS (it pays for purchases), then:
POOL_ZILKROAD_ADDRESS=$OPS_ADDR
ZILKROAD_COOKIE=
EOF

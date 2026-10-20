#!/usr/bin/env bash
# zecPOT: creates the third wallet (treasury) and adds it to ~/snarkpot/.env,
# plus an OPERATOR_TOKEN for `npm run op`. Run once; stop the server first.
#
#   bash tools/add-treasury.sh
#
# It prints the treasury's recovery phrase and birthday. Write them down on paper.
set -euo pipefail

ZINGO_BIN="${ZINGO_BIN:-$HOME/bin/zingo-cli}"
SERVER="${LIGHTWALLETD:-https://zec.rocks:443}"
BASE="${SNARKPOT_WALLETS:-$HOME/.snarkpot}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env"
DIR="${BASE}/treasury"

[ -e "${ENV_FILE}" ] || { echo "no ${ENV_FILE}; run tools/write-env.sh first" >&2; exit 1; }
if grep -q '^TREASURY_ADDRESS=' "${ENV_FILE}"; then echo "${ENV_FILE} already has a treasury; nothing to do." >&2; exit 1; fi
command -v jq >/dev/null || { echo "needs jq: brew install jq" >&2; exit 1; }

z() {
  local out err
  err="$(mktemp)"
  if ! out="$("${ZINGO_BIN}" --data-dir "${DIR}" --server "${SERVER}" --waitsync "$@" 2>"${err}")"; then
    echo "zingo-cli ${1} failed:" >&2; tail -n 5 "${err}" >&2; rm -f "${err}"; exit 1
  fi
  rm -f "${err}"
  # first JSON value that starts a line, up to where its brackets balance
  printf '%s\n' "${out}" | awk '!on && /^[[{]/ {on=1} on {print; n=gsub(/[[{]/,"&"); m=gsub(/[]}]/,"&"); d+=n-m; if (d<=0) exit}'
}

mkdir -p "${DIR}"
chmod 700 "${DIR}"
echo "Creating the treasury wallet in ${DIR} (first run syncs, give it a minute)" >&2
ADDR="$(z new_address o | jq -r 'if type=="array" then .[0] else . end | .encoded_address')"
UFVK="$(z export_ufvk | jq -r .ufvk)"
for v in "${ADDR}" "${UFVK}"; do
  if [ -z "${v}" ] || [ "${v}" = "null" ]; then echo "zingo-cli returned an empty value; stopping" >&2; exit 1; fi
done
TOKEN="$(openssl rand -hex 20)"

{
  echo ""
  echo "# zecPOT treasury (receives the 5% fee, sweeps floor zkSNARKs; its viewing key is public)"
  echo "ZECPOT_MODE=live"
  echo "TREASURY_DATA_DIR=${DIR}"
  echo "TREASURY_ADDRESS=${ADDR}"
  echo "TREASURY_VIEWING_KEY=${UFVK}"
  echo "# For npm run op (operator to-dos). Keep it private."
  echo "OPERATOR_TOKEN=${TOKEN}"
} >> "${ENV_FILE}"

echo
echo "=== Treasury recovery phrase (write it down on paper, never commit or paste it) ==="
"${ZINGO_BIN}" --data-dir "${DIR}" --server "${SERVER}" --nosync recovery_info 2>/dev/null \
  | sed -n 's/^ *seed phrase: /phrase:   /p; s/^ *birthday: /birthday: /p'
echo
echo "Added the treasury to ${ENV_FILE}."
echo "TREASURY_ADDRESS: ${ADDR}"

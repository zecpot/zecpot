# SNARKPOT

A daily private draw for one zkSNARK. Buy 0.1 ZEC tickets with a shielded payment. When a round's pot covers the Zilkroad floor, a winner is drawn from a future Zcash block hash. The engine buys the floor zkSNARK and sends it to the winner's Zilkroad account.

Nobody, including the operator, learns who bought a ticket or who won.

No ZEC? The page can swap USDC or USDT from Phantom, MetaMask or any EVM or Solana wallet into your own shielded Zcash wallet, using NEAR Intents. You then pay the pot from there.

If a round closes before its pot covers the prize, its tickets roll into the next round automatically. Until that round closes, the owner can withdraw their ZEC instead, minus the network fee.

ZECATHON entry, Wildcard track. The protocol, privacy analysis and build plan are in **[SPEC.md](SPEC.md)**.

## Try it (mock chain, no ZEC needed)

```sh
npm install
npm run dev          # → http://localhost:8787
```

The demo panel at the bottom of the page lets you add strangers' tickets and mine blocks. To try the whole flow:

1. Buy tickets.
2. Click **Simulate this payment**.
3. Click **Mine to the next round**.
4. Paste your ticket code under **Check your tickets**. If you won, claim with any ID shaped like `ZR-7K4Q-M2XD`.

Other commands:

```sh
npm test             # protocol + engine tests
npm run simulate     # scripted end-to-end run, prints an independent verification
npm run verify -- 2  # re-check a published round file (var/data/rounds/2.json)
```

## Layout

| Path | What |
|---|---|
| `packages/core` | Pure protocol code shared by engine, site and verifier: ticket keys, memos, ZIP-321, ticket list, draw, claim signatures, `verifyRound` |
| `apps/engine` | Round state machine, JSON store, HTTP server, CLI. Adapters for wallet, chain and Zilkroad (`mock` + real) |
| `apps/web` | Static site, bundled with esbuild. Self-hosted font, no third-party requests |

## Status (15 Oct)

| Piece | State |
|---|---|
| Core protocol + tests | ✅ done |
| Engine: rounds, rollover, draw, purchase retry, refunds, claims, expiry → bonus, withdraw-or-roll | ✅ done on the mock chain |
| Web: buy (QR / ZIP-321), ticket code, client-side check, withdraw, claim, in-browser verify | ✅ done on the mock chain |
| Web: swap USDC/USDT → ZEC via NEAR Intents (Phantom / MetaMask / manual) | 🟡 built and tested with simulated wallets and a mocked 1Click. Live quotes confirmed from a browser. A real-money test swap is still to do |
| `ZingoPool` (inbox + ops wallets over zingo-cli) | ✅ written against zingolib's source (Oct 2026). Tested with zingo-cli's JSON shapes. Mainnet test pending on the operator's Mac |
| `LightwalletdChain` (draw block hash over gRPC) | ✅ tested against a local gRPC server. Byte order to confirm once with `npm run blockhash` |
| `HttpZilkroad` | 🟡 written against observed endpoints. Order response and status strings still unconfirmed |
| Live operation | ⏳ needs zingo-cli built on the Mac, wallets created, a Zilkroad session, then a small mainnet test |

## Going live (operator)

The live engine runs two zingo-cli wallets:
- **inbox:** receives tickets. Its full viewing key is published.
- **ops:** private. Pays Zilkroad and withdrawals.

It reads draw block hashes from the same lightwalletd server over gRPC. SPEC §5 and §8 explain why.

1. **Build zingo-cli** (on the Mac):
   ```sh
   brew install protobuf jq            # rustup too, if you don't have Rust
   git clone https://github.com/zingolabs/zingolib && cd zingolib
   cargo build --release --package zingo-cli   # rust-toolchain.toml pins Rust 1.99; rustup fetches it
   export ZINGO_BIN=$PWD/target/release/zingo-cli
   ```
   Note the zingolib commit you built from. The engine relies on its JSON output (SPEC §8).
2. **Create the wallets:** `./tools/setup-pool.sh`. It prints both recovery phrases, so write them down offline. It also prints the `.env` values.
3. **Zilkroad:** sign up with the **ops** address. Sign in by hand in a browser and put the session cookie in `ZILKROAD_COOKIE`. The engine does not and will not solve the Turnstile CAPTCHA.
4. **Check byte order once:** `npm run blockhash -- <recent height>` must match the hash an explorer shows for that block.
5. **Run:** `set -a; source .env; set +a; npm run serve`. This runs the site, the claim and withdraw API, and a tick every 60 s (`TICK_SECONDS`). For a public site, put it behind a host with access logs off.
6. **First live test:** pay 0.1 ZEC with a ticket memo from Zodl. Within a few minutes it should show up in the round and in `var/data/state.json`.

## Known limits

- **Custody.** The inbox and ops wallets hold the pot until the purchase. The published inbox viewing key makes every ticket payment, and every sweep to ops, auditable. It does not remove the trust.
- **Zilkroad endpoints are unofficial.** Ask @zilkroad_ for an API token. The fallback is manual mode, where the operator clicks buy and transfer on zilkroad.com.
- **Legal.** A paid-entry draw for a prize is a lottery. In most places, running an unlicensed lottery is an offence. This is a hackathon demo, so get legal advice before running it publicly.

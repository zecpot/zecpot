# SNARKPOT

A daily private draw for one zkSNARK. Buy 0.1 ZEC tickets with a shielded payment. When a round's pot covers the Zilkroad floor, a winner is drawn from a future Zcash block hash. The engine buys the floor zkSNARK and sends it to the winner's Zilkroad account.

Nobody, including the operator, learns who bought a ticket or who won.

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
| Engine: rounds, rollover, draw, purchase retry, refunds, claims, expiry → bonus | ✅ done on the mock chain |
| Web: buy (QR / ZIP-321), ticket code, client-side check, claim, in-browser verify | ✅ done on the mock chain |
| `ZingoWallet` (pool wallet over zingo-cli) | ⏳ skeleton. Command names and parsing still to fill in (SPEC §8) |
| `ExplorerChain` (block hash) | ⏳ skeleton |
| `HttpZilkroad` | 🟡 written against observed endpoints. Order response and status strings still unconfirmed |
| Live operation | ⏳ needs the two adapters above, plus a Zilkroad session |

## Going live (operator)

1. Build zingo-cli and create the pool wallet. Use an Orchard-only unified address. Export its UIVK.
2. Sign up on Zilkroad with the pool's shielded address. Sign in by hand in a browser and copy the session cookie. The engine does not and will not solve the Turnstile CAPTCHA.
3. Set the environment:
   ```sh
   SNARKPOT_MODE=live
   ZINGO_BIN=/path/to/zingo-cli
   ZINGO_DATA_DIR=~/.snarkpot-wallet
   LIGHTWALLETD=https://zec.rocks:443
   POOL_ADDRESS=u1…
   POOL_UIVK=uivk1…
   POOL_ZILKROAD_ADDRESS=u1…
   ZILKROAD_COOKIE='…'
   ```
4. Run `npm run tick` every 60 s (cron or launchd). Serve `apps/web/public` plus `var/data` from a static host with access logs off.

## Known limits

- **Custody.** The pool wallet holds the pot until the purchase. The published UIVK makes every incoming payment auditable. It does not remove the trust.
- **Zilkroad endpoints are unofficial.** Ask @zilkroad_ for an API token. The fallback is manual mode, where the operator clicks buy and transfer on zilkroad.com.
- **Legal.** A paid-entry draw for a prize is a lottery. In most places, running an unlicensed lottery is an offence. This is a hackathon demo, so get legal advice before running it publicly.

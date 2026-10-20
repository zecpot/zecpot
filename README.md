# zecPOT

zecPOT is a daily private ZEC pot. You buy tickets at **0.01 ZEC** each, as many as you like, with one shielded payment.

Once a day, one ticket is drawn from a future Zcash block hash. The winning ticket takes the whole pot, minus a **5% fee**, paid in ZEC to a shielded address.

The fee goes to a public treasury. When the treasury can afford it, it **buys the cheapest zkSNARK on Zilkroad**. Every week, one of those zkSNARKs goes to a random ticket from that week's pots.

Nobody, including the operator, learns who bought a ticket or who won.

Don't have ZEC? The page can swap USDC or USDT from Phantom, MetaMask or any EVM or Solana wallet into **your own** shielded wallet, using NEAR Intents. You then pay the pot from that wallet.

This is a ZECATHON entry in the Wildcard track. The protocol, the pot split and the privacy analysis are in **[SPEC.md](SPEC.md)**.

## Try it (mock chain, no ZEC needed)

```sh
npm install
npm run dev          # → http://localhost:8787
```

The demo panel at the bottom of the page lets you add other people's tickets, mine blocks and top up the treasury. To try the whole flow:

1. Buy tickets and click **Simulate this payment**.
2. Click **Close today's pot and draw**.
3. Paste your ticket code under **Check your tickets**. If you won, claim the prize with any shielded address. The mock chain accepts any `u1…` address.
4. Click **Top up the treasury**, then mine blocks. The treasury sweeps a zkSNARK, and every third mock pot draws it as a bonus. Claim it with an ID shaped like `ZR-7K4Q-M2XD`.

Other commands:

```sh
npm test             # protocol, engine, wallet-output and swap tests
npm run simulate     # scripted run: 3 pots, a sweep, a bonus, a Zilkroad outage → operator task; then verifies
npm run verify -- 2  # re-check a published round file (var/data/rounds/2.json)
```

## Layout

| Path | What |
|---|---|
| `packages/core` | Protocol code shared by the engine, the site and the verifier: ticket keys, memos, ZIP-321, draw, bonus draw, pot split, claim signatures, `verifyRound`/`verifyBonus` |
| `apps/engine` | Pot state machine, payouts, treasury sweeps, operator tasks, JSON store, HTTP server, CLI. Adapters for wallets, chain and Zilkroad (`mock` + real) |
| `apps/web` | Static site, bundled with esbuild. Self-hosted font. The only outside requests are made when you open the swap |
| `tools` | Wallet setup scripts for the operator's Mac |

## Status (20 Oct)

| Piece | State |
|---|---|
| Core protocol, engine, site (37 tests) | ✅ |
| Live inbox and ops wallets, mainnet | ✅ First real ticket paid 20 Oct. It is counted in pot 1 |
| Draw block hash over lightwalletd gRPC | ✅ Byte order checked against an explorer |
| Zilkroad session (cookie) | ✅ `/me` works |
| Treasury wallet, first live draw and prize payout | ⏳ 21 Oct |
| First live treasury sweep | ⏳ Once the treasury holds about 0.41 ZEC (floor × 1.05 + 0.002) |
| Swap (1Click) | 🟡 Tested with simulated wallets and live quotes. A real-money swap hasn't been run yet |

## Running it live (operator)

The live engine runs three zingo-cli wallets. SPEC §5 explains why it needs three.

| Wallet | Role | Viewing key |
|---|---|---|
| **inbox** | Receives tickets | Published |
| **ops** | Pays prizes, refunds and the 5% fee | Private |
| **treasury** | Receives fees, pays for zkSNARK sweeps | Published |

1. **Build zingo-cli** on the Mac:
   ```sh
   brew install protobuf jq
   git clone https://github.com/zingolabs/zingolib && cd zingolib
   cargo install cargo-make
   makers run-cli --build-only                   # mixnet build, also needs nym-proxy next to zingo-cli
   # or, if the Nym mixnet won't start on your network ("no proven exit"):
   makers run-cli --build-only --nakednet --features nakednet-test-mode
   mkdir -p ~/bin && cp target/release/zingo-cli ~/bin/
   ```
   Write down the zingolib commit you built from, because the engine relies on its JSON output.
2. **Create the wallets:**
   - Run `bash tools/setup-pool.sh` for inbox and ops. If those wallets already exist, run `tools/write-env.sh` instead.
   - Then run `bash tools/add-treasury.sh` for the treasury and `OPERATOR_TOKEN`.
   - Each script prints a recovery phrase and birthday. Write them on paper.
3. **Zilkroad:**
   - Sign up with the **treasury** address. Ops also works, but then the zkSNARKs sit with ops.
   - Sign in by hand and put the session cookie in `ZILKROAD_COOKIE`, in the format `cf_clearance=…; zr_session=…`.
   - If Cloudflare challenges the engine, set `ZILKROAD_USER_AGENT` too.
   - The engine never solves the Turnstile CAPTCHA.
4. **Run:**
   ```sh
   set -a; source .env; set +a
   npm run serve
   ```
   This serves the site and the claim API, and runs a tick every 60 s. For a public site, put it behind a host with access logs off.
5. **Operator to-dos.** If Zilkroad is down or the session has expired, sweeps and bonus deliveries become tasks instead of failing:
   ```sh
   npm run op -- tasks
   npm run op -- done <task id> <zkSNARK #> [txid]
   ```
   Do them by hand on zilkroad.com. Prizes are paid in ZEC and never wait on Zilkroad.

A SNARKPOT (v1) state file is migrated automatically on first start.

## Known limits

- **Custody.** The wallets hold the money between payment and payout. The published inbox and treasury viewing keys make it auditable, but you still have to trust the operator.
- **Zilkroad endpoints are unofficial.** Every call has a manual fallback.
- **Legal.** A paid-entry draw for a cash prize is a lottery. In most places, running an unlicensed lottery is an offence. This is a hackathon demo, so get legal advice before running it publicly.

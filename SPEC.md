# zecPOT: spec

A daily, private ZEC pot on Zcash.
- **Tickets:** 0.01 ZEC each, as many as you like, bought with one shielded payment.
- **Daily draw:** once a day, one ticket is drawn from a future block hash. It takes the whole pot minus a **5% fee**.
- **Treasury:** the fee goes to a public treasury that **sweeps floor zkSNARKs** on Zilkroad.
- **Weekly bonus:** every week, one of those zkSNARKs is drawn for a random ticket from that week's pots.

Target: ZECATHON, Wildcard track. Deadline: 28 Oct 2026, 23:59 UTC. Version: v0.2 (20 Oct 2026). It was renamed from SNARKPOT, and the mechanics changed from "the pot buys one zkSNARK".

---

## 1. Goals and non-goals

**Goals**
- **No identities.** Nobody, including the operator, learns who bought a ticket or who won. There are no accounts, no cookies and no analytics.
- **Verifiable.** Anyone can check every ticket, every draw, every fee, every payout and every sweep without trusting the operator.
- **Simple to use.** One QR payment buys tickets. One signed claim collects a prize.
- **Robust.** Prizes are paid in ZEC automatically. Zilkroad only matters for treasury sweeps and bonus delivery, and if its API fails, those become operator to-dos rather than errors.

**Non-goals (v1)**
- **Trustless custody.** The operator's wallets hold funds between payment and payout. This is made auditable with published viewing keys (§5), not removed.
- **Prize tiers** or multiple winners per pot.

## 2. Glossary

| Term | Meaning |
|---|---|
| Inbox wallet | Receives ticket payments. Its unified **full** viewing key is published. Its only outgoing transactions are sweeps to ops |
| Ops wallet | Private. Pays prizes, withdrawals and the 5% fee to the treasury |
| Treasury wallet | Receives the fees and pays for floor sweeps. Its full viewing key is published |
| Ticket key | Ed25519 key pair made in the buyer's browser. The public key goes in the memo. The secret key is the **ticket code** (`spk1…`) |
| Pot / round | One daily draw cycle, bounded by block heights |
| Ironwood | The shielded pool from NU6.3 (mainnet block 3,428,143, 28 Jul 2026). A UA's Orchard receiver *is* its Ironwood receiver |
| Zilkroad account | Pseudonymous account (`ZR-XXXX-XXXX`). zkSNARK ownership is recorded against it in Zilkroad's index |

## 3. User flows

### 3.1 Buy tickets
1. Pick a count n (1–500).
2. The browser makes a fresh Ed25519 key pair and shows the ticket code, which must be saved (copy or download).
3. A ZIP-321 QR code pays `n × 0.01 ZEC` to the inbox address, with memo `ZECPOT1 <pk>`.
4. Pay from a shielded balance. The UI warns that transparent payments reveal the payer.
5. Once mined, the tickets appear in today's pot. "Check your tickets" finds them client-side by matching the ticket code's public key, so no request carries the key.

### 3.2 Daily draw and prize claim
1. The pot closes at `closeHeight`. The draw uses the hash of block `seedHeight = closeHeight + 10`.
2. A pot with at least `minTickets` (1) is drawn. The engine computes the split (§4.4) and sends the fee to the treasury.
3. The winner pastes their ticket code and a **shielded address**. The browser signs:
   `ZECPOT1|claim|round=<r>|ticket=<i>|to=<sha256("ZECPOT1|dest|"+addr)>|amount=<prize zats>`
   and posts `{round, ticket, to, sig}` to `/api/claim`.
4. The engine checks the signature against the winning ticket's public key and the exact prize amount. Then ops pays the prize, with memo `ZECPOT1 prize round <r>`.
5. **Only the address hash is published,** with the signature and the payout txid. Anyone can check the winner authorised that payout without learning where it went.
6. **Unclaimed after 14 days** (`claimWindowBlocks`): the prize rolls into the open pot as carried money and is **not** charged the fee again.

### 3.3 Weekly bonus (zkSNARK)
1. **When:** on every pot whose number is divisible by 7 (`bonusEveryRounds`), if the treasury holds a zkSNARK it hasn't promised to anyone.
2. **Who's in it:** every ticket of the drawn pots from `r−6` to `r` is eligible, concatenated in pot order.
3. **The draw:** `winner = sha256("ZECPOT1|bonus|r|blockhash|listHash") mod N`. It uses the same seed block as pot r, under a different domain tag.
4. **Claiming:** the winner signs `ZECPOT1|bonus|round=<r>|ticket=<i>|to=<hash(ZR-…)>|snark=<id>` with a Zilkroad account ID. The engine transfers the zkSNARK through the API, or creates a transfer task for the operator if the API fails.
5. **Unclaimed after 14 days:** the zkSNARK goes back to the treasury for a later week.

### 3.4 No ZEC yet: swap stablecoins
**Sources:** USDC on Solana, Arbitrum, Base or Ethereum, plus USDT on Ethereum. Availability is checked live.

**Flow:**
1. **Open the swap.** The ZEC amount defaults to the ticket count × 0.01 + 0.0002.
2. **Fill it in.** The user enters **their own** shielded address and connects a wallet:
   - Solana: Wallet Standard (Phantom, Solflare, Backpack).
   - EVM: EIP-6963 (MetaMask, Rabby, Phantom, Coinbase).
   - Or a manual send with a refund address.
3. **Quote.** The browser calls NEAR Intents 1Click **directly**: `EXACT_OUTPUT` into `nep141:zec.omft.near`.
4. **Send.**
   - Solana: a hand-built create-ATA + TransferChecked transaction, tested against `@solana/web3.js`.
   - EVM: an ERC-20 `transfer`.
5. **Track** with `/v0/status`.
6. **Pay the pot** from the user's own shielded balance.

**Why the swap never pays the pot directly:** the bridge payout's transparent inputs and timing, plus the inbox's published viewing key, would link the source wallet to the ticket. With the two-hop design, the swap only shows "this wallet bought some ZEC". The zecPOT server never sees the swap. Cost is about 1.7%, including 1Click's +0.25% for unauthenticated calls.

### 3.5 Withdraw rolled tickets
- A pot only rolls if it has fewer than `minTickets` (1), so in practice nothing rolls with tickets in it.
- The mechanism stays for completeness: tickets carried in from a rolled pot can be withdrawn while the next pot is open, to a shielded address, for `n × 0.01 − fee`, where fee = `5000 × max(2, n+1)` zats.

## 4. Protocol

### 4.1 Parameters

| Param | Default | Notes |
|---|---|---|
| `ticketZats` | 1,000,000 | 0.01 ZEC |
| `roundBlocks` | 1152 | About 24 h at 75 s |
| `seedDelay` / `reorgSafety` | 10 / 10 | Seed block = close + 10. Draw once tip ≥ seed + 10 |
| `feeBps` | 500 | 5% of new money in each drawn pot, to the treasury |
| `minTickets` | 1 | Fewer → the pot rolls |
| `claimWindowBlocks` | 16,128 | About 14 days, for prizes and bonuses |
| `feePerActionZats` | 5,000 | ZIP-317 marginal fee |
| `sweepBufferBps` / `sweepReserveZats` | 500 / 200,000 | Treasury sweeps when it holds floor × 1.05 + 0.002 |
| `bonusEveryRounds` | 7 | Weekly bonus |

### 4.2 Tickets
- **Memo:** `ZECPOT1 <pk>`, where `<pk>` is 43 base64url chars. The legacy tag `SNARKPOT1` is still accepted. Trailing NULs and whitespace are ignored.
- **Tickets per payment:** `floor(amount / ticketZats)`. A remainder, or a payment with no valid memo, goes into the pot as a donation.
- **Ticket line:** `<txid>:<outIndex>:<k>:<pk>`. The pot's list is sorted by (height, txid, outIndex, k), with tickets carried from a rolled pot first. `listHash = sha256(lines.join("\n"))`.
- **Which pot:** a payment counts in pot r if `openHeight_r < height ≤ closeHeight_r`.

### 4.3 Draw
```
seed   = sha256_hex("ZECPOT1|draw|" + r + "|" + blockHashHex(seedHeight) + "|" + listHash)
winner = BigInt("0x" + seed) mod N
```
- Block hashes are in explorer display order (lowercase hex), hashed as text.
- The ticket list is fixed before the seed block exists.

### 4.4 Pot split
```
feeBase  = ticket payments + donations this pot   (new money)
carried  = rolled-in pots + unclaimed prizes      (fee-free)
fee      = floor(feeBase × 5%)
network  = (paymentNotes + 5) × 5000 zats        (each payment note is spent once when swept; +5 covers payout and fee transfer)
prize    = feeBase + carried − fee − network
```

**Example: 100 tickets in 20 payments (1 ZEC).**
- fee = 0.05 ZEC
- network = 0.00125 ZEC
- **prize = 0.94875 ZEC (94.9%)**

**A single 0.01 ticket** still pays out 0.0092 ZEC.

The verifier recomputes the split from the published round file.

### 4.5 Treasury sweeps
1. **Trigger:** each tick, the engine reads the treasury balance. If it's at least `floor × 1.05 + 0.002`, it buys the cheapest listing within budget.
2. **Buying:**
   - `POST /market/orders {listingId, buyerAddress}` with the pot's Zilkroad account address.
   - The **treasury** wallet pays `remainingZec` to `depositAddress` with memo = `code`.
   - The engine polls the order until it's paid, then records `{snarkId, priceZats, txid}`.
3. **Race lost or expired:** the engine tries the next listing, up to 5 attempts.
4. **API failure** (session expired, Cloudflare, endpoint changed): the sweep becomes a **buy task** for the operator, who completes it with `npm run op -- done <task> <zkSNARK #> [txid]`.

### 4.6 Fee transfer
- At draw time, ops sends `fee` to the treasury address with memo `ZECPOT1 fee round <r>`.
- The treasury's published viewing key shows each one arriving. Anyone can match it against 5% of that pot's published fee base.

## 5. Transparency

**Published:**
- The inbox address (Orchard/Ironwood receiver only).
- The **inbox UFVK**: every ticket payment (amount, memo, txid, never the sender), plus the inbox's sweeps to ops.
- The **treasury UFVK**: every fee in, and every sweep payment out to Zilkroad.
- **Round files** at `/data/rounds/<r>.json`: params, heights, ticket lines, listHash, seed hash, winner, split, fee txid, claim `{toHash, amountZats, sig, txid}`, and bonus `{snarkId, rounds, listHash, winner, claim}`.
- **The verifier:** `npm run verify -- <r>`, also built into the site's "Verified" badge. It recomputes listHash, the winner, the split, the claim signature and the bonus draw.

**Why three wallets:**
- zingolib always sends with the outgoing viewing key enabled (`OvkPolicy::Sender`). A published UFVK therefore reveals where that wallet sent money.
- The two published wallets only ever send to places that are fine to show: inbox → ops, and treasury → Zilkroad.
- Prizes and refunds go out from ops, whose key stays private.

## 6. Privacy analysis

| What | Who learns it | Mitigation |
|---|---|---|
| Who bought a ticket | Nobody, if paid from shielded funds | Shielded-only inbox address. UI warns against transparent payments. Legacy Orchard balances should be migrated to Ironwood first, because crossing the ZIP 318 turnstile in the same transaction publishes the amount |
| Links between purchases | Nobody, because each purchase uses a fresh key | Keys are never reused |
| Ticket ↔ site visitor | Nobody | Static site, no logs, no cookies, no analytics, self-hosted font, client-side lookups |
| Winner's payout address | Operator only | Shielded only. Published as a hash. UI recommends a fresh address |
| Bonus winner's Zilkroad account | Operator, plus Zilkroad's transfer record | Published as a hash. UI recommends a fresh account |
| Ticket amounts | Inbox UFVK holders see multiples of 0.01 | Fixed denomination |
| Claim-time IP | Operator's HTTP endpoint (and Cloudflare, if tunnelled) | No request logging. Documented |
| Operator ↔ lightwalletd | zec.rocks sees the operator's IP (direct build) | Operator-side only. Players' privacy is unaffected |
| Stablecoin swap ↔ the user's own Zcash address | Public chain + NEAR Intents | Swap goes to the user's own wallet, never to the pot. The UI advises extra amount and a delay |

## 7. Zilkroad integration

These are **unofficial** endpoints, the ones zilkroad.com's own front-end uses, observed 15–20 Oct. Base: `https://zilkroad.com/api`.

| Call | Use |
|---|---|
| `GET /market/stats` | `floorZec` |
| `GET /market/tokens` | Listings: `listed`, `ask`, `listingId`, `buying`, `purged` |
| `POST /market/orders` · `GET /market/orders/:id` | Buy (treasury sweeps) |
| `POST /market/transfers` | `{snarkId, toAccountId}` (bonus delivery) |
| `GET /me` | Session check |

**Auth:** the session cookie (`cf_clearance=…; zr_session=…`) comes from a manual sign-in. Turnstile is never automated. Optional: `ZILKROAD_USER_AGENT`.

**Fallback:** every failure becomes an operator task (`npm run op -- tasks`). Prizes never depend on Zilkroad.

## 8. Architecture

```
packages/core   tickets, memos, ZIP-321, draw, bonus draw, pot split, claims, verifier
apps/engine     engine.ts      state v2: pots, payouts queue, treasury sweeps, bonus, tasks
                adapters/zingo ZingoPool (inbox+ops) · ZingoTreasury · LightwalletdChain (gRPC)
                adapters/zilkroad-http · adapters/mock
                server.ts      static site, /data, /api/claim, /api/bonus-claim, /api/withdraw, /api/operator (token)
                cli.ts         serve | simulate | tick | op | verify | blockhash
apps/web        static site; swap/ (1Click, EIP-6963, Wallet Standard)
tools           setup-pool.sh · write-env.sh · add-treasury.sh
```

**zingo-cli** (zingolib, Oct 2026) runs one command per process:
- Form: `zingo-cli --data-dir D --server S [--waitsync|--nosync] <cmd>`. JSON goes to stdout between status lines.
- Commands used:
  - `height`
  - `notes all`: `{ironwood_notes: {note_summaries: [...]}, …}`. Only confirmed `scope: "external"` notes count.
  - `max_send_value <addr>`
  - `quicksend <addr> <zats> "<memo>"`: returns `{txids, transmissions}`
  - `spendable_balance`
  - `export_ufvk`
- Each wallet syncs once per tick.
- The operator's build is direct-connection (`--nakednet --features nakednet-test-mode`), because the Nym mixnet start-up failed on the operator's network and would cost minutes per call.

**Draw block hash:** lightwalletd `GetBlock(height).hash`, reversed to display order. It's checked once by hand with `npm run blockhash`.

**State migration:** a v1 (SNARKPOT) state is rebuilt as v2 at the same open height, and its payments are re-read. The live 0.1 ZEC ticket becomes 10 tickets.

## 9. Build plan (to 28 Oct)

| When | Work |
|---|---|
| 15–20 Oct | ✅ Core, engine, site, swap, live wallets on mainnet, first real ticket (20 Oct) |
| 20 Oct | ✅ zecPOT mechanics (this spec) |
| 21 Oct | Treasury wallet on the Mac; first live draw and prize payout; first fee into the treasury |
| 22–24 Oct | Public URL (cloudflared). Seed the treasury enough for one sweep and test it (API or manual task) |
| 25–27 Oct | README privacy table, 2-minute video, public repo |
| 28 Oct | Submit (Wildcard) |

## 10. Risks

- **Legal.** A paid-entry draw for a cash prize is plainly a lottery. Most places restrict lotteries, and running one without a licence is often an offence. Keep it a small hackathon demo, and get legal advice before any public launch.
- **Custody.** Three hot wallets. Keep balances small, publish two viewing keys, and pay out promptly.
- **Zilkroad API.** Unofficial. Every call has a manual fallback, and prizes don't depend on it.
- **zingo-cli changes.** It's moving fast (Ironwood, mixnet). Pin the built commit. The adapters are tested against its real output.
- **Low volume.** At 1 ZEC a day, the treasury sweeps a 0.384 ZEC floor about every 8 days. At low volume, the weekly bonus may skip weeks until the first sweep.

## 11. Judging fit

- **Privacy:** no accounts, shielded-only entry, client-side keys, hashed payout destinations, three-wallet design with a stated reason, and a leak table.
- **Usefulness:** one QR payment buys tickets, prizes are real ZEC, and every pot sweeps the organisers' zkSNARK floor.
- **Execution:** live on mainnet, with a real ticket since 20 Oct. Mock mode lets anyone run the whole loop.
- **Originality:** a verifiable daily ZEC pot whose house fee is transparent, sweeps NFTs, and gives them back to players.

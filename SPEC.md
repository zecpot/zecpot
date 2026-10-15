# SNARKPOT: spec

A daily, privacy-preserving draw for one zkSNARK. People buy 0.1 ZEC tickets with a shielded payment. Once a round's pot can cover the Zilkroad floor, a winner is drawn from a future Zcash block hash. The engine then buys the floor zkSNARK and transfers it to the winner's Zilkroad account.

- Target: ZECATHON, Wildcard track (alternative: Private Markets).
- Deadline: 28 Oct 2026, 23:59 UTC.
- Status: draft v0.1, 15 Oct 2026.

---

## 1. Goals and non-goals

**Goals**
- **No identities.** The operator never learns who bought a ticket or who won. There are no accounts, cookies, analytics or third-party requests.
- **Verifiable.** Anyone can check the pot, the ticket list, the draw and the delivery without trusting the operator.
- **Simple to use.** One shielded payment from Zodl or any Orchard wallet. Scanning a QR code is the whole entry.
- **Demo-able end to end.** A real mainnet round runs before submission, plus a mock mode for judges.

**Non-goals (v1)**
- Trustless custody. The operator holds the pot between payment and purchase. This is made auditable (§5), not removed.
- Refunds for losing tickets in a drawn round. Their ZEC has paid for the prize. Only tickets from **unfilled** rounds can be withdrawn (§4.7).
- Multiple collections or prize tiers.

## 2. Glossary

| Term | Meaning |
|---|---|
| Pool wallet | The operator's Orchard-only wallet that receives ticket payments and pays Zilkroad |
| Ticket key | An Ed25519 key pair made in the buyer's browser. The public key goes in the memo; the secret key is the **ticket code** the buyer keeps |
| Round | One draw cycle, bounded by block heights |
| Pot | ZEC held for the current round, including carried-over surplus |
| Target | The amount needed to draw: floor × (1 + buffer) + fee reserve |
| Zilkroad account | A pseudonymous account like `ZR-7K4Q-M2XD`. Zilkroad's index records zkSNARK ownership against it |

## 3. User flows

### 3.1 Buy tickets
1. The user opens the site and picks a ticket count n (1–20).
2. The browser generates a fresh Ed25519 key pair (WebCrypto randomness, via `@noble/curves`).
3. The site shows the **ticket code** `spk1…` (the secret key) with "copy" and "download .txt" buttons. The user must confirm they saved it. It is also stored in `localStorage` as a convenience, with every access wrapped in try/catch.
4. The site shows a ZIP-321 URI and QR code:
   `zcash:<POOL_UA>?amount=<0.1·n>&memo=<base64url("SNARKPOT1 " + pk_b64url)>`
5. The user pays from a shielded wallet. The site states plainly: *pay from a shielded balance; paying from a transparent address reveals you on chain.*
6. Once mined, the payment shows up in the public ticket list. The user can find their ticket by pasting the ticket code; the match runs client-side (§3.3).

### 3.2 Draw and claim
1. The round closes at `closeHeight`. The draw uses the hash of block `seedHeight = closeHeight + SEED_DELAY`.
2. If the pot is at least the target, the winner is computed (§4.3) and published. The engine immediately buys the cheapest listing within budget, into the pool's Zilkroad account.
3. The winner pastes their ticket code and their Zilkroad account ID (we recommend a fresh account). The browser signs:
   `SNARKPOT1|claim|round=<r>|ticket=<i>|to=<ZR-XXXX-XXXX>`
   and POSTs `{round, ticket, to, sig}` to `/api/claim`. The ticket code itself never leaves the browser.
4. The engine verifies the signature against the winning ticket's public key, transfers the zkSNARK, and publishes `{to, sig, transferAt}` in the round file.
5. If no claim arrives within `CLAIM_WINDOW` (14 days), the held zkSNARK becomes a bonus second prize in the next drawn round.

### 3.3 Pot didn't fill: withdraw or roll
1. A round closes with `pot < target`. Its tickets move into the next round automatically (§4.4).
2. **Doing nothing means staying in.** While that next round is open, the ticket check shows: "N tickets came from a round that didn't fill… Withdraw X ZEC".
3. To withdraw, the user enters a **shielded** address (u1/zs1). We recommend a fresh one. The browser signs:
   `SNARKPOT1|withdraw|round=<r>|pk=<pk>|tickets=<n>|amount=<zats>|to=<addr>`
   and POSTs `{round, pk, to, sig}` to `/api/withdraw`.
4. The engine removes all of that key's carried tickets from the open round, lowers the pot, and sends `n × 0.1 − fee` on the next tick.
5. Once the round closes, its tickets are locked into it. If it draws, they're in the draw. If it rolls again, they can be withdrawn from the round after.

### 3.4 No ZEC yet: swap stablecoins
**Supported sources:** USDC on Solana, Arbitrum, Base and Ethereum, plus USDT on Ethereum. Availability is live. On 15 Oct, Base USDC wasn't quotable, and the UI says so when that happens.

**Flow:**
1. **Open the swap.** "No ZEC yet? Swap USDC or USDT" opens it. The ZEC amount defaults to the ticket count × 0.1 + 0.0002, the extra covering the fee on the later pot payment.
2. **Fill it in.** The user picks a source, enters **their own** shielded Zcash address, and connects a wallet:
   - Solana: Wallet Standard (Phantom, Solflare, Backpack).
   - EVM: EIP-6963 (MetaMask, Rabby, Phantom, Coinbase Wallet).
   - Or send manually from an exchange, with a refund address.
3. **Quote.** The browser calls NEAR Intents 1Click **directly** with `POST /v0/quote`: `EXACT_OUTPUT` into `nep141:zec.omft.near`, recipient the user's shielded address, refund to the connected address on the source chain, 30-minute deadline.
4. **Send.** "Send X USDC with Phantom":
   - **Solana:** a hand-built legacy transaction with create-ATA-idempotent plus TransferChecked to the 1Click deposit address. The wallet signs and sends it. This is tested against `@solana/web3.js` and `@solana/spl-token`.
   - **EVM:** `eth_sendTransaction` of an ERC-20 `transfer`, after switching to the right chain.
5. **Track.** `POST /v0/deposit/submit`, then poll `GET /v0/status` until `SUCCESS`, `REFUNDED` or `FAILED`.
6. **Pay the pot.** The user pays from their own shielded balance with the normal QR flow (§3.1).

**Why not swap straight into the pot?**
- The pool's UIVK is public, so its incoming txids are public.
- The bridge's ZEC payout transaction has public transparent inputs. Its timing and amount match the public USDC deposit, and 1Click records it.
- Together, that would let anyone tie the EVM or Solana wallet to the ticket. Under the rules, that's a disqualifying leak.
- With the two-hop design, the swap only shows that "this wallet bought ZEC into some shielded address". The z→z payment to the pot reveals nothing about where it came from.
- The UI advises swapping a little extra and waiting before paying, to blunt amount and timing matching.

**Server involvement:** none. The SNARKPOT server never sees the swap. The CSP allows `connect-src` to `1click.chaindefuser.com` and `api.mainnet-beta.solana.com` (for the blockhash) only.

**Cost:** about 1.7% on 15 Oct, for example 20 USDC → 0.01799 ZEC. That includes 1Click's +0.25% fee for unauthenticated calls. A partner key would remove that fee, but it would have to sit on a server, which would then see swaps, so we don't use one.

### 3.5 Check a ticket
- The site downloads the public round files and matches the ticket code's public key locally.
- No request carries a key, so the server can't link a visitor to a ticket.

## 4. Protocol

### 4.1 Units and parameters
All amounts are integer zatoshis (1 ZEC = 1e8).

| Param | Default | Notes |
|---|---|---|
| `TICKET_ZATS` | 10,000,000 | 0.1 ZEC |
| `ROUND_BLOCKS` | 1152 | About 24 h at a 75 s block target |
| `SEED_DELAY` | 10 | Blocks after close whose hash seeds the draw |
| `REORG_SAFETY` | 10 | Wait until tip ≥ seedHeight + 10 before drawing |
| `BUFFER_BPS` | 500 | 5% over floor, covering floor moves before purchase |
| `FEE_RESERVE_ZATS` | 200,000 | 0.002 ZEC for network fees (ZIP-317) |
| `HOUSE_FEE_BPS` | 0 | No operator cut in the hackathon version |
| `CLAIM_WINDOW_BLOCKS` | 16,128 | About 14 days |
| `FEE_PER_ACTION_ZATS` | 5,000 | ZIP-317 marginal fee. A withdrawal of n tickets is charged 5,000 × max(2, n+1) |

### 4.2 Tickets
- **Memo format:** UTF-8 `SNARKPOT1 <pk>`, where `<pk>` is the 32-byte Ed25519 public key in base64url (43 chars). Trailing NULs and whitespace are ignored.
- **Tickets per payment:** `floor(amount / TICKET_ZATS)`. Any remainder goes to the pot.
- **Invalid or missing memo:** the payment goes to the pot as a donation and creates no ticket. The UI warns about this before payment.
- **Ticket line:** each ticket is the line `<txid>:<outIndex>:<k>:<pk>` for k = 0..count-1.
- **Round ticket list:**
  - Tickets carried over from unfilled rounds come first, in their original order.
  - New tickets follow, sorted by (height, txid, outIndex, k).
- **List hash:** `listHash = sha256_hex(lines.join("\n"))`.
- **Which round:** a payment counts in round r if `openHeight_r < height ≤ closeHeight_r`.

### 4.3 Draw
```
seed   = sha256_hex("SNARKPOT1|draw|" + r + "|" + blockHashHex(seedHeight) + "|" + listHash)
winner = BigInt("0x" + seed) mod N
```
- `blockHashHex` is the block hash exactly as explorers display it (lowercase hex). Hashing it as text avoids byte-order ambiguity.
- The ticket list is fixed at `closeHeight`, before the seed block exists. The operator can't see the seed early and can't reorder tickets afterwards, because the order is defined by chain data.
- **Miner influence:** a miner could withhold a block to re-roll the draw. That is only worth it if the prize exceeds the block reward, and the prize is about 0.55 ZEC, so this is acceptable.

### 4.4 Close outcomes
- **`pot ≥ target` and N ≥ 1:** status `drawn`. All of the round's tickets are used up. After the purchase, the surplus `pot − price − fees` carries to the next round's pot.
- **`pot < target`:** status `rolled`. Every ticket and the whole pot carry into round r+1. The site shows how many more tickets are needed: `ceil((target − pot) / TICKET_ZATS)`. Carried tickets are listed first, and the round record gives their count as `carriedCount`. Their owners can withdraw them while r+1 is open (§4.7).
- **Example (15 Oct):** floor 0.548 → target 0.548 × 1.05 + 0.002 = 0.5774 ZEC, so **6 tickets**.

### 4.5 Purchase
1. Fetch listings and pick the cheapest with `price ≤ pot − FEE_RESERVE`.
2. `POST /api/market/orders {listingId, buyerAddress: POOL_ZILKROAD_ADDRESS}` returns `{order: {id, code, depositAddress, remainingZec, expiresAt}}`.
3. The pool wallet sends `remainingZec` to `depositAddress` with memo = `code`.
4. Poll `GET /api/market/orders/:id` until paid, or until it expires or another buyer wins the race. On a race loss, retry with the next listing, up to 5 attempts. If nothing is affordable, stay in `purchase_pending` and retry each tick.
   - **Assumption to confirm with Zilkroad:** a losing payment is refunded to the payer, with the order code in the memo.
   - The engine remembers lost order codes and treats an incoming payment carrying one as a refund, not pot money.
   - It doesn't place a new order until the wallet's spendable balance covers it.
5. Record `{snarkId, priceZats, orderId, paymentTxid}` in the round file.

### 4.6 Transfer
- `POST /api/market/transfers {snarkId, toAccountId}`, sent after a valid claim (§3.2).

### 4.7 Withdraw (unfilled rounds only)

**Eligibility**
- Only the **carried** tickets of the **currently open** round can be withdrawn.
- Tickets bought fresh into the open round can't be withdrawn. Neither can tickets in a closed or drawn round.

**Unit**
- Withdrawals are per ticket key. All of a key's carried tickets go together, n tickets in total.

**Amounts**
- `fee = FEE_PER_ACTION_ZATS × max(2, n + 1)`.
  - The pool holds many 0.1 ZEC notes, so a payout may spend about n notes, and ZIP-317 charges per action with a minimum of 2.
  - It's set conservatively. Any excess over the real fee stays in the wallet as float.
- `amount = n × TICKET_ZATS − fee`.
- The open round's pot drops by `n × TICKET_ZATS`.

**Signature**
- Ed25519 by the ticket key over the withdraw message (§3.3).
- It binds the round, the key, the ticket count, the exact amount and the destination, so it can't be replayed or redirected.

**Destination**
- Shielded only (u1… / zs1…). A transparent address is refused, because it would expose the refund on chain.

**Publication**
- The round record lists `withdrawn: [{tickets, amountZats, feeZats, txid}]`. That's enough to audit the pot arithmetic.
- **The destination address is never published.** Only the operator's engine sees it.

**Payout**
- The pool sends `amount` with memo `SNARKPOT1 refund` on the next tick. A failed send stays queued and retries.

## 5. Transparency

- **Published at launch:**
  - The pool's unified address (Orchard receiver only).
  - The pool's **unified incoming viewing key (UIVK)**. Anyone can import it into a view-only wallet and see every payment received: amounts, memos and txids. They can't see senders, and they can't spend.
- **Round files:** each round is published as `/data/rounds/<r>.json`, containing params, heights, ticket lines, listHash, seed block hash, winner index, purchase record and claim record.
- **Verifier:** `npm run verify -- <r>` recomputes listHash and the winner from the round file. The site has the same verifier in-browser, with links to the seed block on an explorer.
- **Outgoing payments are not shown by the UIVK.** Purchases are evidenced instead by Zilkroad's public provenance (`order_paid` / `transfer` events on the zkSNARK) and the published payment txid.

## 6. Privacy analysis

| What | Who learns it | Mitigation |
|---|---|---|
| Who bought a ticket | Nobody, if paid from shielded funds | Orchard-only pool address. UI warns against transparent payments |
| Links between one person's tickets | Nobody, because each purchase uses a fresh key | Keys are never reused. The "buy again" flow always makes a new key |
| Ticket ↔ site visitor | Nobody | Static site, no logs, no cookies, no analytics, fonts self-hosted. Ticket lookups run client-side |
| Winner's identity | Nobody; the operator learns only a Zilkroad account ID | Recommend a fresh Zilkroad account. The claim POST carries only {round, ticket, to, sig} |
| Winner's account ID | Public, in the round file and on Zilkroad provenance | Needed so anyone can verify delivery. It's a pseudonym, so use a fresh one |
| Amount patterns | Observers of the UIVK see amounts, which are multiples of 0.1 | Fixed denominations keep amounts uninformative |
| Claim-time IP | Operator's HTTP endpoint | No request logging. Documented as Tor-friendly |
| Withdrawal address | Operator only | Shielded addresses only. Never published. The UI recommends a fresh address |
| That a key withdrew | Public: its ticket lines appear under `withdrawn` | The key is a one-time pseudonym, so this reveals nothing about the person |
| Stablecoin swap: source wallet ↔ the user's own Zcash address | Public chain + NEAR Intents | Swap goes to the user's own wallet, never to the pot. The pot payment is a separate z→z payment. The UI advises extra amount and a delay |

Leaks are disqualifying under the rules, so the README will include this table and say plainly that custody is trusted (§1).

## 7. Zilkroad integration

These are **unofficial** endpoints, taken from Zilkroad's front-end on 15 Oct 2026. The base is `https://zilkroad.com/api`.

| Call | Use |
|---|---|
| `GET /market/stats` | `floorZec`, `minOfferZec`, sales |
| `GET /market/tokens` | Token catalogue and listings (field mapping still to confirm) |
| `GET /snarks/:id` | `{listing: {id, priceZec}}` |
| `POST /market/orders` | `{listingId, buyerAddress}` returns an order with deposit address and memo code |
| `GET /market/orders/:id` | Order status |
| `POST /market/transfers` | `{snarkId, toAccountId}` |
| `GET /me` | Session check: `{accountId, snarks, canTrade, canTransfer}` |

**Auth**
- Sign-in uses `/auth/code` then `/auth/verify`. Both need a Cloudflare Turnstile token (CAPTCHA). **We do not automate this.**
- The operator signs in by hand in a browser and gives the session cookie to the engine (`ZILKROAD_COOKIE`). The engine checks `/me` on each tick and alerts when the session expires.
- **Ask Zilkroad (@zilkroad_) for an API token or bot allowance.** If they say no, use **manual mode**: the engine queues "buy listing X" and "transfer #N to ZR-…" tasks on the operator page, and the operator clicks them on zilkroad.com.

## 8. Architecture

```
snarkpot/
  packages/core     pure TS, shared by engine, web and verifier
                    ticket memo · ticket list · listHash · draw · claim msg · sign/verify · target math
  apps/engine       Node service, one process
                    adapters/wallet   WalletAdapter: zingo-cli (real) | mock
                    adapters/chain    block hash by height: lightwalletd | mock
                    adapters/zilkroad ZilkroadClient: http (cookie) | mock | manual
                    rounds.ts         state machine: open → closed → rolled | drawn → purchased → claimed
                    store.ts          JSON state with atomic writes, plus public /data files
                    server.ts         GET /data/*, GET /api/state, POST /api/claim; also serves the web build
                    cli.ts            tick | simulate | verify
  apps/web          static site (esbuild). Buy, my tickets, rounds, verify, claim
```

**Wallet:** zingo-cli (zingolib) against `https://zec.rocks:443`, called one command at a time with `--waitsync`. Its exact command names and output format still need to be verified on day 1. If zingo-cli doesn't work out, write a small Rust sidecar on `zcash_client_backend` + `zcash_client_sqlite` behind the same `WalletAdapter` interface.

**WalletAdapter**
```ts
height(): Promise<number>
incoming(sinceHeight): Promise<{txid, outIndex, height, zats, memo}[]>
send(to, zats, memo): Promise<txid>
balance(): Promise<{spendableZats}>
```

**Tick loop** (every 60 s):
1. Sync and ingest incoming payments.
2. Advance the round if tip ≥ closeHeight.
3. Draw if tip ≥ seedHeight + REORG_SAFETY.
4. Purchase if pending.
5. Process claims.
6. Publish JSON.

## 9. Build plan (15 → 28 Oct)

| Days | Work |
|---|---|
| 15–16 | Repo, core lib and tests, mock end-to-end simulate (**done in the scaffold**). Ask Zilkroad about API access |
| 16–18 | zingo-cli adapter: build, create the pool wallet, export the UIVK, parse incoming memos, send with memo. Test with small mainnet amounts |
| 18–19 | Chain adapter (block hash), real round timing, persistence |
| 19–21 | Zilkroad http client: listings, orders, payment, transfers. Manual-mode fallback |
| 21–24 | Web: buy flow (QR / ZIP-321), ticket-code UX, my tickets, rounds, verifier, claim. Design pass |
| 24–26 | Live mainnet round, ideally 2. Fix what breaks |
| 26–28 | README with privacy table, 2-minute video, public repo, submit (Wildcard) |

## 10. Risks

- **Legal.** A paid-entry draw for a prize is a lottery. Most places restrict lotteries, and running one without a licence is often an offence. Keep the hackathon version a small demo. Get legal advice before any public launch.
- **Zilkroad API changes or refusal.** Mitigated by manual mode and by the adapter boundary.
- **Session expiry or CAPTCHA.** The operator re-signs in by hand, and the engine alerts.
- **Custody.** The operator wallet is a hot wallet. Keep a small balance, publish the UIVK, and purchase promptly.
- **zingo-cli surprises.** The Rust sidecar is the fallback. The adapter interface keeps the rest unaffected.
- **Floor spikes after the draw.** The 5% buffer helps. Otherwise the round waits in `purchase_pending` and retries.

## 11. Judging fit

- **Privacy:** no accounts, shielded-only entry, keys made client-side, client-side lookups, and a stated leak table.
- **Usefulness:** one QR payment buys a ticket, and it brings daily buyers to the zkSNARK floor.
- **Execution:** a live mainnet round, plus mock mode for anyone to run.
- **Originality:** a draw verifiable with a published viewing key, with prize delivery to a pseudonymous account.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS, newTicketKey, signClaim, ticketMemo, type Params } from "../../../packages/core/src/index.ts";
import { MockChain, MockZilkroad } from "../src/adapters/mock.ts";
import { Engine, initialState, parseLine } from "../src/engine.ts";

const P: Params = { ...DEFAULT_PARAMS, roundBlocks: 20, seedDelay: 2, reorgSafety: 1, claimWindowBlocks: 50 };

function setup() {
  const chain = new MockChain(1000);
  const market = new MockZilkroad(chain);
  const engine = new Engine(
    initialState({ startHeight: 1000, poolAddress: "u1pool", poolZilkroadAddress: "u1pool", uivk: "uivk", params: P }),
    { wallet: chain, chain, market },
  );
  return { chain, market, engine };
}

const buy = (chain: MockChain, n = 1) => {
  const k = newTicketKey();
  chain.pay(n * P.ticketZats, ticketMemo(k.pk));
  return k;
};

test("under-filled round rolls tickets and pot forward", async () => {
  const { chain, engine } = setup();
  buy(chain, 2);
  chain.mine(P.roundBlocks);
  await engine.tick();
  const [r1, r2] = engine.state.rounds;
  assert.equal(r1!.status, "rolled");
  assert.equal(r2!.status, "open");
  assert.equal(r2!.potZats, 2 * P.ticketZats);
  assert.equal(r2!.tickets.length, 2);
});

test("payments land in the round whose window contains their height", async () => {
  const { chain, engine } = setup();
  buy(chain); // height 1001 → round 1
  chain.mine(P.roundBlocks); // tip 1021, round 1 closes at 1020
  buy(chain); // 1022 → round 2
  await engine.tick();
  assert.equal(engine.round(1)!.tickets.length, 1);
  assert.equal(engine.round(2)!.tickets.length, 2); // 1 carried + 1 fresh
});

test("full happy path: draw → buy floor → valid claim → transfer, surplus carried", async () => {
  const { chain, market, engine } = setup();
  const keys = Array.from({ length: 7 }, () => buy(chain));
  chain.mine(P.roundBlocks + P.seedDelay + P.reorgSafety);
  await engine.tick(); // close + draw + order
  await engine.tick(); // settle
  const r = engine.round(1)!;
  assert.equal(r.status, "purchased");
  assert.equal(r.purchase!.snarkId, 2950);
  const surplus = 7 * P.ticketZats - r.purchase!.priceZats - P.feeReserveZats;
  assert.equal(engine.openRound().potZats, surplus);

  const pk = parseLine(r.tickets[r.winner!]!).pk;
  const winner = keys.find((k) => k.pk === pk)!;
  const loser = keys.find((k) => k.pk !== pk)!;
  assert.equal(engine.submitClaim(1, r.winner!, "ZR-AAAA-BBBB", signClaim(loser.code, 1, r.winner!, "ZR-AAAA-BBBB")).ok, false);
  assert.equal(engine.submitClaim(1, (r.winner! + 1) % 7, "ZR-AAAA-BBBB", "x").ok, false);
  assert.equal(engine.submitClaim(1, r.winner!, "ZR-AAAA-BBBB", signClaim(winner.code, 1, r.winner!, "ZR-AAAA-BBBB")).ok, true);
  await engine.tick();
  assert.equal(r.status, "claimed");
  assert.deepEqual(market.transfers, [{ snarkId: 2950, to: "ZR-AAAA-BBBB" }]);
});

test("losing the purchase race retries the next listing", async () => {
  const { chain, market, engine } = setup();
  for (let i = 0; i < 7; i++) buy(chain);
  chain.mine(P.roundBlocks + P.seedDelay + P.reorgSafety);
  market.loseNext = true;
  await engine.tick(); // order on floor listing
  await engine.tick(); // lost → retry next
  await engine.tick(); // settle
  const r = engine.round(1)!;
  assert.equal(r.status, "purchased");
  assert.equal(r.purchase!.snarkId, 2951);
  // the refund of the losing payment must not inflate the next pot
  assert.equal(engine.openRound().potZats, 7 * P.ticketZats - r.purchase!.priceZats - P.feeReserveZats);
  assert.equal(engine.openRound().donationsZats, 0);
});

test("unclaimed prize becomes a bonus in the next drawn round", async () => {
  const { chain, market, engine } = setup();
  for (let i = 0; i < 7; i++) buy(chain);
  chain.mine(P.roundBlocks + P.seedDelay + P.reorgSafety);
  await engine.tick();
  await engine.tick();
  chain.mine(P.claimWindowBlocks + 1);
  await engine.tick();
  assert.equal(engine.round(1)!.status, "expired");
  assert.deepEqual(engine.state.bonusSnarkIds, [2950]);
  // fill a later round
  const keys = Array.from({ length: 7 }, () => buy(chain));
  chain.mine(P.roundBlocks * 2 + P.seedDelay + P.reorgSafety);
  await engine.tick();
  await engine.tick();
  const drawn = engine.state.rounds.find((r) => r.round > 1 && r.status === "purchased")!;
  assert.deepEqual(drawn.bonusSnarkIds, [2950]);
  const pk = parseLine(drawn.tickets[drawn.winner!]!).pk;
  const w = keys.find((k) => k.pk === pk)!;
  engine.submitClaim(drawn.round, drawn.winner!, "ZR-CCCC-DDDD", signClaim(w.code, drawn.round, drawn.winner!, "ZR-CCCC-DDDD"));
  await engine.tick();
  assert.deepEqual(market.transfers.map((t) => t.snarkId).sort(), [2950, 2951]);
});

import { signWithdraw, withdrawAmountZats } from "../../../packages/core/src/index.ts";
const ADDR = "u1" + "q".repeat(110);

test("withdraw: unfilled round tickets can be pulled out of the next round, minus fee", async () => {
  const { chain, engine } = setup();
  const a = buy(chain, 3);
  const b = buy(chain, 1);
  chain.mine(P.roundBlocks);
  await engine.tick(); // round 1 rolls, round 2 open with 4 carried tickets
  const r2 = engine.openRound();
  assert.equal(r2.round, 2);
  assert.equal(r2.carriedCount, 4);
  const amount = withdrawAmountZats(3, P);
  const res = engine.submitWithdraw(2, a.pk, ADDR, signWithdraw(a.code, 2, 3, amount, ADDR));
  assert.deepEqual(res, { ok: true, amountZats: amount });
  assert.equal(r2.carriedCount, 1);
  assert.equal(r2.tickets.length, 1);
  assert.equal(r2.potZats, 1 * P.ticketZats);
  await engine.tick();
  assert.deepEqual(chain.sent.map((s) => [s.to, s.zats]), [[ADDR, amount]]);
  assert.equal(engine.state.withdrawals[0]!.status, "sent");
  assert.ok(r2.withdrawn[0]!.txid);
  // b did nothing → still in round 2 automatically
  assert.ok(r2.tickets[0]!.endsWith(b.pk));
  // public round record never contains the destination address
  assert.ok(!JSON.stringify(engine.publicRound(r2)).includes(ADDR));
});

test("withdraw: refused for fresh tickets, twice, wrong round, wrong amount, transparent address", async () => {
  const { chain, engine } = setup();
  const a = buy(chain, 2);
  chain.mine(P.roundBlocks);
  await engine.tick();
  const fresh = buy(chain, 1); // bought in round 2 itself, not carried
  await engine.tick();
  const amt1 = withdrawAmountZats(1, P);
  assert.equal(engine.submitWithdraw(2, fresh.pk, ADDR, signWithdraw(fresh.code, 2, 1, amt1, ADDR)).ok, false);
  const amt2 = withdrawAmountZats(2, P);
  assert.equal(engine.submitWithdraw(1, a.pk, ADDR, signWithdraw(a.code, 1, 2, amt2, ADDR)).ok, false);
  assert.equal(engine.submitWithdraw(2, a.pk, ADDR, signWithdraw(a.code, 2, 2, amt2 + 1, ADDR)).ok, false);
  assert.equal(engine.submitWithdraw(2, a.pk, "t1notshielded", "x").ok, false);
  assert.equal(engine.submitWithdraw(2, a.pk, ADDR, signWithdraw(a.code, 2, 2, amt2, ADDR)).ok, true);
  assert.equal(engine.submitWithdraw(2, a.pk, ADDR, signWithdraw(a.code, 2, 2, amt2, ADDR)).ok, false);
});

test("withdraw: only from the round the tickets currently sit in", async () => {
  const { chain, engine } = setup();
  const a = buy(chain, 2);
  chain.mine(P.roundBlocks);
  await engine.tick(); // round 1 rolled
  chain.mine(P.roundBlocks);
  await engine.tick(); // round 2 rolled too → tickets now carried into round 3
  const amt = withdrawAmountZats(2, P);
  assert.equal(engine.submitWithdraw(2, a.pk, ADDR, signWithdraw(a.code, 2, 2, amt, ADDR)).ok, false);
  // …but they are carried again into round 3, so they can still leave from there
  assert.equal(engine.submitWithdraw(3, a.pk, ADDR, signWithdraw(a.code, 3, 2, amt, ADDR)).ok, true);
});

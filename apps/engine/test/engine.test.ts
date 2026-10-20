import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PARAMS,
  newTicketKey,
  parseLine,
  potSplit,
  signRaffleClaim,
  signClaim,
  ticketMemo,
  type Params,
} from "../../../packages/core/src/index.ts";
import { MockChain, MockWallet, MockZilkroad } from "../src/adapters/mock.ts";
import { Engine, initialState, migrateState } from "../src/engine.ts";

const P: Params = { ...DEFAULT_PARAMS, roundBlocks: 20, seedDelay: 2, reorgSafety: 1, claimWindowBlocks: 50 };
const TREASURY = "u1treasury";
const ADDR = "u1" + "q".repeat(110);
const ACCT = "ZR-7K4Q-M2XD";

function setup(prices = [0.02, 0.03, 0.04]) {
  const chain = new MockChain(1000);
  const treasury = new MockWallet(chain, TREASURY);
  const market = new MockZilkroad([chain, treasury], prices);
  const engine = new Engine(
    initialState({ startHeight: 1000, poolAddress: "u1pool", viewingKey: "uview1in", treasuryAddress: TREASURY, treasuryViewingKey: "uview1tr", zilkroadAddress: "u1ops", params: P }),
    { wallet: chain, treasury, chain, market },
  );
  return { chain, treasury, market, engine };
}

const buy = (chain: MockChain, n = 1) => {
  const k = newTicketKey();
  chain.pay(n * P.ticketZats, ticketMemo(k.pk));
  return k;
};

/** Close the open round and run its draw. */
async function closeAndDraw(chain: MockChain, engine: Engine) {
  const open = engine.openRound();
  chain.mine(Math.max(0, open.closeHeight - chain.tip) + P.seedDelay + P.reorgSafety);
  await engine.tick();
}

function winnerKey(engine: Engine, n: number, keys: { pk: string; code: string }[]) {
  const r = engine.round(n)!;
  return keys.find((k) => k.pk === parseLine(r.tickets[r.winner!]!).pk)!;
}

test("one ticket is enough: drawn, 5% to treasury, winner claims the rest in ZEC", async () => {
  const { chain, treasury, engine } = setup();
  const k = buy(chain, 1);
  await closeAndDraw(chain, engine);
  const r = engine.round(1)!;
  assert.equal(r.status, "drawn");
  assert.equal(r.tickets.length, 1);
  assert.deepEqual(r.split, potSplit(1_000_000, 0, 1, P));
  assert.equal(treasury.balanceZats, 50_000, "fee arrived in the treasury");
  assert.equal(r.feeTxid !== undefined, true);

  const prize = r.split!.prizeZats;
  const res = engine.submitClaim(1, 0, ADDR, signClaim(k.code, 1, 0, ADDR, prize));
  assert.deepEqual(res, { ok: true, amountZats: prize });
  await engine.tick();
  assert.equal(r.status, "paid");
  assert.ok(chain.sent.some((s) => s.to === ADDR && s.zats === prize && s.memo === "ZECPOT1 prize round 1"));
  assert.ok(!JSON.stringify(engine.publicRound(r)).includes(ADDR), "winner's address is never published");
});

test("many tickets per payment, legacy memo accepted, pick lands in the right round", async () => {
  const { chain, engine } = setup();
  const a = newTicketKey();
  chain.pay(10_000_000, `SNARKPOT1 ${a.pk}`); // the live 0.1 ZEC ticket
  buy(chain, 3);
  await closeAndDraw(chain, engine);
  const r = engine.round(1)!;
  assert.equal(r.tickets.length, 13);
  assert.equal(r.paymentNotes, 2);
  assert.equal(r.potZats, 13_000_000);
  assert.equal(engine.openRound().round, 2);
});

test("a round with no tickets rolls its pot forward without a fee", async () => {
  const { chain, treasury, engine } = setup();
  chain.pay(500_000, "a donation, no ticket memo");
  await closeAndDraw(chain, engine);
  assert.equal(engine.round(1)!.status, "rolled");
  assert.equal(treasury.balanceZats, 0);
  const r2 = engine.openRound();
  assert.equal(r2.potZats, 500_000);
  buy(chain, 2);
  await closeAndDraw(chain, engine);
  assert.equal(engine.round(2)!.split!.feeZats, Math.floor((2_500_000 * 500) / 10_000), "fee base includes the rolled donation once");
});

test("claims are refused for the wrong ticket, amount, address, or twice", async () => {
  const { chain, engine } = setup();
  const keys = [buy(chain, 1), buy(chain, 1), buy(chain, 1)];
  await closeAndDraw(chain, engine);
  const r = engine.round(1)!;
  const w = winnerKey(engine, 1, keys);
  const loser = keys.find((k) => k !== w)!;
  const prize = r.split!.prizeZats;
  assert.equal(engine.submitClaim(1, r.winner!, ADDR, signClaim(loser.code, 1, r.winner!, ADDR, prize)).ok, false);
  assert.equal(engine.submitClaim(1, (r.winner! + 1) % 3, ADDR, signClaim(w.code, 1, (r.winner! + 1) % 3, ADDR, prize)).ok, false);
  assert.equal(engine.submitClaim(1, r.winner!, ADDR, signClaim(w.code, 1, r.winner!, ADDR, prize + 1)).ok, false);
  assert.equal(engine.submitClaim(1, r.winner!, "t1abc", "x").ok, false);
  assert.equal(engine.submitClaim(1, r.winner!, ADDR, signClaim(w.code, 1, r.winner!, ADDR, prize)).ok, true);
  assert.equal(engine.submitClaim(1, r.winner!, ADDR, signClaim(w.code, 1, r.winner!, ADDR, prize)).ok, false);
});

test("an unclaimed prize rolls into the open round and is not fee'd again", async () => {
  const { chain, engine } = setup();
  buy(chain, 10);
  await closeAndDraw(chain, engine);
  const prize = engine.round(1)!.split!.prizeZats;
  chain.mine(P.claimWindowBlocks + 5);
  await engine.tick();
  assert.equal(engine.round(1)!.status, "expired");
  const open = engine.openRound();
  assert.ok(open.carriedZats >= prize);
  buy(chain, 1);
  await closeAndDraw(chain, engine);
  const drawn = engine.state.rounds.find((x) => x.round === open.round)!;
  assert.equal(drawn.split!.feeZats, 50_000, "only the new 0.01 ZEC pays the fee");
  assert.ok(drawn.split!.prizeZats > prize);
});

test("treasury sweeps the floor zkSNARK once it holds floor + 5% + reserve", async () => {
  const { chain, treasury, market, engine } = setup();
  treasury.balanceZats = 2_500_000; // 0.025 ≥ 0.02 × 1.05 + 0.002
  await engine.tick(); // order + pay
  await engine.tick(); // settles
  assert.deepEqual(engine.state.treasurySnarks, [2950]);
  assert.equal(engine.state.sweeps[0]!.snarkId, 2950);
  assert.ok(market.held.has(2950));
  assert.ok(treasury.sent.some((s) => s.memo === "ZR-PAY-50000"));
  void chain;
});

test("if Zilkroad fails, the sweep becomes an operator task; completing it records the zkSNARK", async () => {
  const { treasury, market, engine } = setup();
  market.failCalls = true;
  treasury.balanceZats = 2_500_000;
  await engine.tick();
  const tasks = engine.openTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.kind, "buy");
  await engine.tick();
  assert.equal(engine.openTasks().length, 1, "no duplicate task while one is open");
  assert.equal(engine.completeTask(tasks[0]!.id, {}).ok, false, "needs the zkSNARK number");
  assert.equal(engine.completeTask(tasks[0]!.id, { snarkId: 7777, txid: "ab".repeat(32) }).ok, true);
  assert.deepEqual(engine.state.treasurySnarks, [7777]);
  assert.equal(engine.state.sweeps[0]!.manual, true);
});

function raffleWinner(engine: Engine, n: number, keys: { pk: string; code: string }[]) {
  const rf = engine.raffle(n)!;
  return keys.find((k) => k.pk === parseLine(rf.tickets[rf.winner!]!).pk)!;
}

test("a swept zkSNARK becomes a 'raffle' to-do; the operator opens it with a chosen length", async () => {
  const { chain, treasury, engine } = setup([0.02]);
  treasury.balanceZats = 3_000_000;
  await engine.tick();
  await engine.tick();
  assert.deepEqual(engine.state.treasurySnarks, [2950]);
  const todo = engine.openTasks().find((t) => t.kind === "raffle")!;
  assert.ok(todo.detail.includes("npm run op -- raffle 2950"));
  assert.equal((await engine.openRaffle(9999)).ok, false, "not in the treasury");
  assert.equal((await engine.openRaffle(2950, { hours: 0 })).ok, false, "bad length");
  const before = chain.tip;
  const out = await engine.openRaffle(2950, { hours: 24 });
  assert.equal(out.ok, true);
  const rf = engine.raffle(1)!;
  assert.equal(rf.closeHeight - rf.openHeight, 1152, "24 h at 75 s blocks");
  assert.equal(rf.openHeight, before);
  assert.deepEqual(engine.state.treasurySnarks, [], "promised to the raffle");
  assert.equal(engine.openTasks().some((t) => t.kind === "raffle"), false, "to-do closed");
  assert.equal(rf.snark?.name, "zkSNARKs #2950");
  assert.ok(rf.snark?.image?.startsWith("/data/art/2950."));
  assert.ok(engine.art.size === 1, "picture waiting to be published");
  assert.equal((await engine.openRaffle(2950)).ok, false, "one raffle at a time");
  // default length
  engine.state.raffles = [];
  (engine.state.treasurySnarks as number[]).push(2950);
  await engine.openRaffle(2950);
  assert.equal(engine.raffle(1)!.closeHeight - engine.raffle(1)!.openHeight, 2304, "48 h by default");
});

test("raffle: only tickets bought inside the window count, across daily pots; daily draws carry on", async () => {
  const { chain, market, engine } = setup();
  engine.state.treasurySnarks.push(2950);
  market.held.add(2950);
  const early = buy(chain, 3);
  await engine.tick(); // ingested before the raffle opens
  await engine.openRaffle(2950, { blocks: 30 });
  const rf = engine.raffle(1)!;
  const keys = [buy(chain, 2), buy(chain, 1)];
  await closeAndDraw(chain, engine); // pot 1 closes and draws as usual
  assert.equal(engine.round(1)!.status, "drawn");
  keys.push(buy(chain, 4)); // pot 2, still inside the raffle window
  chain.mine(Math.max(0, rf.closeHeight - chain.tip));
  await engine.tick();
  buy(chain, 5); // after the window: daily pot only
  chain.mine(P.seedDelay + P.reorgSafety);
  await engine.tick();
  assert.equal(rf.status, "drawn");
  assert.equal(rf.tickets.length, 7, "2 + 1 + 4 tickets, not the early 3 or the late 5");
  assert.ok(!rf.tickets.some((l) => parseLine(l).pk === early.pk));
  assert.equal(engine.openRound().round >= 2, true);

  const w = raffleWinner(engine, 1, keys);
  assert.equal(engine.submitRaffleClaim(1, rf.winner!, ACCT, signRaffleClaim(w.code, 1, rf.winner!, ACCT, 2951)).ok, false, "wrong zkSNARK");
  assert.equal(engine.submitRaffleClaim(1, (rf.winner! + 1) % 7, ACCT, "x").ok, false, "wrong ticket");
  assert.equal(engine.submitRaffleClaim(1, rf.winner!, ACCT, signRaffleClaim(w.code, 1, rf.winner!, ACCT, 2950)).ok, true);
  await engine.tick();
  assert.equal(rf.status, "delivered");
  assert.deepEqual(market.transfers, [{ snarkId: 2950, to: ACCT }]);
  assert.ok(!JSON.stringify(engine.publicRaffle(rf)).includes(ACCT), "account ID is published only as a hash");
  assert.ok(!("fresh" in engine.publicRaffle(rf)));
});

test("raffle delivery falls back to a transfer task; empty and unclaimed raffles return the zkSNARK", async () => {
  const { chain, market, engine } = setup();
  engine.state.treasurySnarks.push(2950, 2951);
  await engine.openRaffle(2950, { blocks: 10 });
  const k = buy(chain, 1);
  chain.mine(10 + P.seedDelay + P.reorgSafety);
  await engine.tick();
  const rf = engine.raffle(1)!;
  market.failCalls = true;
  engine.submitRaffleClaim(1, rf.winner!, ACCT, signRaffleClaim(k.code, 1, rf.winner!, ACCT, 2950));
  await engine.tick();
  const t = engine.openTasks().find((x) => x.kind === "transfer")!;
  assert.ok(t.detail.includes(ACCT) && t.raffle === 1);
  assert.equal(engine.completeTask(t.id, {}).ok, true);
  assert.equal(rf.status, "delivered");
  market.failCalls = false;

  // nobody buys during raffle 2 → empty, zkSNARK back, to-do again
  await engine.openRaffle(2951, { blocks: 5 });
  chain.mine(6);
  await engine.tick();
  assert.equal(engine.raffle(2)!.status, "empty");
  assert.deepEqual(engine.state.treasurySnarks, [2951]);
  assert.ok(engine.openTasks().some((x) => x.kind === "raffle" && x.snarkId === 2951));

  // raffle 3 is drawn but never claimed → expired, back to the treasury
  await engine.openRaffle(2951, { blocks: 5 });
  buy(chain, 1);
  chain.mine(5 + P.seedDelay + P.reorgSafety);
  await engine.tick();
  assert.equal(engine.raffle(3)!.status, "drawn");
  chain.mine(P.claimWindowBlocks + 5);
  await engine.tick();
  assert.equal(engine.raffle(3)!.status, "expired");
  assert.deepEqual(engine.state.treasurySnarks, [2951]);
});

test("a saved state from before raffles existed loads with an empty raffle list", () => {
  const { chain, treasury, market } = setup();
  const s = initialState({ startHeight: 1000, poolAddress: "u1pool", viewingKey: "uview1in", treasuryAddress: TREASURY, treasuryViewingKey: "uview1tr", zilkroadAddress: "u1ops", params: P });
  delete (s as Partial<typeof s>).raffles;
  const e = new Engine(s, { wallet: chain, treasury, chain, market });
  assert.deepEqual(e.state.raffles, []);
  assert.deepEqual(e.publicState().raffles, []);
});

test("migrating the live SNARKPOT state re-reads the 0.1 ZEC payment as 10 tickets in round 1", async () => {
  const chain = new MockChain(3524117);
  const treasury = new MockWallet(chain, TREASURY);
  const market = new MockZilkroad([chain, treasury]);
  const k = newTicketKey();
  chain.pay(10_000_000, `SNARKPOT1 ${k.pk}`);
  const v1 = { version: 1, scannedHeight: 3524118, rounds: [{ round: 1, status: "open", openHeight: 3524117, closeHeight: 3525269, potZats: 10_000_000, tickets: ["x"] }] };
  const state = migrateState(v1, { poolAddress: "u1pool", viewingKey: "uview1in", treasuryAddress: TREASURY, treasuryViewingKey: "uview1tr", zilkroadAddress: "u1ops" });
  assert.equal(state.version, 2);
  const engine = new Engine(state, { wallet: chain, treasury, chain, market });
  await engine.tick();
  const r = engine.openRound();
  assert.equal(r.round, 1);
  assert.equal(r.closeHeight, 3525269, "same close time as before");
  assert.equal(r.tickets.length, 10);
  assert.equal(r.potZats, 10_000_000);
});

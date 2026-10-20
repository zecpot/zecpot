import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PARAMS,
  bonusWinnerIndex,
  destHash,
  keyFromCode,
  listHash,
  newTicketKey,
  parseLine,
  parseTicketMemo,
  potSplit,
  roundTicketList,
  signBonusClaim,
  signClaim,
  signWithdraw,
  sweepTargetZats,
  ticketLine,
  ticketMemo,
  ticketsFromPayment,
  verifyBonus,
  verifyBonusClaim,
  verifyClaim,
  verifyRound,
  verifyWithdraw,
  winnerIndex,
  withdrawAmountZats,
  withdrawFeeZats,
  zatsToZec,
  zecToZats,
  zip321Uri,
  type RoundRecord,
  type Ticket,
} from "../src/index.ts";

const HASH = "00000000015c1b1c3a2f8e8f0b9f1e6a4c2d3b4a5e6f708192a3b4c5d6e7f809";
const ADDR = "u1" + "q".repeat(110);

test("ZEC ↔ zats round-trips exactly", () => {
  assert.equal(zecToZats("0.01"), 1_000_000);
  assert.equal(zecToZats("6535.36537299"), 653_536_537_299);
  assert.equal(zatsToZec(1_000_000), "0.01");
  assert.equal(zatsToZec(94_700_000), "0.947");
  assert.throws(() => zecToZats("0.123456789"));
});

test("ticket code restores the same key", () => {
  const k = newTicketKey();
  assert.match(k.code, /^spk1[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(keyFromCode(k.code), k);
});

test("memo: ZECPOT1 and legacy SNARKPOT1 both parse; junk doesn't", () => {
  const { pk } = newTicketKey();
  assert.equal(ticketMemo(pk), `ZECPOT1 ${pk}`);
  assert.equal(parseTicketMemo(ticketMemo(pk)), pk);
  assert.equal(parseTicketMemo(`SNARKPOT1 ${pk}`), pk, "the live ticket bought before the rename still counts");
  assert.equal(parseTicketMemo(ticketMemo(pk) + "\u0000\u0000"), pk);
  assert.equal(parseTicketMemo("hello"), null);
  assert.equal(parseTicketMemo(`ZECPOT1 ${pk}x`), null);
  assert.equal(parseTicketMemo(`OTHER1 ${pk}`), null);
  assert.equal(parseTicketMemo(null), null);
});

test("payment → floor(amount / 0.01) tickets; the live 0.1 ZEC ticket becomes 10", () => {
  const { pk } = newTicketKey();
  const p = { txid: "aa", outIndex: 0, height: 10, zats: 10_000_000, memo: `SNARKPOT1 ${pk}` };
  assert.equal(ticketsFromPayment(p).length, 10);
  assert.equal(ticketsFromPayment({ ...p, zats: 3_500_000 }).length, 3);
  assert.equal(ticketsFromPayment({ ...p, memo: "nope" }).length, 0);
});

test("ZIP-321 URI carries amount and base64url memo", () => {
  assert.equal(zip321Uri("u1abc", 3_000_000, "ZECPOT1 x"), "zcash:u1abc?amount=0.03&memo=WkVDUE9UMSB4");
});

test("pot split: 5% to treasury, network allowance, prize; carried money isn't fee'd again", () => {
  // 100 tickets in 20 payments → 1 ZEC new money
  const s = potSplit(100_000_000, 0, 20);
  assert.equal(s.feeZats, 5_000_000);
  assert.equal(s.networkZats, 25 * 5_000);
  assert.equal(s.prizeZats, 100_000_000 - 5_000_000 - 125_000);
  assert.equal(zatsToZec(s.prizeZats), "0.94875");
  // an unclaimed 0.5 ZEC prize rolled in adds to the prize, not to the fee base
  const c = potSplit(100_000_000, 50_000_000, 20);
  assert.equal(c.feeZats, 5_000_000);
  assert.equal(c.prizeZats, s.prizeZats + 50_000_000);
  // a single 0.01 ticket still pays out
  const one = potSplit(1_000_000, 0, 1);
  assert.deepEqual([one.feeZats, one.networkZats, one.prizeZats], [50_000, 30_000, 920_000]);
});

test("sweep target: floor + 5% + reserve", () => {
  assert.equal(sweepTargetZats(38_400_000), 40_320_000 + 200_000);
});

test("ticket order is canonical regardless of input order; carried first", () => {
  const mk = (txid: string, height: number, k = 0): Ticket => ({ txid, outIndex: 0, k, pk: "p", height });
  const fresh = [mk("bb", 5), mk("aa", 5), mk("cc", 4), mk("aa", 5, 1)];
  const carried = [mk("zz", 1)];
  const lines = roundTicketList(carried, fresh).map(ticketLine);
  assert.deepEqual(lines, ["zz:0:0:p", "cc:0:0:p", "aa:0:0:p", "aa:0:1:p", "bb:0:0:p"]);
  assert.equal(listHash(roundTicketList(carried, [...fresh].reverse())), listHash(roundTicketList(carried, fresh)));
});

test("daily and bonus draws are deterministic, roughly uniform, and independent", () => {
  const ts: Ticket[] = Array.from({ length: 10 }, (_, i) => ({ txid: `t${i}`, outIndex: 0, k: 0, pk: "p", height: 1 }));
  assert.equal(winnerIndex(1, HASH, ts), winnerIndex(1, HASH, ts));
  const counts = new Array(10).fill(0);
  let same = 0;
  for (let r = 0; r < 5000; r++) {
    const w = winnerIndex(r, HASH, ts);
    counts[w]++;
    if (bonusWinnerIndex(r, HASH, ts) === w) same++;
  }
  for (const c of counts) assert.ok(c > 400 && c < 600, `bucket ${c}`);
  assert.ok(same > 350 && same < 650, `bonus should match the daily winner ~10% of the time, got ${same}`);
  assert.throws(() => winnerIndex(1, HASH.toUpperCase(), ts));
});

test("prize claim binds round, ticket, hashed address and exact amount", () => {
  const k = newTicketKey();
  const sig = signClaim(k.code, 7, 3, ADDR, 94_875_000);
  assert.ok(verifyClaim(k.pk, 7, 3, destHash(ADDR), 94_875_000, sig));
  assert.ok(!verifyClaim(k.pk, 7, 3, destHash("u1" + "p".repeat(110)), 94_875_000, sig), "other address");
  assert.ok(!verifyClaim(k.pk, 7, 3, destHash(ADDR), 94_875_001, sig), "other amount");
  assert.ok(!verifyClaim(k.pk, 8, 3, destHash(ADDR), 94_875_000, sig), "other round");
  assert.ok(!verifyClaim(newTicketKey().pk, 7, 3, destHash(ADDR), 94_875_000, sig), "other key");
  assert.throws(() => signClaim(k.code, 7, 3, "t1notshielded", 1));
});

test("bonus claim binds round, ticket, account and zkSNARK", () => {
  const k = newTicketKey();
  const sig = signBonusClaim(k.code, 7, 2, "ZR-7K4Q-M2XD", 2950);
  assert.ok(verifyBonusClaim(k.pk, 7, 2, destHash("ZR-7K4Q-M2XD"), 2950, sig));
  assert.ok(!verifyBonusClaim(k.pk, 7, 2, destHash("ZR-AAAA-BBBB"), 2950, sig));
  assert.ok(!verifyBonusClaim(k.pk, 7, 2, destHash("ZR-7K4Q-M2XD"), 2951, sig));
  assert.throws(() => signBonusClaim(k.code, 7, 2, "not-an-id", 2950));
});

test("withdraw: fee, amount, signature binds round/amount/address", () => {
  assert.equal(withdrawFeeZats(1), 10_000);
  assert.equal(withdrawAmountZats(3), 3 * 1_000_000 - 20_000);
  const k = newTicketKey();
  const sig = signWithdraw(k.code, 4, 3, withdrawAmountZats(3), ADDR);
  assert.ok(verifyWithdraw(k.pk, 4, 3, withdrawAmountZats(3), ADDR, sig));
  assert.ok(!verifyWithdraw(k.pk, 5, 3, withdrawAmountZats(3), ADDR, sig));
});

function drawnRecord(k: ReturnType<typeof newTicketKey>, n = 4): RoundRecord {
  const tickets = Array.from({ length: n }, (_, i) => `tx${i}:0:0:${k.pk}`);
  const parsed = tickets.map(parseLine);
  const split = potSplit(n * 1_000_000, 0, n);
  return {
    round: 1, status: "drawn", params: DEFAULT_PARAMS, openHeight: 0, closeHeight: 1, seedHeight: 2,
    potZats: n * 1_000_000, paymentNotes: n, feeBaseZats: n * 1_000_000, carriedZats: 0,
    tickets, carriedCount: 0, withdrawn: [], listHash: listHash(parsed), seedBlockHash: HASH,
    winner: winnerIndex(1, HASH, parsed), split,
  };
}

test("verifyRound checks the winner, the fee split and the claim; catches tampering", () => {
  const k = newTicketKey();
  const r = drawnRecord(k);
  const sig = signClaim(k.code, 1, r.winner!, ADDR, r.split!.prizeZats);
  const claimed: RoundRecord = { ...r, status: "paid", claim: { toHash: destHash(ADDR), amountZats: r.split!.prizeZats, sig } };
  assert.ok(verifyRound(claimed).ok);
  assert.ok(!verifyRound({ ...r, winner: (r.winner! + 1) % 4 }).ok, "wrong winner");
  assert.ok(!verifyRound({ ...r, split: { ...r.split!, feeZats: r.split!.feeZats + 1 } }).ok, "wrong fee");
  assert.ok(!verifyRound({ ...claimed, claim: { ...claimed.claim!, amountZats: 1 } }).ok, "claim for a different amount");
});

test("verifyBonus recomputes the weekly winner over the named rounds", () => {
  const k = newTicketKey();
  const a = drawnRecord(k, 3);
  const b = { ...drawnRecord(k, 5), round: 2, tickets: Array.from({ length: 5 }, (_, i) => `ty${i}:0:0:${k.pk}`) };
  const lines = [...a.tickets, ...b.tickets];
  const winner = bonusWinnerIndex(2, HASH, lines.map(parseLine));
  const sig = signBonusClaim(k.code, 2, winner, "ZR-7K4Q-M2XD", 2950);
  const withBonus: RoundRecord = {
    ...b,
    bonus: { snarkId: 2950, rounds: [1, 2], listHash: listHash(lines.map(parseLine)), ticketCount: 8, winner, status: "claimed", claim: { toHash: destHash("ZR-7K4Q-M2XD"), sig } },
  };
  assert.ok(verifyBonus(withBonus, { 1: a.tickets, 2: b.tickets }).ok);
  assert.ok(!verifyBonus({ ...withBonus, bonus: { ...withBonus.bonus!, winner: (winner + 1) % 8 } }, { 1: a.tickets, 2: b.tickets }).ok);
});

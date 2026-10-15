import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PARAMS,
  keyFromCode,
  listHash,
  newTicketKey,
  parseTicketMemo,
  roundTicketList,
  signClaim,
  targetZats,
  ticketMemo,
  ticketsFromPayment,
  ticketsNeeded,
  verifyClaim,
  verifyRound,
  winnerIndex,
  zatsToZec,
  zecToZats,
  zip321Uri,
  ticketLine,
  type Ticket,
} from "../src/index.ts";

const HASH = "00000000015c1b1c3a2f8e8f0b9f1e6a4c2d3b4a5e6f708192a3b4c5d6e7f809";

test("ZEC ↔ zats round-trips exactly", () => {
  assert.equal(zecToZats("0.548"), 54_800_000);
  assert.equal(zecToZats("6535.36537299"), 653_536_537_299);
  assert.equal(zatsToZec(10_000_000), "0.1");
  assert.equal(zatsToZec(57_740_000), "0.5774");
  assert.throws(() => zecToZats("0.123456789"));
});

test("ticket code restores the same key", () => {
  const k = newTicketKey();
  assert.match(k.code, /^spk1[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(keyFromCode(k.code), k);
});

test("memo parse accepts valid, rejects junk, tolerates NUL padding", () => {
  const { pk } = newTicketKey();
  assert.equal(parseTicketMemo(ticketMemo(pk)), pk);
  assert.equal(parseTicketMemo(ticketMemo(pk) + "\u0000\u0000"), pk);
  assert.equal(parseTicketMemo("hello"), null);
  assert.equal(parseTicketMemo(`SNARKPOT1 ${pk}x`), null);
  assert.equal(parseTicketMemo(null), null);
});

test("payment → floor(amount/0.1) tickets", () => {
  const { pk } = newTicketKey();
  const p = { txid: "aa", outIndex: 0, height: 10, zats: 35_000_000, memo: ticketMemo(pk) };
  const ts = ticketsFromPayment(p);
  assert.equal(ts.length, 3);
  assert.deepEqual(ts.map((t) => t.k), [0, 1, 2]);
  assert.equal(ticketsFromPayment({ ...p, memo: "nope" }).length, 0);
});

test("ZIP-321 URI carries amount and base64url memo", () => {
  const uri = zip321Uri("u1abc", 30_000_000, "SNARKPOT1 x");
  assert.equal(uri, "zcash:u1abc?amount=0.3&memo=U05BUktQT1QxIHg");
});

test("target and tickets needed (15 Oct floor 0.548 → 6 tickets)", () => {
  assert.equal(targetZats(54_800_000), 57_740_000);
  assert.equal(ticketsNeeded(0, 54_800_000), 6);
  assert.equal(ticketsNeeded(57_740_000, 54_800_000), 0);
});

test("ticket order is canonical regardless of input order; carried first", () => {
  const mk = (txid: string, height: number, k = 0): Ticket => ({ txid, outIndex: 0, k, pk: "p", height });
  const fresh = [mk("bb", 5), mk("aa", 5), mk("cc", 4), mk("aa", 5, 1)];
  const carried = [mk("zz", 1)];
  const lines = roundTicketList(carried, fresh).map(ticketLine);
  assert.deepEqual(lines, ["zz:0:0:p", "cc:0:0:p", "aa:0:0:p", "aa:0:1:p", "bb:0:0:p"]);
  assert.equal(listHash(roundTicketList(carried, [...fresh].reverse())), listHash(roundTicketList(carried, fresh)));
});

test("draw is deterministic and roughly uniform", () => {
  const ts: Ticket[] = Array.from({ length: 10 }, (_, i) => ({ txid: `t${i}`, outIndex: 0, k: 0, pk: "p", height: 1 }));
  assert.equal(winnerIndex(1, HASH, ts), winnerIndex(1, HASH, ts));
  const counts = new Array(10).fill(0);
  for (let r = 0; r < 5000; r++) counts[winnerIndex(r, HASH, ts)]++;
  for (const c of counts) assert.ok(c > 400 && c < 600, `bucket ${c}`);
  assert.throws(() => winnerIndex(1, HASH.toUpperCase(), ts));
});

test("claim signature binds round, ticket and account", () => {
  const k = newTicketKey();
  const sig = signClaim(k.code, 7, 3, "ZR-7K4Q-M2XD");
  assert.ok(verifyClaim(k.pk, 7, 3, "ZR-7K4Q-M2XD", sig));
  assert.ok(!verifyClaim(k.pk, 7, 3, "ZR-AAAA-BBBB", sig));
  assert.ok(!verifyClaim(k.pk, 8, 3, "ZR-7K4Q-M2XD", sig));
  assert.ok(!verifyClaim(newTicketKey().pk, 7, 3, "ZR-7K4Q-M2XD", sig));
  assert.throws(() => signClaim(k.code, 7, 3, "not-an-id"));
});

test("verifyRound catches a tampered winner", () => {
  const k = newTicketKey();
  const tickets = [0, 1, 2, 3].map((i) => `tx${i}:0:0:${k.pk}`);
  const parsed = tickets.map((l) => {
    const [txid, o, kk, pk] = l.split(":");
    return { txid: txid!, outIndex: +o!, k: +kk!, pk: pk!, height: 0 };
  });
  const w = winnerIndex(1, HASH, parsed);
  const base = { round: 1, status: "claimed" as const, params: DEFAULT_PARAMS, openHeight: 0, closeHeight: 1, seedHeight: 2, potZats: 0, tickets, carriedCount: 0, withdrawn: [], listHash: listHash(parsed), seedBlockHash: HASH };
  const sig = signClaim(k.code, 1, w, "ZR-7K4Q-M2XD");
  assert.ok(verifyRound({ ...base, winner: w, claim: { to: "ZR-7K4Q-M2XD", sig, transferredAt: "" } }).ok);
  assert.ok(!verifyRound({ ...base, winner: (w + 1) % 4 }).ok);
});

test("withdraw: fee, amount, signature binds round/amount/address", async () => {
  const { signWithdraw, verifyWithdraw, withdrawAmountZats, withdrawFeeZats } = await import("../src/index.ts");
  assert.equal(withdrawFeeZats(1), 10_000); // ZIP-317 minimum of 2 actions
  assert.equal(withdrawFeeZats(3), 20_000);
  assert.equal(withdrawAmountZats(3), 29_980_000);
  const k = newTicketKey();
  const to = "u1" + "q".repeat(110);
  const sig = signWithdraw(k.code, 4, 3, 29_980_000, to);
  assert.ok(verifyWithdraw(k.pk, 4, 3, 29_980_000, to, sig));
  assert.ok(!verifyWithdraw(k.pk, 5, 3, 29_980_000, to, sig));
  assert.ok(!verifyWithdraw(k.pk, 4, 3, 29_990_000, to, sig));
  assert.ok(!verifyWithdraw(k.pk, 4, 3, 29_980_000, "u1" + "p".repeat(110), sig));
  assert.throws(() => signWithdraw(k.code, 4, 3, 29_980_000, "t1abcdefghijkmnopqrstuvwxyz123456"));
});

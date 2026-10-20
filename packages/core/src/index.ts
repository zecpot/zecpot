/**
 * zecPOT core: pure, deterministic protocol code shared by the engine, the
 * web app and the verifier. See SPEC.md §4. No I/O here.
 *
 * zecPOT: 0.01 ZEC tickets, one draw a day, the winning ticket takes the pot
 * minus a 5% fee; the fee goes to a public treasury that sweeps floor
 * zkSNARKs, and those zkSNARKs are given away in a weekly bonus draw.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export const PROTOCOL = "ZECPOT1";
/** Memos from before the rename are still accepted as tickets. */
export const LEGACY_MEMO_TAGS = ["SNARKPOT1"];
export const ZATS_PER_ZEC = 100_000_000;

export interface Params {
  /** Price of one ticket. */
  ticketZats: number;
  /** Blocks per round: 1152 ≈ 24 h at 75 s. */
  roundBlocks: number;
  seedDelay: number;
  reorgSafety: number;
  /** Share of each drawn pot that goes to the treasury, in basis points. */
  feeBps: number;
  /** A round with fewer tickets rolls into the next one. */
  minTickets: number;
  claimWindowBlocks: number;
  /** ZIP-317 marginal fee per logical action. */
  feePerActionZats: number;
  /** Treasury sweeps when it holds floor × (1 + sweepBufferBps) + sweepReserveZats. */
  sweepBufferBps: number;
  sweepReserveZats: number;
  /** A bonus zkSNARK draw runs on every round number divisible by this, if the treasury holds one. */
  bonusEveryRounds: number;
}

export const DEFAULT_PARAMS: Params = {
  ticketZats: 1_000_000, // 0.01 ZEC
  roundBlocks: 1152,
  seedDelay: 10,
  reorgSafety: 10,
  feeBps: 500, // 5%
  minTickets: 1,
  claimWindowBlocks: 16_128, // ≈ 14 days
  feePerActionZats: 5_000,
  sweepBufferBps: 500,
  sweepReserveZats: 200_000,
  bonusEveryRounds: 7,
};

/* ---------------- encoding helpers ---------------- */

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

export function zecToZats(zec: string | number): number {
  const s = String(zec).trim();
  if (!/^\d+(\.\d{1,8})?$/.test(s)) throw new Error(`bad ZEC amount: ${s}`);
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * ZATS_PER_ZEC + Number(frac.padEnd(8, "0"));
}

export function zatsToZec(zats: number): string {
  const neg = zats < 0;
  const abs = Math.abs(zats);
  const whole = Math.floor(abs / ZATS_PER_ZEC);
  const frac = String(abs % ZATS_PER_ZEC).padStart(8, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}

/* ---------------- ticket keys ---------------- */

export interface TicketKey {
  /** Secret — the "ticket code" the buyer keeps. */
  code: string;
  /** Public key, base64url, goes in the memo. */
  pk: string;
}

const CODE_PREFIX = "spk1";

export function newTicketKey(secret?: Uint8Array): TicketKey {
  const sk = secret ?? ed25519.utils.randomPrivateKey();
  return { code: CODE_PREFIX + b64url(sk), pk: b64url(ed25519.getPublicKey(sk)) };
}

export function keyFromCode(code: string): TicketKey {
  const c = code.trim();
  if (!c.startsWith(CODE_PREFIX)) throw new Error("ticket code must start with spk1");
  const sk = fromB64url(c.slice(CODE_PREFIX.length));
  if (sk.length !== 32) throw new Error("ticket code has the wrong length");
  return newTicketKey(sk);
}

function secretOf(code: string): Uint8Array {
  return fromB64url(code.trim().slice(CODE_PREFIX.length));
}

/* ---------------- memo ---------------- */

export function ticketMemo(pk: string): string {
  return `${PROTOCOL} ${pk}`;
}

const MEMO_RE = new RegExp(`^(?:${[PROTOCOL, ...LEGACY_MEMO_TAGS].join("|")}) ([A-Za-z0-9_-]{43})$`);

/** Returns the public key if the memo is a valid ticket memo, else null. */
export function parseTicketMemo(memo: string | null | undefined): string | null {
  if (!memo) return null;
  const m = memo.replace(/\u0000+$/g, "").trim();
  const match = MEMO_RE.exec(m);
  if (!match) return null;
  try {
    if (fromB64url(match[1]!).length !== 32) return null;
  } catch {
    return null;
  }
  return match[1]!;
}

/** ZIP-321 payment request. memo param is base64url of the memo bytes, no padding. */
export function zip321Uri(address: string, zats: number, memo: string): string {
  return `zcash:${address}?amount=${zatsToZec(zats)}&memo=${b64url(utf8ToBytes(memo))}`;
}

/* ---------------- ticket list ---------------- */

export interface Payment {
  txid: string;
  outIndex: number;
  height: number;
  zats: number;
  memo: string | null;
}

export interface Ticket {
  txid: string;
  outIndex: number;
  k: number;
  pk: string;
  height: number;
}

export function ticketLine(t: Ticket): string {
  return `${t.txid}:${t.outIndex}:${t.k}:${t.pk}`;
}

export function parseLine(line: string): Ticket {
  const [txid, outIndex, k, pk] = line.split(":");
  return { txid: txid!, outIndex: Number(outIndex), k: Number(k), pk: pk!, height: 0 };
}

export function ticketsFromPayment(p: Payment, params: Params = DEFAULT_PARAMS): Ticket[] {
  const pk = parseTicketMemo(p.memo);
  if (!pk) return [];
  const n = Math.floor(p.zats / params.ticketZats);
  return Array.from({ length: n }, (_, k) => ({ txid: p.txid, outIndex: p.outIndex, k, pk, height: p.height }));
}

/** Canonical order for a round's new tickets: (height, txid, outIndex, k). */
export function sortTickets(ts: Ticket[]): Ticket[] {
  return [...ts].sort(
    (a, b) =>
      a.height - b.height ||
      (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0) ||
      a.outIndex - b.outIndex ||
      a.k - b.k,
  );
}

/** Carried tickets keep their order and come first. */
export function roundTicketList(carried: Ticket[], fresh: Ticket[]): Ticket[] {
  return [...carried, ...sortTickets(fresh)];
}

export function listHash(tickets: Ticket[]): string {
  return sha256Hex(tickets.map(ticketLine).join("\n"));
}

/* ---------------- pot split (SPEC §4.4) ---------------- */

export interface PotSplit {
  /** New money this round: ticket payments + donations. The fee applies to this only. */
  feeBaseZats: number;
  /** Money carried in (rolled pots, unclaimed prizes). Already fee'd or fee-free. */
  carriedZats: number;
  feeZats: number;
  /** Network-fee allowance: one ZIP-317 action per payment note (sweep), plus the payout and fee transfer. */
  networkZats: number;
  prizeZats: number;
}

export function potSplit(feeBaseZats: number, carriedZats: number, paymentNotes: number, params: Params = DEFAULT_PARAMS): PotSplit {
  const feeZats = Math.floor((feeBaseZats * params.feeBps) / 10_000);
  const networkZats = (paymentNotes + 5) * params.feePerActionZats;
  const prizeZats = Math.max(0, feeBaseZats + carriedZats - feeZats - networkZats);
  return { feeBaseZats, carriedZats, feeZats, networkZats, prizeZats };
}

/** Balance the treasury needs before it buys the floor zkSNARK. */
export function sweepTargetZats(floorZats: number, params: Params = DEFAULT_PARAMS): number {
  return Math.ceil((floorZats * (10_000 + params.sweepBufferBps)) / 10_000) + params.sweepReserveZats;
}

/* ---------------- draws ---------------- */

function requireHash(blockHashHex: string) {
  if (!/^[0-9a-f]{64}$/.test(blockHashHex)) throw new Error("block hash must be 64 lowercase hex chars");
}

export function drawSeed(round: number, blockHashHex: string, lh: string): string {
  requireHash(blockHashHex);
  return sha256Hex(`${PROTOCOL}|draw|${round}|${blockHashHex}|${lh}`);
}

export function winnerIndex(round: number, blockHashHex: string, tickets: Ticket[]): number {
  if (tickets.length === 0) throw new Error("no tickets");
  const seed = drawSeed(round, blockHashHex, listHash(tickets));
  return Number(BigInt("0x" + seed) % BigInt(tickets.length));
}

/** The weekly bonus uses a separate domain tag so it never mirrors the daily draw. */
export function bonusWinnerIndex(round: number, blockHashHex: string, tickets: Ticket[]): number {
  if (tickets.length === 0) throw new Error("no tickets");
  requireHash(blockHashHex);
  const seed = sha256Hex(`${PROTOCOL}|bonus|${round}|${blockHashHex}|${listHash(tickets)}`);
  return Number(BigInt("0x" + seed) % BigInt(tickets.length));
}

/* ---------------- claims (SPEC §3.2) ---------------- */

/** Shielded only: a transparent destination would put the payout on the public chain. */
export const SHIELDED_ADDR_RE = /^(u1[02-9ac-hj-np-z]{100,}|zs1[02-9ac-hj-np-z]{60,})$/;
export const ACCOUNT_ID_RE = /^ZR-[0-9A-Z]{4}-[0-9A-Z]{4}$/;

/**
 * The destination is committed by hash, so the published claim can be
 * verified without publishing the winner's address.
 */
export function destHash(to: string): string {
  return sha256Hex(`${PROTOCOL}|dest|${to}`);
}

export function claimMessage(round: number, ticket: number, toHash: string, amountZats: number): string {
  return `${PROTOCOL}|claim|round=${round}|ticket=${ticket}|to=${toHash}|amount=${amountZats}`;
}

export function signClaim(code: string, round: number, ticket: number, to: string, amountZats: number): string {
  if (!SHIELDED_ADDR_RE.test(to)) throw new Error("use a shielded address starting with u1 or zs1");
  return b64url(ed25519.sign(utf8ToBytes(claimMessage(round, ticket, destHash(to), amountZats)), secretOf(code)));
}

export function verifyClaim(pk: string, round: number, ticket: number, toHash: string, amountZats: number, sig: string): boolean {
  try {
    return ed25519.verify(fromB64url(sig), utf8ToBytes(claimMessage(round, ticket, toHash, amountZats)), fromB64url(pk));
  } catch {
    return false;
  }
}

export function bonusClaimMessage(round: number, ticket: number, accountHash: string, snarkId: number): string {
  return `${PROTOCOL}|bonus|round=${round}|ticket=${ticket}|to=${accountHash}|snark=${snarkId}`;
}

export function signBonusClaim(code: string, round: number, ticket: number, accountId: string, snarkId: number): string {
  if (!ACCOUNT_ID_RE.test(accountId)) throw new Error("account ID looks like ZR-7K4Q-M2XD");
  return b64url(ed25519.sign(utf8ToBytes(bonusClaimMessage(round, ticket, destHash(accountId), snarkId)), secretOf(code)));
}

export function verifyBonusClaim(pk: string, round: number, ticket: number, accountHash: string, snarkId: number, sig: string): boolean {
  try {
    return ed25519.verify(fromB64url(sig), utf8ToBytes(bonusClaimMessage(round, ticket, accountHash, snarkId)), fromB64url(pk));
  } catch {
    return false;
  }
}

/* ---------------- withdraw (rolled tickets only, SPEC §4.7) ---------------- */

export function withdrawFeeZats(tickets: number, params: Params = DEFAULT_PARAMS): number {
  return params.feePerActionZats * Math.max(2, tickets + 1);
}

export function withdrawAmountZats(tickets: number, params: Params = DEFAULT_PARAMS): number {
  return tickets * params.ticketZats - withdrawFeeZats(tickets, params);
}

export function withdrawMessage(round: number, pk: string, tickets: number, amountZats: number, to: string): string {
  return `${PROTOCOL}|withdraw|round=${round}|pk=${pk}|tickets=${tickets}|amount=${amountZats}|to=${to}`;
}

export function signWithdraw(code: string, round: number, tickets: number, amountZats: number, to: string): string {
  if (!SHIELDED_ADDR_RE.test(to)) throw new Error("use a shielded address starting with u1 or zs1");
  const key = keyFromCode(code);
  return b64url(ed25519.sign(utf8ToBytes(withdrawMessage(round, key.pk, tickets, amountZats, to)), secretOf(code)));
}

export function verifyWithdraw(pk: string, round: number, tickets: number, amountZats: number, to: string, sig: string): boolean {
  if (!SHIELDED_ADDR_RE.test(to)) return false;
  try {
    return ed25519.verify(fromB64url(sig), utf8ToBytes(withdrawMessage(round, pk, tickets, amountZats, to)), fromB64url(pk));
  } catch {
    return false;
  }
}

/* ---------------- public round record ---------------- */

/**
 * open → closed (waiting for the seed block) → drawn (waiting for the claim)
 *      → claimed (payout queued) → paid
 * open → rolled (no tickets)          drawn → expired (prize rolls forward)
 */
export type RoundStatus = "open" | "closed" | "rolled" | "drawn" | "claimed" | "paid" | "expired";

export interface BonusRecord {
  snarkId: number;
  /** The drawn rounds whose tickets were eligible, in order. */
  rounds: number[];
  listHash: string;
  ticketCount: number;
  /** Index into the concatenated ticket lists of `rounds`. */
  winner: number;
  status: "drawn" | "claimed" | "delivered" | "expired";
  claim?: { toHash: string; sig: string; deliveredAt?: string };
}

export interface RoundRecord {
  round: number;
  status: RoundStatus;
  params: Params;
  openHeight: number;
  closeHeight: number;
  seedHeight: number;
  potZats: number;
  paymentNotes: number;
  feeBaseZats: number;
  carriedZats: number;
  tickets: string[];
  /** The first `carriedCount` tickets came from an earlier round that rolled. */
  carriedCount: number;
  withdrawn: { tickets: string[]; amountZats: number; feeZats: number; txid?: string }[];
  listHash?: string;
  seedBlockHash?: string;
  winner?: number;
  split?: PotSplit;
  feeTxid?: string;
  claim?: { toHash: string; amountZats: number; sig: string; txid?: string; paidAt?: string };
  bonus?: BonusRecord;
}

export interface VerifyResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

/** Re-derives everything a third party can check from one published round file. */
export function verifyRound(r: RoundRecord): VerifyResult {
  const checks: VerifyResult["checks"] = [];
  const tickets = r.tickets.map(parseLine);
  const lh = listHash(tickets);
  checks.push({ name: "listHash", ok: !r.listHash || lh === r.listHash, detail: lh });
  if (r.seedBlockHash && r.winner !== undefined) {
    const w = winnerIndex(r.round, r.seedBlockHash, tickets);
    checks.push({ name: "winner", ok: w === r.winner, detail: `computed ${w}, published ${r.winner}` });
  }
  if (r.split) {
    const s = potSplit(r.split.feeBaseZats, r.split.carriedZats, r.paymentNotes, r.params);
    const ok = s.feeZats === r.split.feeZats && s.prizeZats === r.split.prizeZats && s.networkZats === r.split.networkZats;
    checks.push({ name: "fee and prize", ok, detail: `fee ${zatsToZec(s.feeZats)} ZEC, prize ${zatsToZec(s.prizeZats)} ZEC` });
  }
  if (r.claim && r.winner !== undefined) {
    const pk = tickets[r.winner]?.pk ?? "";
    checks.push({
      name: "claim signature",
      ok: verifyClaim(pk, r.round, r.winner, r.claim.toHash, r.claim.amountZats, r.claim.sig),
      detail: `prize ${zatsToZec(r.claim.amountZats)} ZEC`,
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

/** Checks a weekly bonus draw, given the ticket lists of the rounds it names. */
export function verifyBonus(r: RoundRecord, ticketsByRound: Record<number, string[]>): VerifyResult {
  const checks: VerifyResult["checks"] = [];
  const b = r.bonus;
  if (!b || !r.seedBlockHash) return { ok: true, checks };
  const lines = b.rounds.flatMap((n) => ticketsByRound[n] ?? []);
  const tickets = lines.map(parseLine);
  checks.push({ name: "bonus listHash", ok: listHash(tickets) === b.listHash, detail: `${tickets.length} tickets` });
  const w = bonusWinnerIndex(r.round, r.seedBlockHash, tickets);
  checks.push({ name: "bonus winner", ok: w === b.winner, detail: `computed ${w}, published ${b.winner}` });
  if (b.claim) {
    const pk = tickets[b.winner]?.pk ?? "";
    checks.push({
      name: "bonus claim signature",
      ok: verifyBonusClaim(pk, r.round, b.winner, b.claim.toHash, b.snarkId, b.claim.sig),
      detail: `zkSNARK #${b.snarkId}`,
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

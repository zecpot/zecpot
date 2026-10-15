/**
 * SNARKPOT core: pure, deterministic protocol code shared by the engine,
 * the web app and the verifier. See SPEC.md §4.
 * No I/O here — everything is a function of its inputs.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export const PROTOCOL = "SNARKPOT1";
export const ZATS_PER_ZEC = 100_000_000;

export interface Params {
  ticketZats: number;
  roundBlocks: number;
  seedDelay: number;
  reorgSafety: number;
  bufferBps: number;
  feeReserveZats: number;
  houseFeeBps: number;
  claimWindowBlocks: number;
}

export const DEFAULT_PARAMS: Params = {
  ticketZats: 10_000_000,
  roundBlocks: 1152,
  seedDelay: 10,
  reorgSafety: 10,
  bufferBps: 500,
  feeReserveZats: 200_000,
  houseFeeBps: 0,
  claimWindowBlocks: 16_128,
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

/* ---------------- memo ---------------- */

export function ticketMemo(pk: string): string {
  return `${PROTOCOL} ${pk}`;
}

/** Returns the public key if the memo is a valid ticket memo, else null. */
export function parseTicketMemo(memo: string | null | undefined): string | null {
  if (!memo) return null;
  const m = memo.replace(/\u0000+$/g, "").trim();
  const match = /^SNARKPOT1 ([A-Za-z0-9_-]{43})$/.exec(m);
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

/* ---------------- pot / target ---------------- */

export function targetZats(floorZats: number, params: Params = DEFAULT_PARAMS): number {
  return Math.ceil((floorZats * (10_000 + params.bufferBps)) / 10_000) + params.feeReserveZats;
}

export function ticketsNeeded(potZats: number, floorZats: number, params: Params = DEFAULT_PARAMS): number {
  const gap = targetZats(floorZats, params) - potZats;
  return gap <= 0 ? 0 : Math.ceil(gap / params.ticketZats);
}

/* ---------------- draw ---------------- */

export function drawSeed(round: number, blockHashHex: string, lh: string): string {
  if (!/^[0-9a-f]{64}$/.test(blockHashHex)) throw new Error("block hash must be 64 lowercase hex chars");
  return sha256Hex(`${PROTOCOL}|draw|${round}|${blockHashHex}|${lh}`);
}

export function winnerIndex(round: number, blockHashHex: string, tickets: Ticket[]): number {
  if (tickets.length === 0) throw new Error("no tickets");
  const seed = drawSeed(round, blockHashHex, listHash(tickets));
  return Number(BigInt("0x" + seed) % BigInt(tickets.length));
}

/* ---------------- claim ---------------- */

export const ACCOUNT_ID_RE = /^ZR-[0-9A-Z]{4}-[0-9A-Z]{4}$/;

export function claimMessage(round: number, ticket: number, to: string): string {
  return `${PROTOCOL}|claim|round=${round}|ticket=${ticket}|to=${to}`;
}

export function signClaim(code: string, round: number, ticket: number, to: string): string {
  if (!ACCOUNT_ID_RE.test(to)) throw new Error("account ID looks like ZR-7K4Q-M2XD");
  const sk = fromB64url(code.trim().slice(CODE_PREFIX.length));
  return b64url(ed25519.sign(utf8ToBytes(claimMessage(round, ticket, to)), sk));
}

export function verifyClaim(pk: string, round: number, ticket: number, to: string, sig: string): boolean {
  if (!ACCOUNT_ID_RE.test(to)) return false;
  try {
    return ed25519.verify(fromB64url(sig), utf8ToBytes(claimMessage(round, ticket, to)), fromB64url(pk));
  } catch {
    return false;
  }
}

/* ---------------- public round record ---------------- */

export type RoundStatus = "open" | "closed" | "rolled" | "drawn" | "purchase_pending" | "purchased" | "claimed" | "expired";

export interface RoundRecord {
  round: number;
  status: RoundStatus;
  params: Params;
  openHeight: number;
  closeHeight: number;
  seedHeight: number;
  potZats: number;
  floorZatsAtClose?: number;
  targetZats?: number;
  tickets: string[]; // ticket lines in canonical order
  listHash?: string;
  seedBlockHash?: string;
  winner?: number;
  purchase?: { snarkId: number; priceZats: number; orderId: string; paymentTxid: string };
  claim?: { to: string; sig: string; transferredAt: string };
}

export interface VerifyResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

/** Re-derives everything a third party can check from a published round file. */
export function verifyRound(r: RoundRecord): VerifyResult {
  const checks: VerifyResult["checks"] = [];
  const tickets: Ticket[] = r.tickets.map((line) => {
    const [txid, outIndex, k, pk] = line.split(":");
    return { txid: txid!, outIndex: Number(outIndex), k: Number(k), pk: pk!, height: 0 };
  });
  const lh = listHash(tickets);
  checks.push({ name: "listHash", ok: !r.listHash || lh === r.listHash, detail: lh });
  if (r.seedBlockHash && r.winner !== undefined) {
    const w = winnerIndex(r.round, r.seedBlockHash, tickets);
    checks.push({ name: "winner", ok: w === r.winner, detail: `computed ${w}, published ${r.winner}` });
  }
  if (r.claim && r.winner !== undefined) {
    const pk = tickets[r.winner]?.pk ?? "";
    checks.push({
      name: "claim signature",
      ok: verifyClaim(pk, r.round, r.winner, r.claim.to, r.claim.sig),
      detail: `to ${r.claim.to}`,
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

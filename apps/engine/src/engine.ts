/**
 * Round state machine (SPEC.md §3–4). One `tick()` does, in order:
 *   ingest payments → close/roll rounds → draw → purchase → deliver claims → expire
 * All state lives in one JSON-serialisable object so a crash between ticks
 * loses nothing; `publicView()` is what gets written to /data.
 */
import {
  DEFAULT_PARAMS,
  listHash,
  roundTicketList,
  ticketLine,
  ticketsFromPayment,
  ticketsNeeded,
  targetZats,
  verifyClaim,
  winnerIndex,
  ACCOUNT_ID_RE,
  type Params,
  type RoundRecord,
  type Ticket,
} from "../../../packages/core/src/index.ts";
import type { ChainAdapter, WalletAdapter, ZilkroadAdapter } from "./adapters/types.ts";

export interface InternalRound extends RoundRecord {
  carried: Ticket[];
  fresh: Ticket[];
  donationsZats: number;
  pendingOrder?: { orderId: string; code: string; snarkId: number; listingId: number; priceZats: number; paymentTxid: string };
  failedListings: number[];
  pendingClaim?: { to: string; sig: string };
  bonusSnarkIds: number[];
}

export interface EngineState {
  version: 1;
  params: Params;
  poolAddress: string;
  poolZilkroadAddress: string;
  uivk: string;
  scannedHeight: number;
  rounds: InternalRound[];
  bonusSnarkIds: number[];
  /** Order codes of lost purchases; an incoming payment whose memo contains one is a refund, not pot money. */
  refundCodes: string[];
  lastFloorZats: number | null;
  log: { at: string; msg: string }[];
}

export interface Deps {
  wallet: WalletAdapter;
  chain: ChainAdapter;
  market: ZilkroadAdapter;
  now?: () => Date;
}

const MAX_PURCHASE_ATTEMPTS = 5;

export function initialState(opts: {
  startHeight: number;
  poolAddress: string;
  poolZilkroadAddress: string;
  uivk: string;
  params?: Params;
}): EngineState {
  const params = opts.params ?? DEFAULT_PARAMS;
  return {
    version: 1,
    params,
    poolAddress: opts.poolAddress,
    poolZilkroadAddress: opts.poolZilkroadAddress,
    uivk: opts.uivk,
    scannedHeight: opts.startHeight,
    rounds: [newRound(1, opts.startHeight, params, [], 0)],
    bonusSnarkIds: [],
    refundCodes: [],
    lastFloorZats: null,
    log: [],
  };
}

function newRound(n: number, openHeight: number, params: Params, carried: Ticket[], carriedPot: number): InternalRound {
  const closeHeight = openHeight + params.roundBlocks;
  return {
    round: n,
    status: "open",
    params,
    openHeight,
    closeHeight,
    seedHeight: closeHeight + params.seedDelay,
    potZats: carriedPot,
    tickets: [],
    carried,
    fresh: [],
    donationsZats: 0,
    failedListings: [],
    bonusSnarkIds: [],
  };
}

export class Engine {
  constructor(
    public state: EngineState,
    private deps: Deps,
  ) {}

  private get p() {
    return this.state.params;
  }
  private log(msg: string) {
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    this.state.log.push({ at, msg });
    if (this.state.log.length > 500) this.state.log.splice(0, this.state.log.length - 500);
  }
  openRound(): InternalRound {
    const r = this.state.rounds.at(-1)!;
    if (r.status !== "open") throw new Error("invariant: last round must be open");
    return r;
  }
  round(n: number) {
    return this.state.rounds.find((r) => r.round === n);
  }

  async tick(): Promise<void> {
    const tip = await this.deps.wallet.height();
    try {
      this.state.lastFloorZats = await this.deps.market.floorZats();
    } catch (e) {
      this.log(`floor fetch failed: ${(e as Error).message}`);
    }

    // 1+2. Ingest and close, one round boundary at a time.
    for (;;) {
      const open = this.openRound();
      const upTo = Math.min(tip, open.closeHeight);
      await this.ingest(open, upTo);
      if (tip < open.closeHeight) break;
      this.close(open);
    }

    // 3–6. Drawn rounds move forward.
    for (const r of this.state.rounds) {
      // One round's failure (market down, session expired) must not block the others.
      const guard = async (what: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (e) {
          this.log(`round ${r.round}: ${what} failed: ${(e as Error).message}`);
        }
      };
      if (r.status === "closed" && tip >= r.seedHeight + this.p.reorgSafety) await guard("draw", () => this.draw(r));
      if (r.status === "purchase_pending") await guard("purchase", () => this.purchase(r));
      if (r.status === "purchased" && r.pendingClaim) await guard("delivery", () => this.deliver(r));
      if (r.status === "purchased" && !r.pendingClaim && tip > r.seedHeight + this.p.claimWindowBlocks) {
        r.status = "expired";
        this.state.bonusSnarkIds.push(r.purchase!.snarkId, ...r.bonusSnarkIds);
        this.log(`round ${r.round}: unclaimed, zkSNARK #${r.purchase!.snarkId} rolls into the next draw as a bonus`);
      }
    }
  }

  private async ingest(open: InternalRound, upTo: number) {
    if (upTo <= this.state.scannedHeight) return;
    const pays = (await this.deps.wallet.incoming(this.state.scannedHeight)).filter((p) => p.height <= upTo);
    for (const pay of pays) {
      const refund = this.state.refundCodes.find((c) => pay.memo?.includes(c));
      if (refund) {
        this.state.refundCodes = this.state.refundCodes.filter((c) => c !== refund);
        this.log(`refund of ${pay.zats} zats for lost order ${refund} received (not pot money)`);
        continue;
      }
      const ts = ticketsFromPayment(pay, this.p);
      open.potZats += pay.zats;
      if (ts.length === 0) {
        open.donationsZats += pay.zats;
        this.log(`round ${open.round}: ${pay.zats} zats with no valid ticket memo → pot`);
      }
      open.fresh.push(...ts);
    }
    this.state.scannedHeight = upTo;
    open.tickets = roundTicketList(open.carried, open.fresh).map(ticketLine);
  }

  private close(r: InternalRound) {
    const list = roundTicketList(r.carried, r.fresh);
    r.tickets = list.map(ticketLine);
    r.listHash = listHash(list);
    const floor = this.state.lastFloorZats ?? Infinity;
    r.floorZatsAtClose = Number.isFinite(floor) ? floor : undefined;
    r.targetZats = Number.isFinite(floor) ? targetZats(floor, this.p) : undefined;
    const eligible = list.length > 0 && r.targetZats !== undefined && r.potZats >= r.targetZats;
    let next: InternalRound;
    if (eligible) {
      r.status = "closed";
      r.bonusSnarkIds = this.state.bonusSnarkIds.splice(0);
      next = newRound(r.round + 1, r.closeHeight, this.p, [], 0);
      this.log(`round ${r.round}: closed with ${list.length} tickets, pot ${r.potZats} ≥ target ${r.targetZats}; draw at block ${r.seedHeight}`);
    } else {
      r.status = "rolled";
      next = newRound(r.round + 1, r.closeHeight, this.p, list, r.potZats);
      this.log(`round ${r.round}: rolled over (${list.length} tickets, pot ${r.potZats}, target ${r.targetZats ?? "?"})`);
    }
    this.state.rounds.push(next);
  }

  private async draw(r: InternalRound) {
    const list = r.tickets.map(parseLine);
    r.seedBlockHash = await this.deps.chain.blockHash(r.seedHeight);
    r.winner = winnerIndex(r.round, r.seedBlockHash, list);
    r.status = "purchase_pending";
    this.log(`round ${r.round}: winner is ticket ${r.winner} of ${list.length}`);
  }

  private async purchase(r: InternalRound) {
    const { market, wallet } = this.deps;
    if (r.pendingOrder) {
      const st = await market.orderState(r.pendingOrder.orderId);
      if (st === "awaiting") return;
      if (st === "paid") {
        const po = r.pendingOrder;
        r.purchase = { snarkId: po.snarkId, priceZats: po.priceZats, orderId: po.orderId, paymentTxid: po.paymentTxid };
        r.status = "purchased";
        r.pendingOrder = undefined;
        const surplus = r.potZats - po.priceZats - this.p.feeReserveZats;
        if (surplus > 0) this.openRound().potZats += surplus;
        this.log(`round ${r.round}: bought zkSNARK #${po.snarkId} for ${po.priceZats} zats; surplus ${Math.max(0, surplus)} → round ${this.openRound().round}`);
        return;
      }
      // Lost the race or expired. ASSUMPTION (confirm with Zilkroad): a losing
      // payment comes back with the order code in its memo. Until it does, the
      // wallet may not have enough spendable to retry — purchase() just waits.
      r.failedListings.push(r.pendingOrder.listingId);
      this.state.refundCodes.push(r.pendingOrder.code);
      this.log(`round ${r.round}: order on #${r.pendingOrder.snarkId} ${st}; retrying`);
      r.pendingOrder = undefined;
    }
    if (r.failedListings.length >= MAX_PURCHASE_ATTEMPTS) return; // operator attention needed
    if (!(await market.sessionOk())) {
      this.log("zilkroad session invalid — operator must sign in again");
      return;
    }
    const budget = r.potZats - this.p.feeReserveZats;
    const pick = (await market.listings(25)).find((l) => l.priceZats <= budget && !r.failedListings.includes(l.listingId));
    if (!pick) {
      this.log(`round ${r.round}: no listing within budget ${budget}; will retry`);
      return;
    }
    const { spendableZats } = await wallet.balance();
    if (spendableZats < pick.priceZats + this.p.feeReserveZats) {
      this.log(`round ${r.round}: waiting for spendable funds (have ${spendableZats}, need ${pick.priceZats + this.p.feeReserveZats})`);
      return;
    }
    const order = await market.createOrder(pick.listingId, this.state.poolZilkroadAddress);
    const txid = await wallet.send(order.depositAddress, order.remainingZats, order.code);
    r.pendingOrder = { orderId: order.id, code: order.code, snarkId: pick.snarkId, listingId: pick.listingId, priceZats: order.remainingZats, paymentTxid: txid };
    this.log(`round ${r.round}: order ${order.id} for #${pick.snarkId}, paid in ${txid}`);
  }

  /** Called by the HTTP API. Validates now; delivery happens on tick. */
  submitClaim(round: number, ticket: number, to: string, sig: string): { ok: boolean; error?: string } {
    const r = this.round(round);
    if (!r || r.winner === undefined) return { ok: false, error: "no draw for that round yet" };
    if (r.status === "claimed") return { ok: false, error: "already claimed" };
    if (r.status === "expired") return { ok: false, error: "claim window has closed" };
    if (ticket !== r.winner) return { ok: false, error: "that ticket did not win" };
    if (!ACCOUNT_ID_RE.test(to)) return { ok: false, error: "account ID looks like ZR-7K4Q-M2XD" };
    const pk = parseLine(r.tickets[ticket]!).pk;
    if (!verifyClaim(pk, round, ticket, to, sig)) return { ok: false, error: "signature does not match the winning ticket" };
    r.pendingClaim = { to, sig };
    this.log(`round ${round}: valid claim received`);
    return { ok: true };
  }

  private async deliver(r: InternalRound) {
    const c = r.pendingClaim!;
    for (const id of [r.purchase!.snarkId, ...r.bonusSnarkIds]) await this.deps.market.transfer(id, c.to);
    r.claim = { to: c.to, sig: c.sig, transferredAt: (this.deps.now?.() ?? new Date()).toISOString() };
    r.pendingClaim = undefined;
    r.status = "claimed";
    this.log(`round ${r.round}: delivered to ${c.to}`);
  }

  /* ---------------- public data ---------------- */

  publicRound(r: InternalRound): RoundRecord & { bonusSnarkIds: number[]; donationsZats: number } {
    const { carried, fresh, pendingOrder, failedListings, pendingClaim, ...pub } = r;
    return pub;
  }

  publicState() {
    const open = this.openRound();
    const floor = this.state.lastFloorZats;
    return {
      protocol: "SNARKPOT1",
      params: this.p,
      poolAddress: this.state.poolAddress,
      uivk: this.state.uivk,
      floorZats: floor,
      open: {
        round: open.round,
        openHeight: open.openHeight,
        closeHeight: open.closeHeight,
        potZats: open.potZats,
        tickets: open.tickets.length,
        targetZats: floor ? targetZats(floor, this.p) : null,
        ticketsNeeded: floor ? ticketsNeeded(open.potZats, floor, this.p) : null,
      },
      scannedHeight: this.state.scannedHeight,
      rounds: this.state.rounds.map((r) => ({
        round: r.round,
        status: r.status,
        tickets: r.tickets.length,
        potZats: r.potZats,
        winner: r.winner ?? null,
        snarkId: r.purchase?.snarkId ?? null,
      })),
    };
  }
}

export function parseLine(line: string): Ticket {
  const [txid, outIndex, k, pk] = line.split(":");
  return { txid: txid!, outIndex: Number(outIndex), k: Number(k), pk: pk!, height: 0 };
}

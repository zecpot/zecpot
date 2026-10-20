/**
 * zecPOT engine (SPEC.md §3–4). One `tick()` does, in order:
 *   ingest payments → close/roll rounds → draw (+ weekly bonus) → expire
 *   → pay out (fees, prizes, withdrawals) → deliver bonus zkSNARKs → sweep floor
 * All state is one JSON-serialisable object, so a crash between ticks loses
 * nothing. Zilkroad failures never block payouts: they become operator tasks.
 */
import {
  DEFAULT_PARAMS,
  destHash,
  listHash,
  parseLine,
  potSplit,
  roundTicketList,
  sweepTargetZats,
  ticketLine,
  ticketsFromPayment,
  verifyBonusClaim,
  verifyClaim,
  verifyWithdraw,
  withdrawAmountZats,
  withdrawFeeZats,
  winnerIndex,
  bonusWinnerIndex,
  ACCOUNT_ID_RE,
  PROTOCOL,
  SHIELDED_ADDR_RE,
  type Params,
  type RoundRecord,
  type Ticket,
} from "../../../packages/core/src/index.ts";
import type { ChainAdapter, TreasuryAdapter, WalletAdapter, ZilkroadAdapter } from "./adapters/types.ts";

export interface InternalRound extends RoundRecord {
  carried: Ticket[];
  fresh: Ticket[];
  donationsZats: number;
  /** Private: the bonus winner's Zilkroad account ID, until delivered. */
  bonusTo?: string;
}

export interface Payout {
  id: number;
  kind: "prize" | "fee" | "withdraw";
  round: number;
  /** Private. Never published. */
  to: string;
  amountZats: number;
  memo: string;
  status: "queued" | "sent";
  txid?: string;
  lines?: string[];
}

export interface Task {
  id: number;
  kind: "buy" | "transfer" | "session";
  detail: string;
  status: "open" | "done";
  createdAt: string;
  round?: number;
  snarkId?: number;
  /** Private (a Zilkroad account ID) for transfer tasks. */
  to?: string;
  budgetZats?: number;
  doneAt?: string;
}

export interface Sweep {
  snarkId: number;
  priceZats: number;
  txid?: string;
  orderId?: string;
  manual: boolean;
  at: string;
}

export interface EngineState {
  version: 2;
  params: Params;
  mode: "mock" | "live";
  poolAddress: string;
  /** The INBOX wallet's unified full viewing key (published). */
  viewingKey: string;
  treasury: {
    address: string;
    /** The TREASURY wallet's unified full viewing key (published). */
    viewingKey: string;
    /** Address registered with the pot's Zilkroad account (orders are placed for it). */
    zilkroadAddress: string;
    lastBalanceZats: number | null;
  };
  scannedHeight: number;
  rounds: InternalRound[];
  /** zkSNARKs the treasury holds and has not promised to anyone. */
  treasurySnarks: number[];
  sweeps: Sweep[];
  pendingSweep?: { orderId: string; code: string; snarkId: number; listingId: number; priceZats: number; paymentTxid: string };
  failedSweepListings: number[];
  payouts: Payout[];
  tasks: Task[];
  lastFloorZats: number | null;
  log: { at: string; msg: string }[];
}

export interface Deps {
  wallet: WalletAdapter;
  treasury: TreasuryAdapter;
  chain: ChainAdapter;
  market: ZilkroadAdapter;
  now?: () => Date;
}

export interface InitOpts {
  startHeight: number;
  poolAddress: string;
  viewingKey: string;
  treasuryAddress: string;
  treasuryViewingKey: string;
  zilkroadAddress: string;
  params?: Params;
  mode?: "mock" | "live";
}

export function initialState(o: InitOpts): EngineState {
  const params = o.params ?? DEFAULT_PARAMS;
  return {
    version: 2,
    params,
    mode: o.mode ?? "live",
    poolAddress: o.poolAddress,
    viewingKey: o.viewingKey,
    treasury: { address: o.treasuryAddress, viewingKey: o.treasuryViewingKey, zilkroadAddress: o.zilkroadAddress, lastBalanceZats: null },
    scannedHeight: o.startHeight,
    rounds: [newRound(1, o.startHeight, params)],
    treasurySnarks: [],
    sweeps: [],
    failedSweepListings: [],
    payouts: [],
    tasks: [],
    lastFloorZats: null,
    log: [],
  };
}

/**
 * Converts a SNARKPOT (version 1) state into zecPOT. Nothing was ever drawn
 * under v1, so the open round is rebuilt from scratch at its original height
 * and its payments are re-read on the next tick under the new ticket price.
 */
export function migrateState(old: { version?: number } & Record<string, unknown>, o: Omit<InitOpts, "startHeight">): EngineState {
  if (old.version === 2) return old as unknown as EngineState;
  const rounds = (old.rounds as { openHeight: number }[] | undefined) ?? [];
  const startHeight = rounds[0]?.openHeight ?? (old.scannedHeight as number);
  const s = initialState({ ...o, startHeight });
  s.log.push({ at: new Date().toISOString(), msg: `migrated from version ${old.version ?? 1}; re-reading payments from block ${startHeight}` });
  return s;
}

function newRound(n: number, openHeight: number, params: Params, carry?: { feeBase: number; carried: number; notes: number }): InternalRound {
  const closeHeight = openHeight + params.roundBlocks;
  const feeBaseZats = carry?.feeBase ?? 0;
  const carriedZats = carry?.carried ?? 0;
  return {
    round: n,
    status: "open",
    params,
    openHeight,
    closeHeight,
    seedHeight: closeHeight + params.seedDelay,
    potZats: feeBaseZats + carriedZats,
    paymentNotes: carry?.notes ?? 0,
    feeBaseZats,
    carriedZats,
    tickets: [],
    carriedCount: 0,
    withdrawn: [],
    carried: [],
    fresh: [],
    donationsZats: 0,
  };
}

const MAX_SWEEP_ATTEMPTS = 5;

export class Engine {
  constructor(
    public state: EngineState,
    private deps: Deps,
  ) {}

  private get p() {
    return this.state.params;
  }
  private now() {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
  private log(msg: string) {
    this.state.log.push({ at: this.now(), msg });
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
  private addTask(t: Omit<Task, "id" | "status" | "createdAt">) {
    const dup = this.state.tasks.find((x) => x.status === "open" && x.kind === t.kind && x.round === t.round && x.snarkId === t.snarkId);
    if (dup) return dup;
    const task: Task = { ...t, id: this.state.tasks.length + 1, status: "open", createdAt: this.now() };
    this.state.tasks.push(task);
    this.log(`operator task ${task.id}: ${task.detail}`);
    return task;
  }

  async tick(): Promise<void> {
    await this.deps.wallet.beginTick?.();
    await this.deps.treasury.beginTick?.();
    const tip = await this.deps.wallet.height();
    try {
      this.state.lastFloorZats = await this.deps.market.floorZats();
    } catch (e) {
      this.log(`floor fetch failed: ${(e as Error).message}`);
    }

    for (;;) {
      const open = this.openRound();
      await this.ingest(open, Math.min(tip, open.closeHeight));
      if (tip < open.closeHeight) break;
      this.close(open);
    }

    for (const r of this.state.rounds) {
      const guard = async (what: string, fn: () => Promise<void> | void) => {
        try {
          await fn();
        } catch (e) {
          this.log(`round ${r.round}: ${what} failed: ${(e as Error).message}`);
        }
      };
      if (r.status === "closed" && tip >= r.seedHeight + this.p.reorgSafety) await guard("draw", () => this.draw(r));
      const expired = tip > r.seedHeight + this.p.claimWindowBlocks;
      if (r.status === "drawn" && expired) this.expirePrize(r);
      if (r.bonus?.status === "drawn" && expired) {
        r.bonus.status = "expired";
        this.state.treasurySnarks.push(r.bonus.snarkId);
        this.log(`round ${r.round}: bonus zkSNARK #${r.bonus.snarkId} unclaimed, back to the treasury`);
      }
      if (r.bonus?.status === "claimed") await guard("bonus delivery", () => this.deliverBonus(r));
    }

    await this.payOut();
    try {
      await this.sweep();
    } catch (e) {
      this.log(`sweep failed: ${(e as Error).message}`);
    }
  }

  /* ---------------- rounds ---------------- */

  private async ingest(open: InternalRound, upTo: number) {
    if (upTo <= this.state.scannedHeight) return;
    const pays = (await this.deps.wallet.incoming(this.state.scannedHeight)).filter((p) => p.height <= upTo);
    for (const pay of pays) {
      const ts = ticketsFromPayment(pay, this.p);
      open.potZats += pay.zats;
      open.feeBaseZats += pay.zats;
      open.paymentNotes += 1;
      if (ts.length === 0) {
        open.donationsZats += pay.zats;
        this.log(`round ${open.round}: ${pay.zats} zats with no valid ticket memo → pot`);
      }
      open.fresh.push(...ts);
    }
    this.state.scannedHeight = upTo;
    this.refreshList(open);
  }

  private refreshList(r: InternalRound) {
    r.tickets = roundTicketList(r.carried, r.fresh).map(ticketLine);
    r.carriedCount = r.carried.length;
  }

  private close(r: InternalRound) {
    const list = roundTicketList(r.carried, r.fresh);
    r.tickets = list.map(ticketLine);
    r.carriedCount = r.carried.length;
    r.listHash = listHash(list);
    if (list.length >= this.p.minTickets) {
      r.status = "closed";
      this.state.rounds.push(newRound(r.round + 1, r.closeHeight, this.p));
      this.log(`round ${r.round}: closed with ${list.length} tickets, pot ${r.potZats}; draw at block ${r.seedHeight}`);
    } else {
      r.status = "rolled";
      const next = newRound(r.round + 1, r.closeHeight, this.p, { feeBase: r.feeBaseZats, carried: r.carriedZats, notes: r.paymentNotes });
      next.carried = list;
      this.refreshList(next);
      this.state.rounds.push(next);
      this.log(`round ${r.round}: rolled over (${list.length} tickets, pot ${r.potZats})`);
    }
  }

  private async draw(r: InternalRound) {
    const list = r.tickets.map(parseLine);
    r.seedBlockHash = await this.deps.chain.blockHash(r.seedHeight);
    r.winner = winnerIndex(r.round, r.seedBlockHash, list);
    r.split = potSplit(r.feeBaseZats, r.carriedZats, r.paymentNotes, this.p);
    r.status = "drawn";
    this.log(`round ${r.round}: ticket ${r.winner} of ${list.length} wins ${r.split.prizeZats} zats; fee ${r.split.feeZats} → treasury`);
    if (r.split.feeZats > 0) {
      this.queue({ kind: "fee", round: r.round, to: this.state.treasury.address, amountZats: r.split.feeZats, memo: `${PROTOCOL} fee round ${r.round}` });
    }
    if (r.round % this.p.bonusEveryRounds === 0 && this.state.treasurySnarks.length > 0) this.drawBonus(r);
  }

  /** Weekly bonus: one treasury zkSNARK, drawn over every ticket in this round and the previous six. */
  private drawBonus(r: InternalRound) {
    const from = r.round - this.p.bonusEveryRounds + 1;
    const rounds = this.state.rounds.filter((x) => x.round >= from && x.round <= r.round && x.winner !== undefined && x.tickets.length > 0);
    const lines = rounds.flatMap((x) => x.tickets);
    if (lines.length === 0) return;
    const tickets = lines.map(parseLine);
    const winner = bonusWinnerIndex(r.round, r.seedBlockHash!, tickets);
    const snarkId = this.state.treasurySnarks.shift()!;
    r.bonus = { snarkId, rounds: rounds.map((x) => x.round), listHash: listHash(tickets), ticketCount: tickets.length, winner, status: "drawn" };
    this.log(`round ${r.round}: weekly bonus zkSNARK #${snarkId} goes to ticket ${winner} of ${tickets.length}`);
  }

  private expirePrize(r: InternalRound) {
    r.status = "expired";
    const open = this.openRound();
    const prize = r.split?.prizeZats ?? 0;
    open.carriedZats += prize;
    open.potZats += prize;
    this.log(`round ${r.round}: prize unclaimed after the claim window; ${prize} zats roll into round ${open.round}`);
  }

  /* ---------------- claims (HTTP API) ---------------- */

  /** The winner claims the ZEC prize to a shielded address they sign for. */
  submitClaim(round: number, ticket: number, to: string, sig: string): { ok: boolean; error?: string; amountZats?: number } {
    const r = this.round(round);
    if (!r || r.winner === undefined || !r.split) return { ok: false, error: "no draw for that round yet" };
    if (r.status === "claimed" || r.status === "paid") return { ok: false, error: "already claimed" };
    if (r.status === "expired") return { ok: false, error: "claim window has closed" };
    if (ticket !== r.winner) return { ok: false, error: "that ticket did not win" };
    if (!SHIELDED_ADDR_RE.test(to)) return { ok: false, error: "use a shielded address starting with u1 or zs1" };
    const pk = parseLine(r.tickets[ticket]!).pk;
    const amount = r.split.prizeZats;
    if (!verifyClaim(pk, round, ticket, destHash(to), amount, sig)) return { ok: false, error: "signature does not match the winning ticket and prize" };
    r.status = "claimed";
    r.claim = { toHash: destHash(to), amountZats: amount, sig };
    this.queue({ kind: "prize", round, to, amountZats: amount, memo: `${PROTOCOL} prize round ${round}` });
    this.log(`round ${round}: prize claimed, ${amount} zats queued`);
    return { ok: true, amountZats: amount };
  }

  /** The weekly bonus winner claims the zkSNARK to a Zilkroad account ID. */
  submitBonusClaim(round: number, ticket: number, accountId: string, sig: string): { ok: boolean; error?: string } {
    const r = this.round(round);
    const b = r?.bonus;
    if (!r || !b) return { ok: false, error: "no bonus draw in that round" };
    if (b.status !== "drawn") return { ok: false, error: b.status === "expired" ? "claim window has closed" : "already claimed" };
    if (ticket !== b.winner) return { ok: false, error: "that ticket did not win the bonus" };
    if (!ACCOUNT_ID_RE.test(accountId)) return { ok: false, error: "account ID looks like ZR-7K4Q-M2XD" };
    const lines = b.rounds.flatMap((n) => this.round(n)?.tickets ?? []);
    const pk = parseLine(lines[ticket]!).pk;
    if (!verifyBonusClaim(pk, round, ticket, destHash(accountId), b.snarkId, sig)) return { ok: false, error: "signature does not match the bonus ticket" };
    b.status = "claimed";
    b.claim = { toHash: destHash(accountId), sig };
    r.bonusTo = accountId;
    this.log(`round ${round}: bonus zkSNARK #${b.snarkId} claimed`);
    return { ok: true };
  }

  private async deliverBonus(r: InternalRound) {
    const b = r.bonus!;
    if (this.state.tasks.some((t) => t.status === "open" && t.kind === "transfer" && t.round === r.round)) return;
    try {
      await this.deps.market.transfer(b.snarkId, r.bonusTo!);
      this.markBonusDelivered(r);
    } catch (e) {
      this.addTask({
        kind: "transfer",
        round: r.round,
        snarkId: b.snarkId,
        to: r.bonusTo,
        detail: `Transfer zkSNARK #${b.snarkId} to ${r.bonusTo} on zilkroad.com (bonus, round ${r.round}). API said: ${(e as Error).message}`,
      });
    }
  }

  private markBonusDelivered(r: InternalRound) {
    r.bonus!.status = "delivered";
    r.bonus!.claim!.deliveredAt = this.now();
    r.bonusTo = undefined;
    this.log(`round ${r.round}: bonus zkSNARK #${r.bonus!.snarkId} delivered`);
  }

  /** Withdraw tickets carried in from a round that rolled (SPEC §4.7). */
  submitWithdraw(round: number, pk: string, to: string, sig: string): { ok: boolean; error?: string; amountZats?: number } {
    const open = this.openRound();
    if (round !== open.round) return { ok: false, error: `withdrawals are open for round ${open.round} only` };
    if (!SHIELDED_ADDR_RE.test(to)) return { ok: false, error: "use a shielded address starting with u1 or zs1" };
    const mine = open.carried.filter((t) => t.pk === pk);
    if (mine.length === 0) return { ok: false, error: "this code has no tickets from a rolled round to withdraw" };
    const n = mine.length;
    const amount = withdrawAmountZats(n, this.p);
    if (!verifyWithdraw(pk, round, n, amount, to, sig)) return { ok: false, error: "signature does not match this ticket code and amount" };
    const lines = mine.map(ticketLine);
    open.carried = open.carried.filter((t) => t.pk !== pk);
    const value = n * this.p.ticketZats;
    open.potZats -= value;
    open.feeBaseZats -= value;
    open.withdrawn.push({ tickets: lines, amountZats: amount, feeZats: withdrawFeeZats(n, this.p) });
    this.refreshList(open);
    this.queue({ kind: "withdraw", round, to, amountZats: amount, memo: `${PROTOCOL} refund`, lines });
    return { ok: true, amountZats: amount };
  }

  /* ---------------- payouts ---------------- */

  private queue(p: Omit<Payout, "id" | "status">) {
    this.state.payouts.push({ ...p, id: this.state.payouts.length + 1, status: "queued" });
  }

  private async payOut() {
    for (const p of this.state.payouts.filter((x) => x.status === "queued")) {
      try {
        p.txid = await this.deps.wallet.send(p.to, p.amountZats, p.memo);
      } catch (e) {
        this.log(`payout ${p.id} (${p.kind}, round ${p.round}): will retry: ${(e as Error).message}`);
        continue; // later payouts may still fit
      }
      p.status = "sent";
      const r = this.round(p.round);
      if (p.kind === "fee" && r) r.feeTxid = p.txid;
      if (p.kind === "prize" && r?.claim) {
        r.claim.txid = p.txid;
        r.claim.paidAt = this.now();
        r.status = "paid";
      }
      if (p.kind === "withdraw" && r) {
        const rec = r.withdrawn.find((w) => w.tickets[0] === p.lines?.[0]);
        if (rec) rec.txid = p.txid;
      }
      this.log(`payout ${p.id} (${p.kind}, round ${p.round}): sent ${p.amountZats} zats`);
    }
  }

  /* ---------------- treasury sweeps ---------------- */

  private async sweep() {
    const { market, treasury } = this.deps;
    const t = this.state.treasury;
    t.lastBalanceZats = (await treasury.balance()).spendableZats;

    if (this.state.pendingSweep) {
      const ps = this.state.pendingSweep;
      const st = await market.orderState(ps.orderId);
      if (st === "awaiting") return;
      this.state.pendingSweep = undefined;
      if (st === "paid") {
        this.state.treasurySnarks.push(ps.snarkId);
        this.state.sweeps.push({ snarkId: ps.snarkId, priceZats: ps.priceZats, txid: ps.paymentTxid, orderId: ps.orderId, manual: false, at: this.now() });
        this.state.failedSweepListings = [];
        this.log(`treasury swept zkSNARK #${ps.snarkId} for ${ps.priceZats} zats`);
        return;
      }
      this.state.failedSweepListings.push(ps.listingId);
      this.log(`treasury order on #${ps.snarkId} ${st}; will try the next listing`);
    }

    if (this.state.tasks.some((x) => x.status === "open" && x.kind === "buy")) return; // operator is on it
    const floor = this.state.lastFloorZats;
    if (!floor || !Number.isFinite(floor)) return;
    const need = sweepTargetZats(floor, this.p);
    if (t.lastBalanceZats < need) return;

    const budget = t.lastBalanceZats - this.p.sweepReserveZats;
    const manual = (why: string) =>
      this.addTask({ kind: "buy", budgetZats: budget, detail: `Buy the floor zkSNARK on zilkroad.com for at most ${budget} zats, paying from the treasury wallet. ${why}` });
    if (this.state.failedSweepListings.length >= MAX_SWEEP_ATTEMPTS) return void manual("Automatic buying failed 5 times.");
    try {
      if (!(await market.sessionOk())) return void manual("The Zilkroad session has expired: sign in again and update ZILKROAD_COOKIE, or buy by hand.");
      const pick = (await market.listings(25)).find((l) => l.priceZats <= budget && !this.state.failedSweepListings.includes(l.listingId));
      if (!pick) return;
      const order = await market.createOrder(pick.listingId, t.zilkroadAddress);
      const txid = await treasury.send(order.depositAddress, order.remainingZats, order.code);
      this.state.pendingSweep = { orderId: order.id, code: order.code, snarkId: pick.snarkId, listingId: pick.listingId, priceZats: order.remainingZats, paymentTxid: txid };
      t.lastBalanceZats = Math.max(0, t.lastBalanceZats - order.remainingZats); // until the next balance read
      this.log(`treasury order ${order.id} for #${pick.snarkId} (${order.remainingZats} zats), paid in ${txid}`);
    } catch (e) {
      manual(`The Zilkroad API said: ${(e as Error).message}`);
    }
  }

  /* ---------------- operator ---------------- */

  openTasks() {
    return this.state.tasks.filter((t) => t.status === "open");
  }

  /** Marks a manual task done. buy: needs the zkSNARK number bought (and optionally the payment txid). */
  completeTask(id: number, info: { snarkId?: number; txid?: string; priceZats?: number }): { ok: boolean; error?: string } {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t || t.status !== "open") return { ok: false, error: "no open task with that number" };
    if (t.kind === "buy") {
      if (!info.snarkId) return { ok: false, error: "say which zkSNARK you bought: done <task> <snarkId> [txid]" };
      this.state.treasurySnarks.push(info.snarkId);
      this.state.sweeps.push({ snarkId: info.snarkId, priceZats: info.priceZats ?? 0, txid: info.txid, manual: true, at: this.now() });
      this.state.failedSweepListings = [];
    }
    if (t.kind === "transfer") {
      const r = this.round(t.round!);
      if (r?.bonus?.status === "claimed") this.markBonusDelivered(r);
    }
    t.status = "done";
    t.doneAt = this.now();
    this.log(`operator task ${id} done`);
    return { ok: true };
  }

  /* ---------------- public data ---------------- */

  publicRound(r: InternalRound): RoundRecord & { donationsZats: number } {
    const { carried, fresh, bonusTo, ...pub } = r;
    return pub;
  }

  publicState() {
    const open = this.openRound();
    const floor = this.state.lastFloorZats;
    const preview = potSplit(open.feeBaseZats, open.carriedZats, open.paymentNotes, this.p);
    const nextBonus = Math.ceil(open.round / this.p.bonusEveryRounds) * this.p.bonusEveryRounds;
    return {
      protocol: PROTOCOL,
      params: this.p,
      mode: this.state.mode,
      poolAddress: this.state.poolAddress,
      viewingKey: this.state.viewingKey,
      floorZats: floor,
      scannedHeight: this.state.scannedHeight,
      open: {
        round: open.round,
        openHeight: open.openHeight,
        closeHeight: open.closeHeight,
        potZats: open.potZats,
        tickets: open.tickets.length,
        prizeIfDrawnZats: preview.prizeZats,
        feeIfDrawnZats: preview.feeZats,
      },
      treasury: {
        address: this.state.treasury.address,
        viewingKey: this.state.treasury.viewingKey,
        balanceZats: this.state.treasury.lastBalanceZats,
        sweepTargetZats: floor && Number.isFinite(floor) ? sweepTargetZats(floor, this.p) : null,
        snarks: this.state.treasurySnarks,
        sweeps: this.state.sweeps.map(({ snarkId, priceZats, txid, manual, at }) => ({ snarkId, priceZats, txid, manual, at })),
        nextBonusRound: nextBonus,
      },
      rounds: this.state.rounds.map((r) => ({
        round: r.round,
        status: r.status,
        tickets: r.tickets.length,
        potZats: r.potZats,
        winner: r.winner ?? null,
        prizeZats: r.split?.prizeZats ?? null,
        bonus: r.bonus ? { snarkId: r.bonus.snarkId, status: r.bonus.status, winner: r.bonus.winner, ticketCount: r.bonus.ticketCount } : null,
      })),
    };
  }
}

export { parseLine };

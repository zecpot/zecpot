/**
 * In-memory chain, wallets and market for tests and the demo.
 * Deterministic: block hashes are sha256("mock-block-<height>").
 */
import { sha256Hex, type Payment } from "../../../../packages/core/src/index.ts";
import type { ChainAdapter, Listing, Order, OrderState, TreasuryAdapter, WalletAdapter, ZilkroadAdapter } from "./types.ts";

export interface Sent {
  to: string;
  zats: number;
  memo: string;
  txid: string;
}

const MOCK_FEE = 10_000;

/** A plain wallet: balance plus a list of what it sent. Used for the treasury. */
export class MockWallet implements TreasuryAdapter {
  balanceZats = 0;
  sent: Sent[] = [];
  constructor(
    private chain: MockChain,
    public address: string,
  ) {
    chain.wallets.set(address, this);
  }
  async balance() {
    return { spendableZats: this.balanceZats };
  }
  async send(to: string, zats: number, memo: string) {
    if (zats + MOCK_FEE > this.balanceZats) throw new Error("insufficient funds");
    this.balanceZats -= zats + MOCK_FEE;
    const txid = this.chain.newTxid("treasury");
    this.sent.push({ to, zats, memo, txid });
    this.chain.deliver(to, zats);
    this.chain.mine(1);
    return txid;
  }
}

/** The chain plus the pot's own wallet (inbox and ops folded together). */
export class MockChain implements WalletAdapter, ChainAdapter {
  tip: number;
  private received: Payment[] = [];
  private balanceZats = 0;
  sent: Sent[] = [];
  wallets = new Map<string, MockWallet>();
  private n = 0;

  constructor(startHeight = 3_100_000) {
    this.tip = startHeight;
  }

  newTxid(tag: string) {
    return sha256Hex(`mock-${tag}-${this.n++}`);
  }

  mine(blocks = 1) {
    this.tip += blocks;
  }

  /** Credit another mock wallet if the destination is one. */
  deliver(to: string, zats: number) {
    const w = this.wallets.get(to);
    if (w) w.balanceZats += zats;
  }

  /** Simulate someone paying the pot. Mined in the next block. */
  pay(zats: number, memo: string | null): Payment {
    this.mine(1);
    const p: Payment = { txid: this.newTxid("tx"), outIndex: 0, height: this.tip, zats, memo };
    this.received.push(p);
    this.balanceZats += zats;
    return p;
  }

  async height() {
    return this.tip;
  }
  async incoming(sinceHeight: number) {
    return this.received.filter((p) => p.height > sinceHeight);
  }
  async send(to: string, zats: number, memo: string) {
    if (zats + MOCK_FEE > this.balanceZats) throw new Error("insufficient funds");
    this.balanceZats -= zats + MOCK_FEE;
    const txid = this.newTxid("send");
    this.sent.push({ to, zats, memo, txid });
    this.deliver(to, zats);
    this.mine(1);
    return txid;
  }
  async balance() {
    return { spendableZats: this.balanceZats };
  }
  async blockHash(height: number) {
    if (height > this.tip) throw new Error(`block ${height} not mined yet`);
    return sha256Hex(`mock-block-${height}`);
  }
}

export class MockZilkroad implements ZilkroadAdapter {
  book: Listing[];
  private orders = new Map<string, { order: Order; listing: Listing }>();
  held = new Set<number>();
  transfers: { snarkId: number; to: string }[] = [];
  /** Test switches. */
  loseNext = false;
  failCalls = false;

  constructor(
    private payers: { sent: Sent[] }[],
    prices = [0.384, 0.39, 0.4, 0.42, 0.45],
  ) {
    this.book = prices.map((p, i) => ({ snarkId: 2950 + i, listingId: 50_000 + i, priceZats: Math.round(p * 1e8) }));
  }

  private guard() {
    if (this.failCalls) throw new Error("zilkroad 403: forbidden");
  }
  async floorZats() {
    return this.book[0]?.priceZats ?? Infinity;
  }
  async listings(limit: number) {
    this.guard();
    return this.book.slice(0, limit);
  }
  async createOrder(listingId: number, _buyer: string) {
    this.guard();
    const listing = this.book.find((l) => l.listingId === listingId);
    if (!listing) throw new Error("this zkSNARK is not for sale");
    const id = `ord-${listingId}`;
    const order: Order = {
      id,
      code: `ZR-PAY-${listingId}`,
      depositAddress: "u1mockzilkroaddeposit",
      remainingZats: listing.priceZats,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    this.orders.set(id, { order, listing });
    return order;
  }
  async orderState(orderId: string): Promise<OrderState> {
    const o = this.orders.get(orderId);
    if (!o) return "expired";
    if (this.loseNext) {
      this.loseNext = false;
      this.book = this.book.filter((l) => l !== o.listing);
      this.orders.delete(orderId);
      return "lost";
    }
    const paid = this.payers.some((w) => w.sent.some((s) => s.memo === o.order.code && s.zats >= o.order.remainingZats));
    if (!paid) return "awaiting";
    this.book = this.book.filter((l) => l !== o.listing);
    this.held.add(o.listing.snarkId);
    return "paid";
  }
  async transfer(snarkId: number, to: string) {
    this.guard();
    if (!this.held.has(snarkId)) throw new Error("you do not hold this zkSNARK");
    this.held.delete(snarkId);
    this.transfers.push({ snarkId, to });
  }
  async sessionOk() {
    return !this.failCalls;
  }
}

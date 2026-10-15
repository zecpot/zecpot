/**
 * In-memory chain + wallet + market for tests and `npm run simulate`.
 * Deterministic: block hashes are sha256("mock-block-<height>").
 */
import { sha256Hex, type Payment } from "../../../../packages/core/src/index.ts";
import type { ChainAdapter, Listing, Order, OrderState, WalletAdapter, ZilkroadAdapter } from "./types.ts";

export class MockChain implements WalletAdapter, ChainAdapter {
  tip: number;
  private received: Payment[] = [];
  private balanceZats = 0;
  sent: { to: string; zats: number; memo: string; txid: string }[] = [];
  private n = 0;

  constructor(startHeight = 3_100_000) {
    this.tip = startHeight;
  }

  mine(blocks = 1) {
    this.tip += blocks;
  }

  /** Simulate someone paying the pool. Mined in the next block. */
  pay(zats: number, memo: string | null): Payment {
    this.mine(1);
    const p: Payment = { txid: sha256Hex(`mock-tx-${this.n++}`), outIndex: 0, height: this.tip, zats, memo };
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
    if (zats + 10_000 > this.balanceZats) throw new Error("insufficient funds");
    this.balanceZats -= zats + 10_000; // flat mock fee
    const txid = sha256Hex(`mock-send-${this.n++}`);
    this.sent.push({ to, zats, memo, txid });
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
  private book: Listing[];
  private orders = new Map<string, { order: Order; listing: Listing }>();
  held = new Set<number>();
  transfers: { snarkId: number; to: string }[] = [];
  /** Set to make the next order lose the race (for tests). */
  loseNext = false;
  private wallet: MockChain;

  constructor(wallet: MockChain, prices = [0.548, 0.55, 0.5539, 0.565, 0.6]) {
    this.wallet = wallet;
    this.book = prices.map((p, i) => ({ snarkId: 2950 + i, listingId: 50_000 + i, priceZats: Math.round(p * 1e8) }));
  }

  async floorZats() {
    return this.book[0]?.priceZats ?? Infinity;
  }
  async listings(limit: number) {
    return this.book.slice(0, limit);
  }
  async createOrder(listingId: number, _buyer: string) {
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
      // Assumed Zilkroad behaviour (to confirm): a losing payment is refunded
      // to the payer with the order code in the memo.
      const paid = this.wallet.sent.find((s) => s.memo === o.order.code);
      if (paid) this.wallet.pay(paid.zats, `refund ${o.order.code}`);
      this.orders.delete(orderId);
      return "lost";
    }
    const paid = this.wallet.sent.some((s) => s.memo === o.order.code && s.zats >= o.order.remainingZats);
    if (!paid) return "awaiting";
    this.book = this.book.filter((l) => l !== o.listing);
    this.held.add(o.listing.snarkId);
    return "paid";
  }
  async transfer(snarkId: number, to: string) {
    if (!this.held.has(snarkId)) throw new Error("you do not hold this zkSNARK");
    this.held.delete(snarkId);
    this.transfers.push({ snarkId, to });
  }
  async sessionOk() {
    return true;
  }
}

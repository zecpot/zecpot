import type { Payment } from "../../../../packages/core/src/index.ts";

/** The pot's wallets (inbox receives, ops pays). Real impl: ZingoPool. Test impl: MockChain. */
export interface WalletAdapter {
  /** Called once at the start of every engine tick (e.g. to sync once, then reuse). */
  beginTick?(): Promise<void>;
  height(): Promise<number>;
  /** Shielded payments received at heights > sinceHeight, with memos. */
  incoming(sinceHeight: number): Promise<Payment[]>;
  send(to: string, zats: number, memo: string): Promise<string>;
  balance(): Promise<{ spendableZats: number }>;
}

/** The treasury wallet: receives the 5% fees, pays for floor sweeps. Its viewing key is published. */
export interface TreasuryAdapter {
  beginTick?(): Promise<void>;
  balance(): Promise<{ spendableZats: number }>;
  send(to: string, zats: number, memo: string): Promise<string>;
}

/** Block hash lookup for the draw seed (explorer display hex, lowercase). */
export interface ChainAdapter {
  blockHash(height: number): Promise<string>;
}

export interface Listing {
  snarkId: number;
  listingId: number;
  priceZats: number;
}

export interface Order {
  id: string;
  code: string; // memo to send with the payment
  depositAddress: string;
  remainingZats: number;
  expiresAt: string;
}

export type OrderState = "awaiting" | "paid" | "lost" | "expired";

/** Zilkroad market. Real impl: HTTP with the operator's session cookie. */
export interface ZilkroadAdapter {
  floorZats(): Promise<number>;
  /** Cheapest purchasable listings, ascending by price. */
  listings(limit: number): Promise<Listing[]>;
  createOrder(listingId: number, buyerAddress: string): Promise<Order>;
  orderState(orderId: string): Promise<OrderState>;
  transfer(snarkId: number, toAccountId: string): Promise<void>;
  /** True if the operator session is valid and can trade/transfer. */
  sessionOk(): Promise<boolean>;
  /** Name, traits and picture of one zkSNARK, for the raffle card. Public data. */
  snarkInfo?(snarkId: number): Promise<SnarkInfo>;
}

export interface SnarkInfo {
  name: string;
  traits: { trait: string; value: string }[];
  image?: { bytes: Uint8Array; type: string };
}

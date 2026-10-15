/**
 * Zilkroad over HTTP, using the operator's browser session cookie.
 *
 * UNOFFICIAL: endpoints were read from zilkroad.com's front-end on 2026-10-15
 * (SPEC.md §7). Sign-in requires a Cloudflare Turnstile CAPTCHA, which we do
 * NOT automate — the operator signs in by hand and sets ZILKROAD_COOKIE.
 * Ask @zilkroad_ for an API token before relying on this.
 */
import { zecToZats } from "../../../../packages/core/src/index.ts";
import type { Listing, Order, OrderState, ZilkroadAdapter } from "./types.ts";

interface TokenRow {
  id: number;
  ask: string | null;
  listed: boolean;
  listingId: number | null;
  buying: boolean;
  purged: boolean;
  apparition: unknown;
}

export class HttpZilkroad implements ZilkroadAdapter {
  constructor(
    private cookie: string,
    private base = "https://zilkroad.com/api",
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`zilkroad ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async floorZats() {
    const s = await this.req<{ floorZec: string }>("GET", "/market/stats");
    return zecToZats(s.floorZec);
  }

  async listings(limit: number): Promise<Listing[]> {
    const d = await this.req<{ tokens: TokenRow[] }>("GET", "/market/tokens");
    return d.tokens
      .filter((t) => t.listed && t.ask != null && t.listingId != null && !t.buying && !t.purged && t.apparition == null)
      .map((t) => ({ snarkId: t.id, listingId: t.listingId!, priceZats: zecToZats(t.ask!) }))
      .sort((a, b) => a.priceZats - b.priceZats)
      .slice(0, limit);
  }

  async createOrder(listingId: number, buyerAddress: string): Promise<Order> {
    // TODO(day 3): confirm response shape against a real order.
    const r = await this.req<{ order: { id: string | number; code: string; depositAddress: string; remainingZec: string; expiresAt: string } }>(
      "POST",
      "/market/orders",
      { listingId, buyerAddress },
    );
    const o = r.order;
    return {
      id: String(o.id),
      code: o.code,
      depositAddress: o.depositAddress,
      remainingZats: zecToZats(o.remainingZec),
      expiresAt: o.expiresAt,
    };
  }

  async orderState(orderId: string): Promise<OrderState> {
    // TODO(day 3): map real status strings. Current guess is defensive.
    const r = await this.req<{ order?: { status?: string; state?: string } }>("GET", `/market/orders/${orderId}`);
    const s = String(r.order?.status ?? r.order?.state ?? "").toLowerCase();
    if (/paid|settled|complete|filled/.test(s)) return "paid";
    if (/expire/.test(s)) return "expired";
    if (/lost|cancel|sold|taken/.test(s)) return "lost";
    return "awaiting";
  }

  async transfer(snarkId: number, toAccountId: string) {
    await this.req("POST", "/market/transfers", { snarkId, toAccountId });
  }

  async sessionOk() {
    try {
      const me = await this.req<{ accountId: string | null; canTrade: boolean; canTransfer: boolean }>("GET", "/me");
      return !!me.accountId && me.canTrade && me.canTransfer;
    } catch {
      return false;
    }
  }
}

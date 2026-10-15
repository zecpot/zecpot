/**
 * NEAR Intents 1Click, called straight from the browser (CORS is open).
 * The SNARKPOT server never sees a swap: not the user's EVM/Solana address,
 * not the Zcash address they receive at.
 *
 * Unauthenticated use costs an extra 0.25% (docs: 1Click authentication).
 * A partner key would have to live on a server, which would then see swaps,
 * so we stay unauthenticated on purpose.
 */
export const ONECLICK = "https://1click.chaindefuser.com";
export const ZEC_ASSET = "nep141:zec.omft.near";

export type ChainKind = "evm" | "sol";

export interface SourceAsset {
  key: string;
  label: string;
  symbol: string;
  chainName: string;
  kind: ChainKind;
  assetId: string;
  contract: string;
  decimals: number;
  /** EVM chain id (hex) for wallet_switchEthereumChain. */
  chainIdHex?: string;
  explorerTx: string;
}

/** Asset ids and contracts as listed by GET /v0/tokens on 2026-10-15. */
export const SOURCES: SourceAsset[] = [
  {
    key: "usdc-sol", label: "USDC on Solana", symbol: "USDC", chainName: "Solana", kind: "sol",
    assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6,
    explorerTx: "https://solscan.io/tx/",
  },
  {
    key: "usdc-arb", label: "USDC on Arbitrum", symbol: "USDC", chainName: "Arbitrum", kind: "evm",
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6, chainIdHex: "0xa4b1",
    explorerTx: "https://arbiscan.io/tx/",
  },
  {
    key: "usdc-base", label: "USDC on Base", symbol: "USDC", chainName: "Base", kind: "evm",
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, chainIdHex: "0x2105",
    explorerTx: "https://basescan.org/tx/",
  },
  {
    key: "usdc-eth", label: "USDC on Ethereum", symbol: "USDC", chainName: "Ethereum", kind: "evm",
    assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, chainIdHex: "0x1",
    explorerTx: "https://etherscan.io/tx/",
  },
  {
    key: "usdt-eth", label: "USDT on Ethereum", symbol: "USDT", chainName: "Ethereum", kind: "evm",
    assetId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
    contract: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6, chainIdHex: "0x1",
    explorerTx: "https://etherscan.io/tx/",
  },
];

export interface Quote {
  depositAddress: string;
  depositMemo?: string;
  amountIn: string; // smallest units of the source token
  amountInFormatted: string;
  amountOutFormatted: string;
  minAmountOut: string; // zats
  timeEstimate: number; // seconds
  deadline: string;
}

export type SwapStatus = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";

export interface QuoteInput {
  source: SourceAsset;
  zecZats: number;
  recipient: string; // the user's own shielded Zcash address
  refundTo: string; // the user's own address on the source chain
  dry?: boolean;
}

/** Request body for an exact-output quote: the user receives exactly zecZats. */
export function quoteRequest(q: QuoteInput, now = Date.now()) {
  return {
    dry: q.dry ?? false,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: q.source.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: ZEC_ASSET,
    amount: String(q.zecZats), // ZEC has 8 decimals, so zats are the smallest unit
    refundTo: q.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: q.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now + 30 * 60_000).toISOString(),
  };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(ONECLICK + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = (json as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
    throw new Error(msg === "Quoting for this pair is not available" ? "This network isn’t available for ZEC right now. Pick another one." : msg);
  }
  return json as T;
}

export async function getQuote(q: QuoteInput): Promise<Quote> {
  const r = await call<{ quote: Quote }>("POST", "/v0/quote", quoteRequest(q));
  return r.quote;
}

/** Optional: tells 1Click about the deposit so it starts sooner. */
export async function submitDeposit(txHash: string, depositAddress: string): Promise<void> {
  try {
    await call("POST", "/v0/deposit/submit", { txHash, depositAddress });
  } catch {
    /* 1Click also detects deposits on its own */
  }
}

export async function getStatus(depositAddress: string): Promise<{ status: SwapStatus; destTx?: string }> {
  const r = await call<{ status: SwapStatus; swapDetails?: { destinationChainTxHashes?: { hash: string }[] } }>(
    "GET",
    `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
  );
  return { status: r.status, destTx: r.swapDetails?.destinationChainTxHashes?.[0]?.hash };
}

/** Smallest units → decimal string, no float rounding. */
export function formatUnits(v: string | bigint, decimals: number): string {
  const s = BigInt(v).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

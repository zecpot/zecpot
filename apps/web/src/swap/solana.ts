/**
 * Solana with no web3.js: Wallet Standard discovery (Phantom, Solflare,
 * Backpack…), associated-token-account derivation, and a hand-serialised
 * legacy transaction that (1) creates the deposit address's USDC account if
 * missing and (2) does a TransferChecked. Tested byte-for-byte against
 * @solana/web3.js + @solana/spl-token in apps/web/test/solana.test.ts.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { base58 } from "@scure/base";

export const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function pubkey(s: string): Uint8Array {
  const b = base58.decode(s);
  if (b.length !== 32) throw new Error(`not a Solana address: ${s}`);
  return b;
}

function isOnCurve(b: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(b);
    return true;
  } catch {
    return false;
  }
}

export function findProgramAddress(seeds: Uint8Array[], programId: string): [string, number] {
  const pid = pubkey(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concat(...seeds, Uint8Array.of(bump), pid, enc.encode("ProgramDerivedAddress")));
    if (!isOnCurve(h)) return [base58.encode(h), bump];
  }
  throw new Error("no viable bump");
}

export function associatedTokenAddress(owner: string, mint: string): string {
  return findProgramAddress([pubkey(owner), pubkey(TOKEN_PROGRAM), pubkey(mint)], ATA_PROGRAM)[0];
}

function compactU16(n: number): Uint8Array {
  const out: number[] = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n === 0) {
      out.push(b);
      return Uint8Array.from(out);
    }
    out.push(b | 0x80);
  }
}

interface Meta { key: string; signer: boolean; writable: boolean }
interface Ix { program: string; accounts: Meta[]; data: Uint8Array }

/** Legacy message compile: payer first, then signer-writable, signer-readonly, writable, readonly. */
function compile(payer: string, ixs: Ix[], blockhash: string): Uint8Array {
  const metas = new Map<string, { signer: boolean; writable: boolean }>();
  const touch = (k: string, signer: boolean, writable: boolean) => {
    const m = metas.get(k) ?? { signer: false, writable: false };
    metas.set(k, { signer: m.signer || signer, writable: m.writable || writable });
  };
  touch(payer, true, true);
  for (const ix of ixs) {
    touch(ix.program, false, false);
    for (const a of ix.accounts) touch(a.key, a.signer, a.writable);
  }
  const entries = [...metas.entries()];
  const group = (s: boolean, w: boolean) => entries.filter(([k, m]) => k !== payer && m.signer === s && m.writable === w).map(([k]) => k);
  const keys = [payer, ...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  const numSigners = 1 + group(true, true).length + group(true, false).length;
  const header = Uint8Array.of(numSigners, group(true, false).length, group(false, false).length);
  const idx = (k: string) => keys.indexOf(k);
  const ixBytes = ixs.map((ix) =>
    concat(
      Uint8Array.of(idx(ix.program)),
      compactU16(ix.accounts.length),
      Uint8Array.from(ix.accounts.map((a) => idx(a.key))),
      compactU16(ix.data.length),
      ix.data,
    ),
  );
  return concat(header, compactU16(keys.length), ...keys.map(pubkey), pubkey(blockhash), compactU16(ixs.length), ...ixBytes);
}

/** Unsigned legacy transaction: create-ATA-idempotent + TransferChecked. */
export function buildSplTransfer(o: { from: string; to: string; mint: string; amount: bigint; decimals: number; blockhash: string }): Uint8Array {
  const srcAta = associatedTokenAddress(o.from, o.mint);
  const dstAta = associatedTokenAddress(o.to, o.mint);
  const amountLe = new Uint8Array(8);
  new DataView(amountLe.buffer).setBigUint64(0, o.amount, true);
  const createAta: Ix = {
    program: ATA_PROGRAM,
    accounts: [
      { key: o.from, signer: true, writable: true },
      { key: dstAta, signer: false, writable: true },
      { key: o.to, signer: false, writable: false },
      { key: o.mint, signer: false, writable: false },
      { key: SYSTEM_PROGRAM, signer: false, writable: false },
      { key: TOKEN_PROGRAM, signer: false, writable: false },
    ],
    data: Uint8Array.of(1), // CreateIdempotent
  };
  const transferChecked: Ix = {
    program: TOKEN_PROGRAM,
    accounts: [
      { key: srcAta, signer: false, writable: true },
      { key: o.mint, signer: false, writable: false },
      { key: dstAta, signer: false, writable: true },
      { key: o.from, signer: true, writable: false },
    ],
    data: concat(Uint8Array.of(12), amountLe, Uint8Array.of(o.decimals)), // TransferChecked
  };
  const message = compile(o.from, [createAta, transferChecked], o.blockhash);
  return concat(compactU16(1), new Uint8Array(64), message);
}

export async function latestBlockhash(rpc = SOLANA_RPC): Promise<string> {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "finalized" }] }),
  });
  const j = (await r.json()) as { result?: { value?: { blockhash?: string } }; error?: { message: string } };
  const bh = j.result?.value?.blockhash;
  if (!bh) throw new Error(`Solana RPC: ${j.error?.message ?? "no blockhash"}`);
  return bh;
}

/* ---------------- Wallet Standard ---------------- */

interface StdAccount { address: string; chains: readonly string[] }
export interface StdWallet {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly StdAccount[];
  features: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function discoverSolanaWallets(waitMs = 250): Promise<StdWallet[]> {
  return new Promise((resolve) => {
    const wallets: StdWallet[] = [];
    const api = {
      register: (...ws: StdWallet[]) => {
        wallets.push(...ws);
        return () => {};
      },
    };
    const onRegister = (e: Event) => (e as CustomEvent<(a: typeof api) => void>).detail?.(api);
    window.addEventListener("wallet-standard:register-wallet", onRegister);
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
    setTimeout(() => {
      window.removeEventListener("wallet-standard:register-wallet", onRegister);
      const seen = new Set<string>();
      resolve(
        wallets.filter((w) => {
          const ok = w.chains?.includes("solana:mainnet") && w.features?.["solana:signAndSendTransaction"] && w.features?.["standard:connect"];
          if (!ok || seen.has(w.name)) return false;
          seen.add(w.name);
          return true;
        }),
      );
    }, waitMs);
  });
}

export async function connectSolana(w: StdWallet): Promise<StdAccount> {
  const { accounts } = await w.features["standard:connect"].connect();
  const acct = (accounts as StdAccount[]).find((a) => a.chains?.includes("solana:mainnet")) ?? accounts[0];
  if (!acct) throw new Error("The wallet didn’t share an account");
  return acct;
}

export async function sendSpl(w: StdWallet, account: StdAccount, o: { to: string; mint: string; amount: bigint; decimals: number }): Promise<string> {
  const tx = buildSplTransfer({ from: account.address, ...o, blockhash: await latestBlockhash() });
  const [res] = await w.features["solana:signAndSendTransaction"].signAndSendTransaction({ account, chain: "solana:mainnet", transaction: tx });
  return base58.encode(res.signature);
}

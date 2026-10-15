/**
 * The live pool: two zingo-cli wallets and a lightwalletd block source.
 *
 *   INBOX  — receives ticket payments. Its unified FULL viewing key is
 *            published, so anyone can load it into a view-only wallet and see
 *            every ticket (amount + memo, never the sender). Its only outgoing
 *            transactions are sweeps to OPS.
 *   OPS    — private. Pays Zilkroad and withdrawals.
 *
 * Why two: zingolib always sends with OvkPolicy::Sender, so a single wallet's
 * published UFVK would expose withdrawal destinations; and zingo-cli cannot
 * import an incoming-only key (UIVK). Keeping all sends in a private wallet
 * avoids both. (SPEC §5)
 *
 * zingo-cli is driven one command per process (built from zingolib, Oct 2026):
 *   zingo-cli --data-dir D --server S [--waitsync | --nosync] <command> [args]
 * JSON goes to stdout; sync reports and notices go to stderr.
 *
 * Ironwood (NU6.3, mainnet 2026-07-28): a UA's Orchard receiver *is* its
 * Ironwood receiver; payments to it land as Ironwood notes.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Payment } from "../../../../packages/core/src/index.ts";
import type { ChainAdapter, WalletAdapter } from "./types.ts";

const run = promisify(execFile);

/* ---------------- zingo-cli runner ---------------- */

export interface ZingoConfig {
  bin: string;
  dataDir: string;
  server: string; // e.g. https://zec.rocks:443
}

export type Exec = (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: Exec = (bin, args) => run(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 });

/** Extracts the JSON document a one-shot command printed (stdout may carry a line of text first). */
export function extractJson(stdout: string): unknown {
  const i = stdout.search(/[{[]/);
  if (i < 0) throw new Error(`no JSON in zingo-cli output: ${stdout.slice(0, 200)}`);
  return JSON.parse(stdout.slice(i));
}

export class ZingoCli {
  constructor(
    private cfg: ZingoConfig,
    private exec: Exec = defaultExec,
  ) {}

  async json<T>(command: string[], opts: { sync: boolean }): Promise<T> {
    const args = ["--data-dir", this.cfg.dataDir, "--server", this.cfg.server, opts.sync ? "--waitsync" : "--nosync", ...command];
    let out: { stdout: string; stderr: string };
    try {
      out = await this.exec(this.cfg.bin, args);
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      throw new Error(`zingo-cli ${command[0]} failed: ${(err.stderr || err.message).trim().split("\n").slice(-3).join(" | ")}`);
    }
    try {
      return extractJson(out.stdout) as T;
    } catch {
      throw new Error(`zingo-cli ${command[0]}: ${(out.stderr || out.stdout).trim().split("\n").slice(-3).join(" | ")}`);
    }
  }
}

/* ---------------- parsing ---------------- */

interface NoteJson {
  value: number;
  status: string; // "confirmed at block height 3456789"
  spend_status: string;
  memo: string | null;
  txid: string;
  output_index: number;
  scope: string; // "external" | "internal"
}
export interface NotesJson {
  ironwood_notes?: NoteJson[];
  orchard_notes?: NoteJson[];
  sapling_notes?: NoteJson[];
}

/** Orchard notes (pre-NU6.3 only) get an offset so they can't collide with an Ironwood output index in the same tx. */
export const ORCHARD_INDEX_OFFSET = 10_000;

/**
 * Received, confirmed, externally-addressed notes → payments. Internal-scope
 * notes are the wallet's own change and are never tickets. `notes all` is used
 * so that notes already swept to OPS still count.
 */
export function paymentsFromNotes(n: NotesJson): Payment[] {
  const out: Payment[] = [];
  const take = (notes: NoteJson[] | undefined, offset: number) => {
    for (const x of notes ?? []) {
      if (x.scope !== "external") continue;
      const m = /^confirmed at block height (\d+)$/.exec(x.status);
      if (!m) continue; // mempool / transmitted: wait for confirmation
      out.push({ txid: x.txid, outIndex: x.output_index + offset, height: Number(m[1]), zats: x.value, memo: x.memo ?? null });
    }
  };
  take(n.ironwood_notes, 0);
  take(n.orchard_notes, ORCHARD_INDEX_OFFSET);
  return out.sort((a, b) => a.height - b.height || (a.txid < b.txid ? -1 : 1) || a.outIndex - b.outIndex);
}

/* ---------------- the pool ---------------- */

/** Below this, sweeping costs more than it moves. */
const SWEEP_MIN_ZATS = 100_000;
/** Room for the ZIP-317 fee on top of a payment (a spend of many 0.1 ZEC notes can need several actions). */
const SEND_FEE_HEADROOM_ZATS = 100_000;

export class ZingoPool implements WalletAdapter {
  private synced = { inbox: false, ops: false };

  constructor(
    private inbox: ZingoCli,
    private ops: ZingoCli,
    private opsAddress: string,
  ) {}

  /** Sync both wallets once per tick; later calls in the same tick use --nosync. */
  async beginTick() {
    this.synced = { inbox: false, ops: false };
  }
  private async cli(which: "inbox" | "ops", command: string[]) {
    const sync = !this.synced[which];
    const res = await (which === "inbox" ? this.inbox : this.ops).json<unknown>(command, { sync });
    this.synced[which] = true;
    return res;
  }

  async height(): Promise<number> {
    const r = (await this.cli("inbox", ["height"])) as { height: number };
    if (!r.height) throw new Error("zingo-cli reported height 0 — not synced");
    return r.height;
  }

  async incoming(sinceHeight: number): Promise<Payment[]> {
    const notes = (await this.cli("inbox", ["notes", "all"])) as NotesJson;
    return paymentsFromNotes(notes).filter((p) => p.height > sinceHeight);
  }

  /** Moves everything spendable in INBOX to OPS. Visible to UFVK holders, by design. */
  async sweep(): Promise<string | null> {
    const { max_send_value } = (await this.cli("inbox", ["max_send_value", this.opsAddress])) as { max_send_value: number };
    if (!max_send_value || max_send_value < SWEEP_MIN_ZATS) return null;
    const r = (await this.cli("inbox", ["quicksend", this.opsAddress, String(max_send_value), "SNARKPOT1 sweep"])) as { txids: string[] };
    return r.txids[0] ?? null;
  }

  async balance(): Promise<{ spendableZats: number }> {
    await this.sweep();
    const r = (await this.cli("ops", ["spendable_balance"])) as { spendable_balance: number };
    return { spendableZats: r.spendable_balance };
  }

  async send(to: string, zats: number, memo: string): Promise<string> {
    const { spendable_balance } = (await this.cli("ops", ["spendable_balance"])) as { spendable_balance: number };
    if (spendable_balance < zats + SEND_FEE_HEADROOM_ZATS) {
      // Top OPS up from INBOX; swept notes need confirmations, so the engine retries next tick.
      const txid = await this.sweep();
      throw new Error(txid ? `swept inbox → ops (${txid.slice(0, 12)}…); waiting for it to confirm` : "not enough spendable funds in ops or inbox yet");
    }
    const r = (await this.cli("ops", ["quicksend", to, String(zats), memo])) as { txids: string[] };
    if (!r.txids?.[0]) throw new Error("zingo-cli quicksend returned no txid");
    return r.txids[0];
  }
}

/* ---------------- block hashes from lightwalletd ---------------- */

/** CompactBlock.hash is in internal byte order; explorers show it reversed. */
export function displayHash(internal: Uint8Array): string {
  return Buffer.from(internal).reverse().toString("hex");
}

export class LightwalletdChain implements ChainAdapter {
  private client: Promise<{ GetBlock: (req: { height: number }, cb: (e: Error | null, r: { hash: Buffer; height: string }) => void) => void }>;

  constructor(server: string) {
    this.client = (async () => {
      const grpc = await import("@grpc/grpc-js");
      const loader = await import("@grpc/proto-loader");
      const here = dirname(fileURLToPath(import.meta.url));
      const def = await loader.load(join(here, "../../proto/lightwalletd.proto"), { longs: String, defaults: true });
      const pkg = grpc.loadPackageDefinition(def) as unknown as {
        cash: { z: { wallet: { sdk: { rpc: { CompactTxStreamer: new (host: string, creds: unknown) => never } } } } };
      };
      const url = new URL(server);
      const creds = url.protocol === "https:" ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
      return new pkg.cash.z.wallet.sdk.rpc.CompactTxStreamer(`${url.hostname}:${url.port || 443}`, creds);
    })();
  }

  async blockHash(height: number): Promise<string> {
    const c = await this.client;
    const block = await new Promise<{ hash: Buffer; height: string }>((ok, fail) => c.GetBlock({ height }, (e, r) => (e ? fail(e) : ok(r))));
    if (Number(block.height) !== height || block.hash.length !== 32) throw new Error(`lightwalletd returned a bad block for ${height}`);
    return displayHash(block.hash);
  }
}

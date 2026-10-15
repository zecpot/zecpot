/**
 * Pool wallet via zingo-cli (zingolib), one command per call:
 *   zingo-cli --data-dir <dir> --server <url> --waitsync <command> [args]
 *
 * STATUS: skeleton. Day-2 task (SPEC.md §9): build zingo-cli, run
 * `zingo-cli help`, and fill in the command names + output parsing below.
 * Everything else in the engine only sees WalletAdapter, so if zingo-cli is
 * awkward, swap this file for a Rust sidecar on zcash_client_backend.
 *
 * Chain lookups (block hash for the draw seed) go through lightwalletd's
 * GetBlock — or any explorer — behind ChainAdapter.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Payment } from "../../../../packages/core/src/index.ts";
import type { ChainAdapter, WalletAdapter } from "./types.ts";

const run = promisify(execFile);

export interface ZingoConfig {
  bin: string; // path to zingo-cli
  dataDir: string;
  server: string; // e.g. https://zec.rocks:443
}

export class ZingoWallet implements WalletAdapter {
  constructor(private cfg: ZingoConfig) {}

  private async cli(...args: string[]): Promise<string> {
    const { stdout } = await run(
      this.cfg.bin,
      ["--data-dir", this.cfg.dataDir, "--server", this.cfg.server, "--waitsync", ...args],
      { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 },
    );
    return stdout;
  }

  async height(): Promise<number> {
    // TODO: confirm command (e.g. `height`) and parse.
    const out = await this.cli("height");
    const m = /(\d{6,})/.exec(out);
    if (!m) throw new Error(`could not parse height from: ${out.slice(0, 200)}`);
    return Number(m[1]);
  }

  async incoming(_sinceHeight: number): Promise<Payment[]> {
    // TODO: use the value-transfer / messages listing; keep only received
    // Orchard notes; map to {txid, outIndex, height, zats, memo}.
    throw new Error("ZingoWallet.incoming not implemented yet — see SPEC.md §8");
  }

  async send(_to: string, _zats: number, _memo: string): Promise<string> {
    // TODO: `send` / `quicksend` with memo; return txid.
    throw new Error("ZingoWallet.send not implemented yet — see SPEC.md §8");
  }

  async balance(): Promise<{ spendableZats: number }> {
    // TODO: parse spendable Orchard balance.
    throw new Error("ZingoWallet.balance not implemented yet — see SPEC.md §8");
  }
}

export class ExplorerChain implements ChainAdapter {
  async blockHash(_height: number): Promise<string> {
    // TODO: lightwalletd GetBlock(height).hash (reverse bytes to display order),
    // or a public explorer API. Must return lowercase display-order hex.
    throw new Error("ExplorerChain.blockHash not implemented yet");
  }
}

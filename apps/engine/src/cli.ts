/**
 *   npm run dev                  site + engine on a mock chain (demo buttons enabled)
 *   npm run simulate             scripted end-to-end run on the mock chain
 *   npm run serve                live (ZECPOT_MODE=live): site + API + a tick every 60 s
 *   npm run tick                 one live tick, then exit (don't run while serve is running)
 *   npm run op -- tasks          list operator to-dos (manual Zilkroad buys / transfers)
 *   npm run op -- done <n> [zkSNARK #] [txid]   mark a to-do done
 *   npm run blockhash -- <h>     print a block hash from lightwalletd (compare with an explorer)
 *   npm run verify -- <n|file>   re-check a published round
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PARAMS,
  newTicketKey,
  parseLine,
  signBonusClaim,
  signClaim,
  ticketMemo,
  verifyBonus,
  verifyRound,
  zatsToZec,
  type Params,
  type RoundRecord,
} from "../../../packages/core/src/index.ts";
import { MockChain, MockWallet, MockZilkroad } from "./adapters/mock.ts";
import { HttpZilkroad } from "./adapters/zilkroad-http.ts";
import { LightwalletdChain, ZingoCli, ZingoPool, ZingoTreasury } from "./adapters/zingo.ts";
import { Engine, initialState, migrateState } from "./engine.ts";
import { startServer, type Handler } from "./server.ts";
import { loadState, publish, saveState } from "./store.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const VAR = process.env.ZECPOT_VAR ?? process.env.SNARKPOT_VAR ?? join(ROOT, "var");
const DATA = join(VAR, "data");
const STATE = join(VAR, "state.json");
const WEB = join(ROOT, "apps/web/public");
const PORT = Number(process.env.PORT ?? 8787);

/** Short rounds, a bonus every 3 rounds and cheap listings so the mock demo moves at human speed. */
const MOCK_PARAMS: Params = { ...DEFAULT_PARAMS, roundBlocks: 30, seedDelay: 3, reorgSafety: 2, claimWindowBlocks: 200, bonusEveryRounds: 3 };
const MOCK_TREASURY = "u1mocktreasury";

function mockEngine() {
  const chain = new MockChain();
  const treasury = new MockWallet(chain, MOCK_TREASURY);
  const market = new MockZilkroad([chain, treasury], [0.02, 0.025, 0.03, 0.04, 0.05]);
  const state = initialState({
    startHeight: chain.tip,
    poolAddress: "u1mockpoolorchardonlyaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    viewingKey: "uview1mock-the-inbox-wallet-ufvk-goes-here",
    treasuryAddress: MOCK_TREASURY,
    treasuryViewingKey: "uview1mock-the-treasury-wallet-ufvk-goes-here",
    zilkroadAddress: "u1mockops",
    mode: "mock",
    params: MOCK_PARAMS,
  });
  return { chain, treasury, market, engine: new Engine(state, { wallet: chain, treasury, chain, market }) };
}

const SHIELDED_DEMO = "u1" + "q".repeat(110);

async function simulate() {
  const { chain, treasury, market, engine } = mockEngine();
  const P = MOCK_PARAMS;
  const say = (s: string) => console.log(s);
  const settle = async () => {
    chain.mine(P.roundBlocks);
    await engine.tick();
    chain.mine(P.seedDelay + P.reorgSafety);
    await engine.tick();
    await engine.tick();
  };
  const winnerOf = (n: number, keys: { pk: string; code: string }[]) => {
    const r = engine.round(n)!;
    return keys.find((k) => k.pk === parseLine(r.tickets[r.winner!]!).pk)!;
  };
  let ok = true;
  const allKeys: { pk: string; code: string }[] = [];

  for (let n = 1; n <= 3; n++) {
    if (n === 2) {
      treasury.balanceZats += 2_000_000;
      say("  (a sponsor tops up the treasury so the demo can show a sweep)");
    }
    const keys = Array.from({ length: 4 }, () => newTicketKey());
    allKeys.push(...keys);
    keys.forEach((k, i) => chain.pay((i + 1) * P.ticketZats, ticketMemo(k.pk))); // 1+2+3+4 = 10 tickets
    await settle();
    const r = engine.round(n)!;
    say(`Round ${n}: ${r.tickets.length} tickets, pot ${zatsToZec(r.potZats)} ZEC → ticket ${r.winner} wins ${zatsToZec(r.split!.prizeZats)} ZEC, fee ${zatsToZec(r.split!.feeZats)} ZEC`);
    const w = winnerOf(n, keys);
    const claim = engine.submitClaim(n, r.winner!, SHIELDED_DEMO, signClaim(w.code, n, r.winner!, SHIELDED_DEMO, r.split!.prizeZats));
    await engine.tick();
    say(`  claimed: ${claim.ok}; paid: ${engine.round(n)!.status === "paid"}; treasury now ${zatsToZec(treasury.balanceZats)} ZEC; zkSNARKs held ${JSON.stringify(engine.state.treasurySnarks)}`);
    if (r.bonus) {
      const lines = r.bonus.rounds.flatMap((x) => engine.round(x)!.tickets);
      const bk = allKeys.find((k) => k.pk === parseLine(lines[r.bonus!.winner]!).pk)!;
      const acct = "ZR-7K4Q-M2XD";
      const bc = engine.submitBonusClaim(n, r.bonus.winner, acct, signBonusClaim(bk.code, n, r.bonus.winner, acct, r.bonus.snarkId));
      await engine.tick();
      say(`  weekly bonus: zkSNARK #${r.bonus.snarkId} → ticket ${r.bonus.winner} of ${lines.length}; claimed ${bc.ok}; ${r.bonus.status}; transfers ${JSON.stringify(market.transfers)}`);
      ok &&= bc.ok && r.bonus.status === "delivered";
    }
    ok &&= claim.ok && engine.round(n)!.status === "paid";
  }

  say("Zilkroad goes down: the next sweep becomes an operator to-do instead of failing");
  market.failCalls = true;
  treasury.balanceZats += 2_000_000;
  for (let i = 0; i < 4; i++) chain.pay(5 * P.ticketZats, ticketMemo(newTicketKey().pk));
  await settle();
  const tasks = engine.openTasks();
  say(`  open tasks: ${tasks.map((t) => `#${t.id} ${t.kind}: ${t.detail.slice(0, 70)}...`).join(" | ") || "none"}`);
  ok &&= tasks.some((t) => t.kind === "buy");

  await publish(DATA, engine);
  for (let n = 1; n <= 3; n++) {
    const pub = JSON.parse(await readFile(join(DATA, "rounds", `${n}.json`), "utf8")) as RoundRecord;
    const v = verifyRound(pub);
    if (pub.bonus) {
      const byRound: Record<number, string[]> = {};
      for (const x of pub.bonus.rounds) byRound[x] = (JSON.parse(await readFile(join(DATA, "rounds", `${x}.json`), "utf8")) as RoundRecord).tickets;
      const vb = verifyBonus(pub, byRound);
      v.checks.push(...vb.checks);
      v.ok &&= vb.ok;
    }
    say(`  verify rounds/${n}.json: ${v.ok ? "PASS" : "FAIL"} (${v.checks.map((c) => c.name).join(", ")})`);
    ok &&= v.ok;
  }
  say(`Public data written to ${DATA}`);
  if (!ok) process.exit(1);
}

/** API routes shared by the mock and live servers. `apply` runs a state change and republishes. */
function apiRoutes(engine: Engine, apply: <T extends { ok: boolean }>(fn: () => T) => Promise<{ status: number; json: unknown }>, operatorToken: string) {
  const routes: Record<string, Handler> = {
    "/api/claim": async (b) => {
      const { round, ticket, to, sig } = b as Record<string, string>;
      return apply(() => engine.submitClaim(Number(round), Number(ticket), String(to), String(sig)));
    },
    "/api/bonus-claim": async (b) => {
      const { round, ticket, to, sig } = b as Record<string, string>;
      return apply(() => engine.submitBonusClaim(Number(round), Number(ticket), String(to), String(sig)));
    },
    "/api/withdraw": async (b) => {
      const { round, pk, to, sig } = b as Record<string, string>;
      return apply(() => engine.submitWithdraw(Number(round), String(pk), String(to), String(sig)));
    },
    "/api/operator": async (b) => {
      const { token, action, id, snarkId, txid } = b as Record<string, string>;
      if (!operatorToken || token !== operatorToken) return { status: 403, json: { ok: false, error: "bad operator token" } };
      if (action === "tasks") return { status: 200, json: { ok: true, tasks: engine.openTasks() } };
      if (action === "done") return apply(() => engine.completeTask(Number(id), { snarkId: snarkId ? Number(snarkId) : undefined, txid: txid || undefined }));
      return { status: 400, json: { ok: false, error: "action is tasks or done" } };
    },
  };
  return routes;
}

async function serveMock() {
  const { chain, treasury, engine } = mockEngine();
  const step = async () => {
    await engine.tick();
    await publish(DATA, engine);
  };
  await step();
  const apply = async <T extends { ok: boolean }>(fn: () => T) => {
    const out = fn();
    await step();
    return { status: out.ok ? 200 : 400, json: out };
  };
  startServer({
    port: PORT,
    webDir: WEB,
    dataDir: DATA,
    post: {
      ...apiRoutes(engine, apply, "mock"),
      "/api/mock/pay": async (b) => {
        const { zats, memo } = b as { zats: number; memo: string };
        chain.pay(Number(zats), String(memo));
        await step();
        return { status: 200, json: { ok: true, height: chain.tip } };
      },
      "/api/mock/mine": async (b) => {
        chain.mine(Math.min(500, Number((b as { blocks?: number }).blocks ?? 1)));
        await step();
        await step();
        return { status: 200, json: { ok: true, height: chain.tip } };
      },
      "/api/mock/bots": async (b) => {
        const n = Math.min(50, Number((b as { n?: number }).n ?? 5));
        for (let i = 0; i < n; i++) chain.pay(MOCK_PARAMS.ticketZats * (1 + (i % 3)), ticketMemo(newTicketKey().pk));
        await step();
        return { status: 200, json: { ok: true } };
      },
      "/api/mock/treasury": async () => {
        treasury.balanceZats += 5_000_000; // a gift, so a sweep can be seen in the demo
        await step();
        return { status: 200, json: { ok: true } };
      },
    },
  });
  console.log(`zecPOT (mock chain) → http://localhost:${PORT}`);
}

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k} (see README "Going live")`);
  return v;
};
const LIGHTWALLETD = () => process.env.LIGHTWALLETD ?? "https://zec.rocks:443";

async function liveEngine() {
  const bin = env("ZINGO_BIN");
  const server = LIGHTWALLETD();
  const wallet = new ZingoPool(
    new ZingoCli({ bin, dataDir: env("INBOX_DATA_DIR"), server }),
    new ZingoCli({ bin, dataDir: env("OPS_DATA_DIR"), server }),
    env("OPS_ADDRESS"),
  );
  const treasury = new ZingoTreasury(new ZingoCli({ bin, dataDir: env("TREASURY_DATA_DIR"), server }));
  const market = new HttpZilkroad(env("ZILKROAD_COOKIE"), undefined, process.env.ZILKROAD_USER_AGENT ?? "");
  const opts = {
    poolAddress: env("POOL_ADDRESS"),
    viewingKey: env("POOL_VIEWING_KEY"),
    treasuryAddress: env("TREASURY_ADDRESS"),
    treasuryViewingKey: env("TREASURY_VIEWING_KEY"),
    zilkroadAddress: env("POOL_ZILKROAD_ADDRESS"),
  };
  const saved = (await loadState(STATE)) as unknown as ({ version?: number } & Record<string, unknown>) | null;
  let state;
  if (saved) {
    state = migrateState(saved, opts);
    if (saved.version !== 2) console.log(`Migrated saved state to zecPOT (version 2); payments are re-read from block ${state.scannedHeight}.`);
  } else {
    await wallet.beginTick();
    state = initialState({ ...opts, startHeight: await wallet.height() });
  }
  return new Engine(state, { wallet, treasury, chain: new LightwalletdChain(server), market });
}

/** Serialises ticks and API mutations so state is never changed mid-tick. */
function serial() {
  let chain = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
}

async function tickOnce(engine: Engine) {
  await engine.tick();
  await saveState(STATE, engine.state);
  await publish(DATA, engine);
}

async function tickLive() {
  const engine = await liveEngine();
  await tickOnce(engine);
  for (const l of engine.state.log.slice(-10)) console.log(l.at, l.msg);
}

/** Live: one process runs the site, the API and a tick every TICK_SECONDS (default 60). */
async function serveLive() {
  const engine = await liveEngine();
  const run = serial();
  const every = Number(process.env.TICK_SECONDS ?? 60) * 1000;
  let shown = engine.state.log.length;
  const loop = () =>
    run(() => tickOnce(engine))
      .then(() => {
        for (const l of engine.state.log.slice(shown)) console.log(l.at, l.msg);
        shown = engine.state.log.length;
      })
      .catch((e) => console.error(new Date().toISOString(), "tick failed:", (e as Error).message))
      .finally(() => setTimeout(loop, every));
  loop();
  const apply = <T extends { ok: boolean }>(fn: () => T) =>
    run(async () => {
      const out = fn();
      if (out.ok) {
        await saveState(STATE, engine.state);
        await publish(DATA, engine);
      }
      return { status: out.ok ? 200 : 400, json: out as unknown };
    });
  startServer({ port: PORT, webDir: WEB, dataDir: DATA, post: apiRoutes(engine, apply, process.env.OPERATOR_TOKEN ?? "") });
  console.log(`zecPOT (live, ${LIGHTWALLETD()}) → http://localhost:${PORT}`);
  if (!process.env.OPERATOR_TOKEN) console.log("Note: OPERATOR_TOKEN is not set, so `npm run op` is disabled.");
}

/** Talks to the running server's operator API. */
async function op(args: string[]) {
  const [action, id, snarkId, txid] = args;
  if (action !== "tasks" && action !== "done") throw new Error("usage: npm run op -- tasks | done <task> [zkSNARK #] [txid]");
  const token = process.env.OPERATOR_TOKEN ?? (process.env.ZECPOT_MODE === "live" || process.env.SNARKPOT_MODE === "live" ? "" : "mock");
  const res = await fetch(`http://127.0.0.1:${PORT}/api/operator`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, action, id, snarkId, txid }),
  });
  const out = (await res.json()) as { ok: boolean; error?: string; tasks?: { id: number; kind: string; detail: string; createdAt: string }[] };
  if (!out.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
  if (action === "tasks") {
    if (!out.tasks?.length) console.log("No open tasks.");
    for (const t of out.tasks ?? []) console.log(`#${t.id} [${t.kind}] ${t.createdAt}\n   ${t.detail}`);
  } else console.log(`Task ${id} marked done.`);
}

async function blockhash(arg?: string) {
  if (!arg || !/^\d+$/.test(arg)) throw new Error("usage: npm run blockhash -- <height>");
  console.log(await new LightwalletdChain(LIGHTWALLETD()).blockHash(Number(arg)));
  process.exit(0);
}

async function verify(arg?: string) {
  if (!arg) throw new Error("usage: npm run verify -- <round number | path/to/round.json>");
  const path = /^\d+$/.test(arg) ? join(DATA, "rounds", `${arg}.json`) : arg;
  const r = JSON.parse(await readFile(path, "utf8")) as RoundRecord;
  const v = verifyRound(r);
  const checks = [...v.checks];
  if (r.bonus) {
    const byRound: Record<number, string[]> = {};
    for (const n of r.bonus.rounds) byRound[n] = (JSON.parse(await readFile(join(dirname(path), `${n}.json`), "utf8")) as RoundRecord).tickets;
    checks.push(...verifyBonus(r, byRound).checks);
  }
  for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  const ok = checks.every((c) => c.ok);
  console.log(ok ? "PASS" : "FAIL");
  if (!ok) process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const live = process.env.ZECPOT_MODE === "live" || process.env.SNARKPOT_MODE === "live";
const cmds: Record<string, () => Promise<void>> = {
  simulate,
  serve: live ? serveLive : serveMock,
  tick: tickLive,
  op: () => op(rest),
  verify: () => verify(rest[0]),
  blockhash: () => blockhash(rest[0]),
};
(cmds[cmd ?? ""] ?? (async () => console.log("commands: serve | simulate | tick | op | verify <n> | blockhash <h>")))().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

/**
 *   npm run dev                  site + engine on a mock chain (demo buttons enabled)
 *   npm run simulate             scripted end-to-end run on the mock chain
 *   npm run serve                live (ZECPOT_MODE=live): site + API + a tick every 60 s
 *   npm run tick                 one live tick, then exit (don't run while serve is running)
 *   npm run op -- tasks          list operator to-dos (raffles to open, manual Zilkroad buys / transfers)
 *   npm run op -- raffle <zkSNARK #> [hours]    open a zkSNARK raffle (default 48 h)
 *   npm run op -- done <n> [zkSNARK #] [txid]   mark a to-do done
 *   npm run blockhash -- <h>     print a block hash from lightwalletd (compare with an explorer)
 *   npm run verify -- <n|file>   re-check a published round (verify -- raffle <n> for a raffle)
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PARAMS,
  newTicketKey,
  parseLine,
  signClaim,
  signRaffleClaim,
  ticketMemo,
  verifyRaffle,
  verifyRound,
  zatsToZec,
  type Params,
  type RaffleRecord,
  type RoundRecord,
} from "../../../packages/core/src/index.ts";
import { MockChain, MockWallet, MockZilkroad } from "./adapters/mock.ts";
import { HttpZilkroad } from "./adapters/zilkroad-http.ts";
import { LightwalletdChain, ZingoCli, ZingoPool, ZingoTreasury } from "./adapters/zingo.ts";
import { Engine, initialState, migrateState } from "./engine.ts";
import { listening, startServer, type Handler } from "./server.ts";
import { loadState, publish, saveState } from "./store.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const VAR = process.env.ZECPOT_VAR ?? process.env.SNARKPOT_VAR ?? join(ROOT, "var");
const DATA = join(VAR, "data");
const STATE = join(VAR, "state.json");
const WEB = join(ROOT, "apps/web/public");
const PORT = Number(process.env.PORT ?? 8787);

/** Short rounds and cheap listings so the mock demo moves at human speed. */
const MOCK_PARAMS: Params = { ...DEFAULT_PARAMS, roundBlocks: 30, seedDelay: 3, reorgSafety: 2, claimWindowBlocks: 200 };
/** On the mock chain a raffle lasts this many blocks (about two pots) instead of 48 h. */
const MOCK_RAFFLE_BLOCKS = 45;
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
    if (n === 2 && engine.state.treasurySnarks.length) {
      const snarkId = engine.state.treasurySnarks[0]!;
      const opened = await engine.openRaffle(snarkId, { blocks: MOCK_RAFFLE_BLOCKS });
      say(`  operator opens raffle ${opened.raffle} for zkSNARK #${snarkId}: tickets bought until block ${opened.closeHeight} are entered`);
      ok &&= opened.ok;
    }
    ok &&= claim.ok && engine.round(n)!.status === "paid";
  }

  // the raffle window has ended by now: draw it, claim it, deliver it
  const rf = engine.state.raffles[0];
  if (rf) chain.mine(Math.max(0, rf.closeHeight - chain.tip) + P.seedDelay + P.reorgSafety);
  await engine.tick();
  await engine.tick();
  if (rf?.winner !== undefined) {
    const k = allKeys.find((x) => x.pk === parseLine(rf.tickets[rf.winner!]!).pk)!;
    const acct = "ZR-7K4Q-M2XD";
    const rc = engine.submitRaffleClaim(rf.raffle, rf.winner, acct, signRaffleClaim(k.code, rf.raffle, rf.winner, acct, rf.snarkId));
    await engine.tick();
    say(`Raffle ${rf.raffle}: zkSNARK #${rf.snarkId} → ticket ${rf.winner} of ${rf.tickets.length}; claimed ${rc.ok}; ${rf.status}; transfers ${JSON.stringify(market.transfers)}`);
    ok &&= rc.ok && rf.status === "delivered";
  } else {
    say(`Raffle: ${rf ? rf.status : "never opened"}`);
    ok = false;
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
    say(`  verify rounds/${n}.json: ${v.ok ? "PASS" : "FAIL"} (${v.checks.map((c) => c.name).join(", ")})`);
    ok &&= v.ok;
  }
  for (const r of engine.state.raffles) {
    const pub = JSON.parse(await readFile(join(DATA, "raffles", `${r.raffle}.json`), "utf8")) as RaffleRecord;
    const v = verifyRaffle(pub);
    say(`  verify raffles/${r.raffle}.json: ${v.ok ? "PASS" : "FAIL"} (${v.checks.map((c) => c.name).join(", ")})`);
    ok &&= v.ok;
  }
  say(`Public data written to ${DATA}`);
  if (!ok) process.exit(1);
}

/** API routes shared by the mock and live servers. `apply` runs a state change and republishes. */
type Apply = <T extends { ok: boolean }>(fn: () => T | Promise<T>) => Promise<{ status: number; json: unknown }>;

function apiRoutes(engine: Engine, apply: Apply, operatorToken: string) {
  const routes: Record<string, Handler> = {
    "/api/claim": async (b) => {
      const { round, ticket, to, sig } = b as Record<string, string>;
      return apply(() => engine.submitClaim(Number(round), Number(ticket), String(to), String(sig)));
    },
    "/api/raffle-claim": async (b) => {
      const { raffle, ticket, to, sig } = b as Record<string, string>;
      return apply(() => engine.submitRaffleClaim(Number(raffle), Number(ticket), String(to), String(sig)));
    },
    "/api/withdraw": async (b) => {
      const { round, pk, to, sig } = b as Record<string, string>;
      return apply(() => engine.submitWithdraw(Number(round), String(pk), String(to), String(sig)));
    },
    "/api/operator": async (b) => {
      const { token, action, id, snarkId, txid, hours } = b as Record<string, string>;
      if (!operatorToken || token !== operatorToken) return { status: 403, json: { ok: false, error: "bad operator token" } };
      if (action === "tasks") return { status: 200, json: { ok: true, tasks: engine.openTasks(), treasurySnarks: engine.state.treasurySnarks } };
      if (action === "done") return apply(() => engine.completeTask(Number(id), { snarkId: snarkId ? Number(snarkId) : undefined, txid: txid || undefined }));
      if (action === "raffle") {
        const blocks = engine.state.mode === "mock" && !hours ? MOCK_RAFFLE_BLOCKS : undefined;
        return apply(() => engine.openRaffle(Number(snarkId), { hours: hours ? Number(hours) : undefined, blocks }));
      }
      return { status: 400, json: { ok: false, error: "action is tasks, raffle or done" } };
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
  const apply: Apply = async (fn) => {
    const out = await fn();
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
      "/api/mock/raffle": async () => {
        const snarkId = engine.state.treasurySnarks[0];
        if (snarkId === undefined) return { status: 400, json: { ok: false, error: "the treasury holds no zkSNARK yet: top it up and mine a few blocks" } };
        const out = await engine.openRaffle(snarkId, { blocks: MOCK_RAFFLE_BLOCKS });
        await step();
        return { status: out.ok ? 200 : 400, json: out };
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

/**
 * Only one live engine may touch the wallets: two would pay prizes twice.
 * A lock file holds the running engine's process id; a stale one (process gone) is replaced.
 */
function takeEngineLock() {
  const path = join(VAR, "engine.lock");
  mkdirSync(VAR, { recursive: true });
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8").trim());
    let alive = false;
    try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch { /* not running */ }
    if (alive && pid !== process.pid) {
      console.error(`zecPOT is already running (process ${pid}). Stop that one first (Ctrl+C in its window, or: kill ${pid}).`);
      process.exit(1);
    }
  }
  writeFileSync(path, String(process.pid));
  const release = () => { try { if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path); } catch { /* gone */ } };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0));
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
  takeEngineLock();
  const engine = await liveEngine();
  await tickOnce(engine);
  for (const l of engine.state.log.slice(-10)) console.log(l.at, l.msg);
}

/** Live: one process runs the site, the API and a tick every TICK_SECONDS (default 60). */
async function serveLive() {
  takeEngineLock();
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
  const apply: Apply = (fn) =>
    run(async () => {
      const out = await fn();
      if (out.ok) {
        await saveState(STATE, engine.state);
        await publish(DATA, engine);
      }
      return { status: out.ok ? 200 : 400, json: out as unknown };
    });
  const server = startServer({ port: PORT, webDir: WEB, dataDir: DATA, post: apiRoutes(engine, apply, process.env.OPERATOR_TOKEN ?? "") });
  try {
    await listening(server); // bind the port before the first tick touches the wallets
  } catch (e) {
    console.error(`Port ${PORT} is busy (${(e as Error).message}). Is another zecPOT running? Find it with: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    process.exit(1);
  }
  loop();
  console.log(`zecPOT (live, ${LIGHTWALLETD()}) → http://localhost:${PORT}`);
  if (!process.env.OPERATOR_TOKEN) console.log("Note: OPERATOR_TOKEN is not set, so `npm run op` is disabled.");
}

/** Talks to the running server's operator API. */
async function op(args: string[]) {
  const [action, a1, a2, a3] = args;
  const usage = "usage: npm run op -- tasks | raffle <zkSNARK #> [hours] | done <task> [zkSNARK #] [txid]";
  if (action !== "tasks" && action !== "done" && action !== "raffle") throw new Error(usage);
  const body =
    action === "raffle"
      ? { action, snarkId: (a1 ?? "").replace(/^#/, ""), hours: a2 }
      : { action, id: a1, snarkId: a2, txid: a3 };
  if (action === "raffle" && !/^\d+$/.test(body.snarkId ?? "")) throw new Error(usage);
  const token = process.env.OPERATOR_TOKEN ?? (process.env.ZECPOT_MODE === "live" || process.env.SNARKPOT_MODE === "live" ? "" : "mock");
  const res = await fetch(`http://127.0.0.1:${PORT}/api/operator`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, ...body }),
  });
  const out = (await res.json()) as {
    ok: boolean; error?: string; raffle?: number; closeHeight?: number; treasurySnarks?: number[];
    tasks?: { id: number; kind: string; detail: string; createdAt: string }[];
  };
  if (!out.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
  if (action === "tasks") {
    if (!out.tasks?.length) console.log("No open tasks.");
    for (const t of out.tasks ?? []) console.log(`#${t.id} [${t.kind}] ${t.createdAt}\n   ${t.detail}`);
    console.log(`zkSNARKs in the treasury, ready to raffle: ${out.treasurySnarks?.map((x) => "#" + x).join(", ") || "none"}`);
  } else if (action === "raffle") {
    console.log(`Raffle ${out.raffle} is open for zkSNARK #${body.snarkId}. Tickets bought until block ${out.closeHeight?.toLocaleString("en")} are entered (about ${a2 ?? 48} h).`);
  } else console.log(`Task ${a1} marked done.`);
}

async function blockhash(arg?: string) {
  if (!arg || !/^\d+$/.test(arg)) throw new Error("usage: npm run blockhash -- <height>");
  console.log(await new LightwalletdChain(LIGHTWALLETD()).blockHash(Number(arg)));
  process.exit(0);
}

async function verify(args: string[]) {
  const raffle = args[0] === "raffle";
  const arg = raffle ? args[1] : args[0];
  if (!arg) throw new Error("usage: npm run verify -- <round number | path/to/round.json> | raffle <n>");
  const path = /^\d+$/.test(arg) ? join(DATA, raffle ? "raffles" : "rounds", `${arg}.json`) : arg;
  const rec = JSON.parse(await readFile(path, "utf8")) as RoundRecord | RaffleRecord;
  const checks = ("raffle" in rec ? verifyRaffle(rec) : verifyRound(rec)).checks;
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
  verify: () => verify(rest),
  blockhash: () => blockhash(rest[0]),
};
(cmds[cmd ?? ""] ?? (async () => console.log("commands: serve | simulate | tick | op | verify <n> | blockhash <h>")))().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

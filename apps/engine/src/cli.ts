/**
 *   npm run dev                 web + engine on a mock chain (demo buttons enabled)
 *   npm run simulate            scripted end-to-end run on the mock chain
 *   SNARKPOT_MODE=live npm run serve   live: site + API + a tick every 60 s (see README "Going live")
 *   npm run tick                one live tick, then exit
 *   npm run blockhash -- <h>    print a block hash from lightwalletd (compare with an explorer)
 *   npm run verify -- <n|file>  re-check a published round
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PARAMS,
  newTicketKey,
  signClaim,
  ticketMemo,
  verifyRound,
  zatsToZec,
  type Params,
  type RoundRecord,
} from "../../../packages/core/src/index.ts";
import { MockChain, MockZilkroad } from "./adapters/mock.ts";
import { HttpZilkroad } from "./adapters/zilkroad-http.ts";
import { LightwalletdChain, ZingoCli, ZingoPool } from "./adapters/zingo.ts";
import { Engine, initialState, parseLine } from "./engine.ts";
import { startServer } from "./server.ts";
import { loadState, publish, saveState } from "./store.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const VAR = process.env.SNARKPOT_VAR ?? join(ROOT, "var");
const DATA = join(VAR, "data");
const STATE = join(VAR, "state.json");
const WEB = join(ROOT, "apps/web/public");

/** Short rounds so the mock demo moves at human speed. */
const MOCK_PARAMS: Params = { ...DEFAULT_PARAMS, roundBlocks: 30, seedDelay: 3, reorgSafety: 2, claimWindowBlocks: 200 };

function mockEngine() {
  const chain = new MockChain();
  const market = new MockZilkroad(chain);
  const state = initialState({
    startHeight: chain.tip,
    poolAddress: "u1mockpoolorchardonlyaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    poolZilkroadAddress: "u1mockpoolzilkroad",
    viewingKey: "uview1mock-the-inbox-wallet-ufvk-goes-here",
    mode: "mock",
    params: MOCK_PARAMS,
  });
  return { chain, market, engine: new Engine(state, { wallet: chain, chain, market }) };
}

async function simulate() {
  const { chain, market, engine } = mockEngine();
  const say = (s: string) => console.log(s);
  const buyers = Array.from({ length: 8 }, () => newTicketKey());

  say("Round 1: only 3 tickets → should roll over");
  for (const b of buyers.slice(0, 3)) chain.pay(MOCK_PARAMS.ticketZats, ticketMemo(b.pk));
  chain.mine(MOCK_PARAMS.roundBlocks);
  await engine.tick();

  say("Round 2: 3 more tickets + one bad memo (donation)");
  for (const b of buyers.slice(3, 6)) chain.pay(MOCK_PARAMS.ticketZats, ticketMemo(b.pk));
  chain.pay(5_000_000, "hello");
  chain.mine(MOCK_PARAMS.roundBlocks);
  await engine.tick();
  chain.mine(MOCK_PARAMS.seedDelay + MOCK_PARAMS.reorgSafety);
  await engine.tick(); // draw + order + pay
  await engine.tick(); // order settles

  const r2 = engine.round(2)!;
  const winnerPk = parseLine(r2.tickets[r2.winner!]!).pk;
  const winner = buyers.find((b) => b.pk === winnerPk)!;
  say(`  winner ticket #${r2.winner} of ${r2.tickets.length}; bought zkSNARK #${r2.purchase?.snarkId} for ${zatsToZec(r2.purchase!.priceZats)} ZEC`);

  const to = "ZR-7K4Q-M2XD";
  const res = engine.submitClaim(2, r2.winner!, to, signClaim(winner.code, 2, r2.winner!, to));
  say(`  claim accepted: ${res.ok}`);
  await engine.tick();
  say(`  transfers: ${JSON.stringify(market.transfers)}`);

  await publish(DATA, engine);
  const pub = JSON.parse(await readFile(join(DATA, "rounds/2.json"), "utf8")) as RoundRecord;
  const v = verifyRound(pub);
  say(`  independent verify of rounds/2.json: ${v.ok ? "PASS" : "FAIL"}`);
  for (const c of v.checks) say(`    ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  say(`\nRound 3 opened with carried surplus pot ${zatsToZec(engine.openRound().potZats)} ZEC`);
  say(`Public data written to ${DATA}`);
  if (!v.ok || !res.ok || market.transfers.length !== 1) process.exit(1);
}

async function serveMock() {
  const { chain, engine } = mockEngine();
  const port = Number(process.env.PORT ?? 8787);
  const step = async () => {
    await engine.tick();
    await publish(DATA, engine);
  };
  await step();
  startServer({
    port,
    webDir: WEB,
    dataDir: DATA,
    post: {
      "/api/claim": async (b) => {
        const { round, ticket, to, sig } = b as { round: number; ticket: number; to: string; sig: string };
        const out = engine.submitClaim(Number(round), Number(ticket), String(to), String(sig));
        await step();
        return { status: out.ok ? 200 : 400, json: out };
      },
      "/api/withdraw": async (b) => {
        const { round, pk, to, sig } = b as { round: number; pk: string; to: string; sig: string };
        const out = engine.submitWithdraw(Number(round), String(pk), String(to), String(sig));
        await step();
        return { status: out.ok ? 200 : 400, json: out };
      },
      "/api/mock/pay": async (b) => {
        const { zats, memo } = b as { zats: number; memo: string };
        chain.pay(Number(zats), String(memo));
        await step();
        return { status: 200, json: { ok: true, height: chain.tip } };
      },
      "/api/mock/mine": async (b) => {
        chain.mine(Math.min(500, Number((b as { blocks?: number }).blocks ?? 1)));
        await step();
        await step(); // let a pending order settle in the same click
        return { status: 200, json: { ok: true, height: chain.tip } };
      },
      "/api/mock/bots": async (b) => {
        const n = Math.min(20, Number((b as { n?: number }).n ?? 5));
        for (let i = 0; i < n; i++) chain.pay(MOCK_PARAMS.ticketZats, ticketMemo(newTicketKey().pk));
        await step();
        return { status: 200, json: { ok: true } };
      },
    },
  });
  console.log(`SNARKPOT (mock chain) → http://localhost:${port}`);
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
  const market = new HttpZilkroad(env("ZILKROAD_COOKIE"), undefined, process.env.ZILKROAD_USER_AGENT ?? "");
  let state = await loadState(STATE);
  if (!state) {
    await wallet.beginTick();
    state = initialState({
      startHeight: await wallet.height(),
      poolAddress: env("POOL_ADDRESS"),
      poolZilkroadAddress: env("POOL_ZILKROAD_ADDRESS"),
      viewingKey: env("POOL_VIEWING_KEY"),
    });
  }
  return new Engine(state, { wallet, chain: new LightwalletdChain(server), market });
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
  const port = Number(process.env.PORT ?? 8787);
  const every = Number(process.env.TICK_SECONDS ?? 60) * 1000;
  const loop = () =>
    run(() => tickOnce(engine))
      .catch((e) => console.error(new Date().toISOString(), "tick failed:", (e as Error).message))
      .finally(() => setTimeout(loop, every));
  loop();
  const mutate = (fn: () => { ok: boolean }) =>
    run(async () => {
      const out = fn();
      if (out.ok) {
        await saveState(STATE, engine.state);
        await publish(DATA, engine);
      }
      return { status: out.ok ? 200 : 400, json: out };
    });
  startServer({
    port,
    webDir: WEB,
    dataDir: DATA,
    post: {
      "/api/claim": async (b) => {
        const { round, ticket, to, sig } = b as { round: number; ticket: number; to: string; sig: string };
        return mutate(() => engine.submitClaim(Number(round), Number(ticket), String(to), String(sig)));
      },
      "/api/withdraw": async (b) => {
        const { round, pk, to, sig } = b as { round: number; pk: string; to: string; sig: string };
        return mutate(() => engine.submitWithdraw(Number(round), String(pk), String(to), String(sig)));
      },
    },
  });
  console.log(`SNARKPOT (live, ${LIGHTWALLETD()}) → http://localhost:${port}`);
}

/** Operator check: print a block hash from lightwalletd to compare with an explorer by eye. */
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
  for (const c of v.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  console.log(v.ok ? "PASS" : "FAIL");
  if (!v.ok) process.exit(1);
}

const [cmd, arg] = process.argv.slice(2);
const live = process.env.SNARKPOT_MODE === "live";
const cmds: Record<string, () => Promise<void>> = {
  simulate,
  serve: live ? serveLive : serveMock,
  tick: tickLive,
  verify: () => verify(arg),
  blockhash: () => blockhash(arg),
};
(cmds[cmd ?? ""] ?? (async () => console.log("commands: serve | simulate | tick | verify <n> | blockhash <h>")))().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

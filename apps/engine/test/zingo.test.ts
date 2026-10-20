import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { newTicketKey, ticketMemo, ticketsFromPayment } from "../../../packages/core/src/index.ts";
import { displayHash, extractJson, LightwalletdChain, ORCHARD_INDEX_OFFSET, paymentsFromNotes, ZingoCli, ZingoPool, type Exec } from "../src/adapters/zingo.ts";

// JSON shapes copied from zingolib's NoteSummary → JsonValue (zingolib/src/wallet/summary/data.rs).
const note = (o: Partial<Record<string, unknown>>) => ({
  value: 10_000_000,
  status: "confirmed at block height 3500001",
  spend_status: "unspent",
  memo: null,
  time: 1760500000,
  txid: "aa".repeat(32),
  output_index: 0,
  account_id: 0,
  scope: "external",
  ...o,
});

test("extractJson skips the status lines zingo-cli prints around its JSON", () => {
  assert.deepEqual(extractJson('Launching sync task...\n{\n  "height": 3500100\n}\n'), { height: 3500100 });
  // verbatim shape of a real quicksend on the operator's Mac, 2026-10-20
  const real = [
    "Launching sync task...",
    "Launching save task...",
    "{",
    '  "txids": [',
    '    "5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e"',
    "  ],",
    '  "transmissions": [',
    '    { "txid": "5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e", "over_mixnet": false, "destination": "zec.rocks", "rtt_ms": 539 }',
    "  ]",
    "}",
    "Save task shutdown successfully.",
    "Zingo CLI quit successfully.",
  ].join("\n");
  assert.deepEqual((extractJson(real) as { txids: string[] }).txids, ["5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e"]);
  // braces inside strings (e.g. a memo) don't confuse it
  assert.deepEqual(extractJson('x\n{"memo": "a } b { [c]", "n": 1}\ntrailing'), { memo: "a } b { [c]", n: 1 });
  assert.throws(() => extractJson("Error: no wallet"));
});

test("paymentsFromNotes keeps confirmed external notes, skips change and mempool, offsets Orchard", () => {
  const pk = newTicketKey().pk;
  const ps = paymentsFromNotes({
    ironwood_notes: [
      note({ memo: ticketMemo(pk), value: 30_000_000, output_index: 1 }),
      note({ scope: "internal", txid: "bb".repeat(32) }), // change
      note({ status: "mempool at block height 3500009", txid: "cc".repeat(32) }), // unconfirmed
      note({ txid: "dd".repeat(32), status: "confirmed at block height 3499990", memo: "hello" }),
    ],
    orchard_notes: [note({ txid: "ee".repeat(32), status: "confirmed at block height 3400000", output_index: 2 })],
    sapling_notes: [note({ txid: "ff".repeat(32) })], // pool UA has no Sapling receiver: ignored
  });
  assert.deepEqual(
    ps.map((p) => [p.txid.slice(0, 2), p.outIndex, p.height, p.zats, p.memo?.slice(0, 9) ?? null]),
    [
      ["ee", ORCHARD_INDEX_OFFSET + 2, 3400000, 10_000_000, null],
      ["dd", 0, 3499990, 10_000_000, "hello"],
      ["aa", 1, 3500001, 30_000_000, "SNARKPOT1"],
    ],
  );
});

test("paymentsFromNotes reads the real `notes all` output from the operator's Mac (2026-10-20)", () => {
  const real = extractJson(`WARNING: this build carries \`nakednet-test-mode\`, so it went online with NO mixnet.
Launching save task...
{
  "ironwood_notes": {
    "note_summaries": [
      {
        "value": 10000000,
        "status": "confirmed at block height 3524121",
        "spend_status": "unspent",
        "memo": "SNARKPOT1 8JvxZqH99sQ9AZ5nTHqTd0AKSL-KpLMCQmTddoJuXuM",
        "time": 1792479733,
        "txid": "0ddbfeb568e052454b2fa7dc45bb638361543bbb3f50b7310c1d97505edf25d8",
        "output_index": 0,
        "account_id": 0,
        "scope": "external"
      }
    ]
  },
  "orchard_notes": { "note_summaries": [] },
  "sapling_notes": { "note_summaries": [] }
}
Save task shutdown successfully.
Zingo CLI quit successfully.`) as Parameters<typeof paymentsFromNotes>[0];
  const ps = paymentsFromNotes(real);
  assert.equal(ps.length, 1);
  assert.deepEqual(ps[0], {
    txid: "0ddbfeb568e052454b2fa7dc45bb638361543bbb3f50b7310c1d97505edf25d8",
    outIndex: 0,
    height: 3524121,
    zats: 10_000_000,
    memo: "SNARKPOT1 8JvxZqH99sQ9AZ5nTHqTd0AKSL-KpLMCQmTddoJuXuM",
  });
  // and it becomes exactly one ticket
  assert.equal(ticketsFromPayment(ps[0]!).length, 1);
});

/** A fake zingo-cli: records argv, answers per wallet+command. */
function fakeCli(answers: Record<string, (args: string[]) => unknown>) {
  const calls: string[][] = [];
  const exec: Exec = async (_bin, args) => {
    calls.push(args);
    const dir = args[args.indexOf("--data-dir") + 1]!;
    const cmd = args[5]!;
    const fn = answers[`${dir}:${cmd}`];
    if (!fn) throw Object.assign(new Error("exit 1"), { stderr: `unexpected ${dir}:${cmd}` });
    return { stdout: JSON.stringify(fn(args.slice(6))), stderr: "sync report…" };
  };
  return { exec, calls };
}

test("ZingoPool: syncs each wallet once per tick, sweeps inbox → ops, pays from ops", async () => {
  const OPS = "u1" + "o".repeat(110);
  const { exec, calls } = fakeCli({
    "inbox:height": () => ({ height: 3500100 }),
    "inbox:notes": () => ({ ironwood_notes: { note_summaries: [note({ memo: ticketMemo(newTicketKey().pk) })] }, orchard_notes: { note_summaries: [] }, sapling_notes: { note_summaries: [] } }),
    "inbox:max_send_value": () => ({ max_send_value: 59_980_000 }),
    "inbox:quicksend": () => ({ txids: ["11".repeat(32)], transmissions: [] }),
    "ops:spendable_balance": () => ({ spendable_balance: 59_980_000 }),
    "ops:quicksend": () => ({ txids: ["22".repeat(32)], transmissions: [] }),
  });
  const cfg = (d: string) => ({ bin: "zingo-cli", dataDir: d, server: "https://zec.rocks:443" });
  const pool = new ZingoPool(new ZingoCli(cfg("inbox"), exec), new ZingoCli(cfg("ops"), exec), OPS);

  await pool.beginTick();
  assert.equal(await pool.height(), 3500100);
  assert.equal((await pool.incoming(3500000)).length, 1);
  assert.equal((await pool.incoming(3500001)).length, 0, "sinceHeight is exclusive");
  assert.deepEqual(await pool.balance(), { spendableZats: 59_980_000 });
  assert.equal(await pool.send("u1dest", 19_985_000, "SNARKPOT1 refund"), "22".repeat(32));

  const flags = calls.map((a) => `${a[1]}:${a[4]}:${a[5]}`);
  assert.deepEqual(flags, [
    "inbox:--waitsync:height",
    "inbox:--nosync:notes",
    "inbox:--nosync:notes",
    "inbox:--nosync:max_send_value",
    "inbox:--nosync:quicksend",
    "ops:--waitsync:spendable_balance",
    "ops:--nosync:spendable_balance",
    "ops:--nosync:quicksend",
  ]);
  const sweep = calls.find((a) => a[1] === "inbox" && a[5] === "quicksend")!;
  assert.deepEqual(sweep.slice(6), [OPS, "59980000", "SNARKPOT1 sweep"]);
  const pay = calls.find((a) => a[1] === "ops" && a[5] === "quicksend")!;
  assert.deepEqual(pay.slice(6), ["u1dest", "19985000", "SNARKPOT1 refund"]);
  assert.equal(calls[0]![3], "https://zec.rocks:443");

  await pool.beginTick(); // next tick syncs again
  await pool.height();
  assert.equal(calls.at(-1)![4], "--waitsync");
});

test("ZingoPool: dust in inbox is not swept; zingo errors surface with stderr", async () => {
  const { exec, calls } = fakeCli({
    "inbox:max_send_value": () => ({ max_send_value: 5_000 }),
    "ops:spendable_balance": () => ({ spendable_balance: 0 }),
  });
  const cfg = (d: string) => ({ bin: "zingo-cli", dataDir: d, server: "https://zec.rocks:443" });
  const pool = new ZingoPool(new ZingoCli(cfg("inbox"), exec), new ZingoCli(cfg("ops"), exec), "u1ops");
  await pool.balance();
  assert.ok(!calls.some((a) => a[5] === "quicksend"));
  // ops is empty and inbox only has dust: send refuses without trying to pay
  await assert.rejects(pool.send("u1x", 1, "m"), /not enough spendable funds/);
  assert.ok(!calls.some((a) => a[5] === "quicksend"));
});

test("ZingoPool: send tops ops up from inbox when short, then asks to retry", async () => {
  const { exec, calls } = fakeCli({
    "inbox:max_send_value": () => ({ max_send_value: 30_000_000 }),
    "inbox:quicksend": () => ({ txids: ["33".repeat(32)] }),
    "ops:spendable_balance": () => ({ spendable_balance: 0 }),
  });
  const cfg = (d: string) => ({ bin: "zingo-cli", dataDir: d, server: "https://zec.rocks:443" });
  const pool = new ZingoPool(new ZingoCli(cfg("inbox"), exec), new ZingoCli(cfg("ops"), exec), "u1ops");
  await assert.rejects(pool.send("u1x", 19_985_000, "SNARKPOT1 refund"), /swept inbox → ops/);
  assert.deepEqual(calls.filter((a) => a[5] === "quicksend").map((a) => a[1]), ["inbox"]);
});

test("displayHash reverses internal byte order", () => {
  const internal = Uint8Array.from({ length: 32 }, (_, i) => i);
  assert.equal(displayHash(internal), Array.from({ length: 32 }, (_, i) => (31 - i).toString(16).padStart(2, "0")).join(""));
});

test("LightwalletdChain talks gRPC GetBlock and returns display-order hex", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const def = await loader.load(join(here, "../proto/lightwalletd.proto"), { longs: String, defaults: true });
  const pkg = grpc.loadPackageDefinition(def) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const server = new grpc.Server();
  const internal = Buffer.alloc(32);
  internal[0] = 0xab; // internal first byte → display last byte
  server.addService(pkg.cash.z.wallet.sdk.rpc.CompactTxStreamer.service, {
    GetBlock: (call: { request: { height: string } }, cb: (e: null, r: unknown) => void) =>
      cb(null, { height: call.request.height, hash: internal, prevHash: Buffer.alloc(32), time: 0 }),
    GetLatestBlock: (_c: unknown, cb: (e: null, r: unknown) => void) => cb(null, { height: "1", hash: Buffer.alloc(32) }),
  });
  const port = await new Promise<number>((ok, fail) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) => (e ? fail(e) : ok(p))),
  );
  try {
    const hash = await new LightwalletdChain(`http://127.0.0.1:${port}`).blockHash(3500123);
    assert.equal(hash, "00".repeat(31) + "ab");
  } finally {
    server.forceShutdown();
  }
});

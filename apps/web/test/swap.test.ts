import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, Message, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { erc20TransferData } from "../src/swap/evm.ts";
import { associatedTokenAddress, buildSplTransfer } from "../src/swap/solana.ts";
import { formatUnits, quoteRequest, SOURCES, ZEC_ASSET } from "../src/swap/oneclick.ts";

const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("ERC-20 transfer calldata", () => {
  // 1 USDC (6 decimals) = 1_000_000 = 0xf4240
  assert.equal(
    erc20TransferData("0x2527D02599Ba641c19FEa793cD0F167589a0f10D", 1_000_000n),
    "0xa9059cbb" +
      "0000000000000000000000002527d02599ba641c19fea793cd0f167589a0f10d" +
      "00000000000000000000000000000000000000000000000000000000000f4240",
  );
  assert.throws(() => erc20TransferData("0x123", 1n));
});

test("associated token address matches @solana/spl-token", () => {
  for (let i = 0; i < 20; i++) {
    const owner = Keypair.generate().publicKey;
    const expected = getAssociatedTokenAddressSync(new PublicKey(USDC_SOL), owner, true).toBase58();
    assert.equal(associatedTokenAddress(owner.toBase58(), USDC_SOL), expected);
  }
});

/** Order-independent view of a compiled message: header, blockhash, account flags, instructions by pubkey. */
function canonical(msg: Message) {
  const keys = msg.accountKeys.map((k, i) => ({ k: k.toBase58(), s: msg.isAccountSigner(i), w: msg.isAccountWritable(i) }));
  return {
    header: msg.header,
    blockhash: msg.recentBlockhash,
    payer: keys[0]!.k,
    accounts: [...keys].sort((a, b) => (a.k < b.k ? -1 : 1)),
    ixs: msg.instructions.map((ix) => ({
      program: keys[ix.programIdIndex]!.k,
      accounts: ix.accounts.map((a) => keys[a]!.k),
      data: ix.data,
    })),
  };
}

test("hand-built SPL transfer decodes to the same transaction as web3.js + spl-token", () => {
  for (let i = 0; i < 10; i++) {
    const from = Keypair.generate().publicKey;
    const to = Keypair.generate().publicKey;
    const mint = new PublicKey(USDC_SOL);
    const blockhash = Keypair.generate().publicKey.toBase58(); // any 32 bytes
    const amount = BigInt(1 + Math.floor(Math.random() * 1e12));

    const mine = buildSplTransfer({ from: from.toBase58(), to: to.toBase58(), mint: USDC_SOL, amount, decimals: 6, blockhash });

    const srcAta = getAssociatedTokenAddressSync(mint, from, true);
    const dstAta = getAssociatedTokenAddressSync(mint, to, true);
    const ref = new Transaction({ feePayer: from, recentBlockhash: blockhash }).add(
      createAssociatedTokenAccountIdempotentInstruction(from, dstAta, to, mint),
      createTransferCheckedInstruction(srcAta, mint, dstAta, from, amount, 6),
    );
    assert.equal(mine[0], 1, "one signature slot");
    assert.ok(mine.slice(1, 65).every((b) => b === 0), "empty signature");
    const mineMsg = Message.from(Buffer.from(mine.slice(65)));
    assert.deepEqual(canonical(mineMsg), canonical(ref.compileMessage()));
    // and web3.js can parse the whole wire transaction
    assert.equal(Transaction.from(Buffer.from(mine)).instructions.length, 2);
  }
});

test("1Click quote request is exact-output into ZEC, refund on origin chain", () => {
  const src = SOURCES.find((s) => s.key === "usdc-sol")!;
  const r = quoteRequest({ source: src, zecZats: 20_020_000, recipient: "u1abc", refundTo: "So1ana" }, 0);
  assert.equal(r.swapType, "EXACT_OUTPUT");
  assert.equal(r.amount, "20020000");
  assert.equal(r.destinationAsset, ZEC_ASSET);
  assert.equal(r.originAsset, src.assetId);
  assert.equal(r.refundType, "ORIGIN_CHAIN");
  assert.equal(r.recipientType, "DESTINATION_CHAIN");
  assert.equal(r.dry, false);
  assert.equal(r.deadline, new Date(30 * 60_000).toISOString());
});

test("formatUnits", () => {
  assert.equal(formatUnits("220892491", 6), "220.892491");
  assert.equal(formatUnits("20000000", 6), "20");
  assert.equal(formatUnits("5", 6), "0.000005");
});

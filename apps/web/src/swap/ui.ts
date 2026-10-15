/**
 * "Get ZEC with stablecoins": quote → send from a connected wallet (or by
 * hand) → watch status. ZEC is delivered to the user's OWN shielded address;
 * paying the pot is a separate shielded payment (SPEC §3.4 explains why).
 */
import { SHIELDED_ADDR_RE, zatsToZec, zecToZats } from "../../../../packages/core/src/index.ts";
import { connectEvm, discoverEvmWallets, sendErc20, type EvmWallet } from "./evm.ts";
import { formatUnits, getQuote, getStatus, SOURCES, submitDeposit, type Quote, type SourceAsset } from "./oneclick.ts";
import { connectSolana, discoverSolanaWallets, sendSpl, type StdWallet } from "./solana.ts";

type Connected =
  | { kind: "evm"; name: string; wallet: EvmWallet; address: string }
  | { kind: "sol"; name: string; wallet: StdWallet; account: { address: string; chains: readonly string[] }; address: string };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function initSwap(opts: { defaultZats: () => number; toast: (m: string) => void }) {
  let connected: Connected | null = null;
  let quote: Quote | null = null;
  let quoteSource: SourceAsset | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const src = $<HTMLSelectElement>("sw-src");
  src.replaceChildren(...SOURCES.map((s) => Object.assign(document.createElement("option"), { value: s.key, textContent: s.label })));
  const source = () => SOURCES.find((s) => s.key === src.value)!;

  $("open-swap").addEventListener("click", () => {
    $<HTMLInputElement>("sw-zec").value = zatsToZec(opts.defaultZats());
    $("swap-panel").hidden = false;
    $("swap-panel").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });

  const resetWallet = () => {
    connected = null;
    renderWallet();
    clearQuote();
  };
  src.addEventListener("change", resetWallet);
  $("sw-zec").addEventListener("input", clearQuote);
  $("sw-to").addEventListener("input", clearQuote);

  function renderWallet() {
    const box = $("sw-wallet");
    box.replaceChildren();
    const s = source();
    $("sw-refund-chain").textContent = s.chainName;
    if (connected) {
      const p = document.createElement("p");
      p.textContent = `Connected: ${connected.name}, ${short(connected.address)} on ${s.chainName}.`;
      const btn = Object.assign(document.createElement("button"), { type: "button", textContent: "Disconnect" });
      btn.addEventListener("click", resetWallet);
      box.append(p, btn);
      return;
    }
    const btn = Object.assign(document.createElement("button"), { type: "button", textContent: `Connect ${s.kind === "sol" ? "Solana" : "EVM"} wallet` });
    btn.addEventListener("click", () => pickWallet(s));
    box.append(btn);
  }

  async function pickWallet(s: SourceAsset) {
    const box = $("sw-wallet");
    const list = s.kind === "sol" ? await discoverSolanaWallets() : await discoverEvmWallets();
    if (list.length === 0) {
      box.replaceChildren(
        Object.assign(document.createElement("p"), {
          textContent: `No ${s.kind === "sol" ? "Solana" : "EVM"} wallet found in this browser. Install one (Phantom works for both), or send from an exchange using the option below.`,
        }),
      );
      return;
    }
    box.replaceChildren(
      ...list.map((w) => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: "wallet-btn" });
        if (w.icon) b.append(Object.assign(document.createElement("img"), { src: w.icon, alt: "", width: 20, height: 20 }));
        b.append(w.name);
        b.addEventListener("click", async () => {
          try {
            if (s.kind === "sol") {
              const sw = w as StdWallet;
              const account = await connectSolana(sw);
              connected = { kind: "sol", name: sw.name, wallet: sw, account, address: account.address };
            } else {
              const ew = w as EvmWallet;
              const address = await connectEvm(ew.provider, s.chainIdHex!);
              connected = { kind: "evm", name: ew.name, wallet: ew, address };
            }
            renderWallet();
          } catch (e) {
            opts.toast(`Couldn’t connect: ${(e as Error).message}`);
          }
        });
        return b;
      }),
    );
  }

  function clearQuote() {
    quote = null;
    if (poll) clearInterval(poll);
    poll = null;
    $("sw-quote-out").replaceChildren();
  }

  $("sw-quote").addEventListener("click", async () => {
    clearQuote();
    const out = $("sw-quote-out");
    const s = source();
    const to = $<HTMLInputElement>("sw-to").value.trim();
    const refundTo = connected?.address ?? $<HTMLInputElement>("sw-refund").value.trim();
    let zats: number;
    try {
      zats = zecToZats($<HTMLInputElement>("sw-zec").value);
    } catch {
      return line(out, "Enter how much ZEC you want, like 0.2002.");
    }
    if (!SHIELDED_ADDR_RE.test(to)) return line(out, "Enter your shielded Zcash address. It starts with u1 or zs1; copy it from Zodl or another Zcash wallet.");
    if (!refundTo) return line(out, `Connect a wallet, or enter a refund address on ${s.chainName} under “Send from an exchange or another wallet”.`);
    line(out, "Getting a quote…");
    try {
      quote = await getQuote({ source: s, zecZats: zats, recipient: to, refundTo });
      quoteSource = s;
      renderQuote(refundTo);
    } catch (e) {
      out.replaceChildren();
      line(out, (e as Error).message);
    }
  });

  function renderQuote(refundTo: string) {
    const q = quote!;
    const s = quoteSource!;
    const out = $("sw-quote-out");
    out.replaceChildren();
    const dl = document.createElement("dl");
    dl.className = "sw-facts";
    const fact = (k: string, v: string) => dl.append(Object.assign(document.createElement("dt"), { textContent: k }), Object.assign(document.createElement("dd"), { textContent: v }));
    fact("You send", `${q.amountInFormatted} ${s.symbol} on ${s.chainName}`);
    fact("You receive", `${q.amountOutFormatted} ZEC, shielded`);
    fact("Takes", `about ${Math.max(1, Math.round(q.timeEstimate / 60))} min after your deposit confirms`);
    fact("Send before", new Date(q.deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    fact("If it fails", `your ${s.symbol} goes back to ${short(refundTo)}`);
    out.append(dl);

    if (connected) {
      const send = Object.assign(document.createElement("button"), { type: "button", className: "primary", textContent: `Send ${q.amountInFormatted} ${s.symbol} with ${connected.name}` });
      send.addEventListener("click", async () => {
        send.disabled = true;
        try {
          const txHash =
            connected!.kind === "sol"
              ? await sendSpl(connected!.wallet, connected!.account, { to: q.depositAddress, mint: s.contract, amount: BigInt(q.amountIn), decimals: s.decimals })
              : await sendErc20(connected!.wallet.provider, { from: connected!.address, token: s.contract, to: q.depositAddress, amount: BigInt(q.amountIn), chainIdHex: s.chainIdHex! });
          await submitDeposit(txHash, q.depositAddress);
          watch(q.depositAddress, `${s.explorerTx}${txHash}`);
        } catch (e) {
          send.disabled = false;
          opts.toast(`Not sent: ${(e as Error).message}`);
        }
      });
      out.append(send);
    } else {
      const manual = document.createElement("div");
      manual.className = "code-row";
      const code = Object.assign(document.createElement("code"), { textContent: q.depositAddress });
      const copyBtn = Object.assign(document.createElement("button"), { type: "button", textContent: "Copy address" });
      copyBtn.addEventListener("click", () => navigator.clipboard?.writeText(q.depositAddress).then(() => opts.toast("Deposit address copied")));
      manual.append(code, copyBtn);
      out.append(
        Object.assign(document.createElement("p"), {
          textContent: `Send exactly ${formatUnits(q.amountIn, s.decimals)} ${s.symbol} on ${s.chainName} to this address${q.depositMemo ? ` with memo ${q.depositMemo}` : ""}:`,
        }),
        manual,
      );
      watch(q.depositAddress, null);
    }
  }

  function watch(depositAddress: string, explorer: string | null) {
    const st = document.createElement("p");
    st.className = "sw-status";
    st.setAttribute("aria-live", "polite");
    $("sw-quote-out").append(st);
    const words: Record<string, string> = {
      PENDING_DEPOSIT: "Waiting for your deposit.",
      KNOWN_DEPOSIT_TX: "Deposit seen. Waiting for it to confirm.",
      INCOMPLETE_DEPOSIT: "The deposit was less than the quote. Send the rest, or wait for the refund after the deadline.",
      PROCESSING: "Swapping. ZEC is on its way to your shielded address.",
      SUCCESS: "Done. The ZEC is in your Zcash wallet. Now buy tickets above and pay from your shielded balance.",
      REFUNDED: "The swap didn’t go through and your funds were refunded.",
      FAILED: "The swap failed. Check the refund address on the sending network.",
    };
    const tick = async () => {
      try {
        const { status } = await getStatus(depositAddress);
        st.textContent = (words[status] ?? status) + (explorer && status !== "SUCCESS" ? " " : "");
        if (explorer && !st.querySelector("a")) st.append(" ", Object.assign(document.createElement("a"), { href: explorer, target: "_blank", rel: "noopener noreferrer", textContent: "View deposit" }));
        if (["SUCCESS", "REFUNDED", "FAILED"].includes(status) && poll) {
          clearInterval(poll);
          poll = null;
        }
      } catch {
        st.textContent = "Can’t reach NEAR Intents right now. Still checking.";
      }
    };
    if (poll) clearInterval(poll);
    poll = setInterval(tick, 6000);
    tick();
  }

  renderWallet();
}

function line(el: HTMLElement, text: string) {
  el.append(Object.assign(document.createElement("p"), { textContent: text }));
}

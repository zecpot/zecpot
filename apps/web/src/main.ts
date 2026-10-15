import qrcode from "qrcode-generator";
import {
  keyFromCode,
  newTicketKey,
  signClaim,
  signWithdraw,
  ticketMemo,
  withdrawAmountZats,
  withdrawFeeZats,
  verifyRound,
  zatsToZec,
  zip321Uri,
  type RoundRecord,
  type TicketKey,
} from "../../../packages/core/src/index.ts";

interface PublicState {
  params: { ticketZats: number; roundBlocks: number };
  poolAddress: string;
  uivk: string;
  floorZats: number | null;
  scannedHeight: number;
  open: { round: number; closeHeight: number; potZats: number; tickets: number; targetZats: number | null; ticketsNeeded: number | null };
  rounds: { round: number; status: string; tickets: number; potZats: number; winner: number | null; snarkId: number | null }[];
}
type PubRound = RoundRecord & { bonusSnarkIds?: number[] };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BLOCK_SECONDS = 75;
let state: PublicState | null = null;
let lastFilled = -1;
let pending: { key: TicketKey; n: number; uri: string } | null = null;

/* ---------------- helpers ---------------- */

const store = {
  get(k: string) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(k, v); } catch { /* private mode: fine, the user saved the code */ }
  },
};

function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  setTimeout(() => t.classList.remove("on"), 2200);
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast("Copy didn’t work here. Select the text and copy it by hand.");
  }
}

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

async function post(path: string, body: unknown) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json()) as { ok: boolean; error?: string };
}

function eta(blocks: number) {
  if (blocks <= 0) return "now";
  const mins = Math.round((blocks * BLOCK_SECONDS) / 60);
  return mins < 90 ? `about ${mins} min` : `about ${Math.round(mins / 60)} h`;
}

const isMock = () => !!state?.uivk.startsWith("uivk1mock");

/* ---------------- render ---------------- */

function renderHero(s: PublicState) {
  const t = s.params.ticketZats;
  const filled = Math.floor(s.open.potZats / t);
  const total = Math.min(40, Math.max(s.open.targetZats ? Math.ceil(s.open.targetZats / t) : 6, filled));
  const slots = $("slots");
  slots.replaceChildren(
    ...Array.from({ length: total }, (_, i) => {
      const d = document.createElement("div");
      d.className = "slot " + (i < filled ? "full" : "empty");
      if (s.open.targetZats && i >= Math.ceil(s.open.targetZats / t)) d.classList.add("extra");
      if (lastFilled >= 0 && i >= lastFilled && i < filled) d.classList.add("new");
      return d;
    }),
  );
  slots.setAttribute("aria-label", `${filled} of ${total} ticket slots filled`);
  lastFilled = filled;

  const need = s.open.ticketsNeeded;
  $("hero-line").textContent =
    need === null
      ? "Today’s zkSNARK is waiting for tickets."
      : need === 0
        ? "The pot covers a zkSNARK. It gets drawn when this round closes."
        : `${need} more ticket${need === 1 ? "" : "s"} and today’s zkSNARK gets drawn.`;

  const blocksLeft = s.open.closeHeight - s.scannedHeight;
  const sub = $("hero-sub");
  sub.innerHTML = "";
  const floor = s.floorZats ? `${zatsToZec(s.floorZats)} ZEC` : "unknown";
  sub.append(
    "Prize: the cheapest zkSNARK on Zilkroad, now ",
    Object.assign(document.createElement("strong"), { textContent: floor }),
    `. Pot so far: `,
    Object.assign(document.createElement("strong"), { textContent: `${zatsToZec(s.open.potZats)} ZEC` }),
    `. Round closes in ${eta(blocksLeft)}.`,
  );
  $("round-meta").textContent = `Round ${s.open.round}, closes at block ${s.open.closeHeight.toLocaleString("en")}`;
  $("uivk").textContent = s.uivk;
  $("mock-panel").hidden = !isMock();
  $("mock-pay").hidden = !isMock();
}

async function renderPast(s: PublicState) {
  const done = s.rounds.filter((r) => r.status !== "open").slice(-10).reverse();
  const list = $("past");
  if (done.length === 0) {
    list.innerHTML = `<li class="none">No round has closed yet. The first draw happens when a round’s pot covers the floor.</li>`;
    return;
  }
  const rows = await Promise.all(
    done.map(async (r) => {
      const li = document.createElement("li");
      const n = Object.assign(document.createElement("span"), { className: "n", textContent: `Round ${r.round}` });
      const what = document.createElement("span");
      const badge = document.createElement("span");
      if (r.status === "rolled") {
        what.textContent = `Rolled over with ${r.tickets} ticket${r.tickets === 1 ? "" : "s"}`;
      } else if (r.winner === null) {
        what.textContent = `Closed with ${r.tickets} tickets, waiting for the seed block`;
      } else {
        const prize = r.snarkId ? `zkSNARK #${r.snarkId}` : "the floor zkSNARK";
        const tail =
          r.status === "claimed" ? "delivered" : r.status === "expired" ? "unclaimed, carried into a later draw" : r.status === "purchased" ? "waiting for the winner to claim" : "being bought";
        what.textContent = `Ticket ${r.winner} of ${r.tickets} won ${prize}, ${tail}`;
        try {
          const rec = await getJSON<PubRound>(`/data/rounds/${r.round}.json`);
          const v = verifyRound(rec);
          badge.className = v.ok ? "verified" : "failed";
          badge.textContent = v.ok ? "Verified" : "Check failed";
          badge.title = v.checks.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.name}: ${c.detail}`).join("\n");
        } catch {
          badge.className = "failed";
          badge.textContent = "Round file missing";
        }
      }
      li.append(n, what, badge);
      return li;
    }),
  );
  list.replaceChildren(...rows);
}

async function refresh() {
  try {
    state = await getJSON<PublicState>("/data/state.json");
    renderHero(state);
    await renderPast(state);
  } catch {
    $("round-meta").textContent = "Can’t reach the round data. Retrying.";
  }
}

/* ---------------- buy ---------------- */

function count() {
  const el = $<HTMLInputElement>("count");
  const n = Math.max(1, Math.min(20, Math.floor(Number(el.value) || 1)));
  el.value = String(n);
  return n;
}
function updatePrice() {
  const t = state?.params.ticketZats ?? 10_000_000;
  $("price").textContent = `${zatsToZec(count() * t)} ZEC`;
}

function startBuy(e: Event) {
  e.preventDefault();
  if (!state) return toast("Round data hasn’t loaded yet");
  const n = count();
  const key = newTicketKey(); // fresh key every purchase, so purchases can’t be linked
  const zats = n * state.params.ticketZats;
  const uri = zip321Uri(state.poolAddress, zats, ticketMemo(key.pk));
  pending = { key, n, uri };
  const codes = JSON.parse(store.get("snarkpot.codes") ?? "[]") as string[];
  store.set("snarkpot.codes", JSON.stringify([...codes, key.code].slice(-50)));

  $("ticket-code").textContent = key.code;
  $<HTMLInputElement>("saved").checked = false;
  $("pay-step").classList.add("locked");
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  $("pay-amount").textContent = `${zatsToZec(zats)} ZEC for ${n} ticket${n === 1 ? "" : "s"}`;
  $<HTMLAnchorElement>("pay-link").href = uri;
  $("buy-panel").hidden = false;
  $("buy-panel").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

/* ---------------- check + claim ---------------- */

async function check(e: Event) {
  e.preventDefault();
  const out = $("check-out");
  out.replaceChildren();
  let key: TicketKey;
  try {
    key = keyFromCode($<HTMLInputElement>("check-code").value);
  } catch (err) {
    out.textContent = (err as Error).message.replace(/^./, (c) => c.toUpperCase()) + ".";
    return;
  }
  if (!state) return;
  const rounds = await Promise.all(state.rounds.slice(-30).map((r) => getJSON<PubRound>(`/data/rounds/${r.round}.json`).catch(() => null)));
  // A carried ticket appears in several rounds; the latest one is its current state.
  const latest = new Map<string, { r: PubRound; idx: number }>();
  const withdrawn: { round: number; n: number; amountZats: number; sent: boolean }[] = [];
  const gone = new Set<string>();
  for (const r of rounds) {
    for (const w of r?.withdrawn ?? []) {
      const mine = w.tickets.filter((l) => l.endsWith(":" + key.pk));
      if (mine.length === 0) continue;
      mine.forEach((l) => gone.add(l));
      withdrawn.push({ round: r!.round, n: mine.length, amountZats: w.amountZats, sent: !!w.txid });
    }
  }
  for (const r of rounds) {
    if (!r) continue;
    r.tickets.forEach((line, idx) => {
      if (line.endsWith(":" + key.pk) && !gone.has(line)) latest.set(line.split(":").slice(0, 3).join(":"), { r, idx });
    });
  }
  for (const w of withdrawn) {
    const div = Object.assign(document.createElement("div"), { className: "result" });
    div.append(Object.assign(document.createElement("p"), {
      textContent: `${w.n} ticket${w.n === 1 ? "" : "s"} withdrawn in round ${w.round}. ${zatsToZec(w.amountZats)} ZEC ${w.sent ? "was sent" : "is being sent"} to the address you gave.`,
    }));
    out.append(div);
  }
  if (latest.size === 0 && withdrawn.length > 0) return;
  if (latest.size === 0) {
    out.textContent = "No tickets for this code yet. A payment shows up once it’s in a block, usually within a few minutes.";
    return;
  }
  const byRound = new Map<number, { r: PubRound; idxs: number[] }>();
  for (const { r, idx } of latest.values()) {
    const e2 = byRound.get(r.round) ?? { r, idxs: [] };
    e2.idxs.push(idx);
    byRound.set(r.round, e2);
  }
  for (const { r, idxs } of byRound.values()) {
    const div = document.createElement("div");
    div.className = "result";
    const n = idxs.length;
    const head = document.createElement("p");
    const won = r.winner !== undefined && idxs.includes(r.winner);
    const carried = idxs.filter((i) => i < (r.carriedCount ?? 0)).length;
    if (r.status === "open" && carried > 0) {
      head.textContent =
        `${carried} ticket${carried === 1 ? "" : "s"} came from a round that didn’t fill, so ${carried === 1 ? "it’s" : "they’re"} in round ${r.round} automatically.` +
        (n > carried ? ` You also have ${n - carried} new ticket${n - carried === 1 ? "" : "s"} here.` : "");
    } else if (r.status === "open") head.textContent = `${n} ticket${n === 1 ? "" : "s"} in round ${r.round}, which is still open.`;
    else if (r.status === "rolled") head.textContent = `${n} ticket${n === 1 ? "" : "s"} carried forward from round ${r.round}.`;
    else if (r.status === "closed") head.textContent = `${n} ticket${n === 1 ? "" : "s"} in round ${r.round}. The draw happens a few blocks after closing.`;
    else if (!won) head.textContent = `${n} ticket${n === 1 ? "" : "s"} in round ${r.round}. Ticket ${r.winner} won this time.`;
    else {
      head.innerHTML = `<span class="won">Ticket ${r.winner} won round ${r.round}.</span>`;
      if (r.status === "claimed") head.append(` It was delivered to ${r.claim?.to}.`);
      if (r.status === "expired") head.append(" The claim window has closed.");
    }
    div.append(head);
    if (r.status === "open" && carried > 0 && state) div.append(withdrawForm(key, r, carried));
    if (won && (r.status === "purchased" || r.status === "purchase_pending")) div.append(claimForm(key, r));
    out.append(div);
  }
}

function withdrawForm(key: TicketKey, r: PubRound, n: number) {
  const amount = withdrawAmountZats(n, r.params);
  const fee = withdrawFeeZats(n, r.params);
  const f = document.createElement("form");
  f.className = "claim";
  f.innerHTML = `
    <p class="hint">Do nothing and ${n === 1 ? "it stays" : "they stay"} in. Or take your ZEC back before block ${r.closeHeight.toLocaleString("en")}:
    <strong>${zatsToZec(amount)} ZEC</strong> (${zatsToZec(n * r.params.ticketZats)} minus a ${zatsToZec(fee)} ZEC network fee).</p>
    <label for="wto">Shielded address to receive it. A fresh one keeps the refund unlinked from your other payments.</label>
    <div class="inline"><input id="wto" placeholder="u1…" autocomplete="off" spellcheck="false" />
    <button type="submit">Withdraw ${zatsToZec(amount)} ZEC</button></div>
    <p class="msg" aria-live="polite"></p>`;
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = f.querySelector(".msg")!;
    const to = (f.querySelector("#wto") as HTMLInputElement).value.trim();
    try {
      const sig = signWithdraw(key.code, r.round, n, amount, to); // signed here; the code never leaves the browser
      const res = await post("/api/withdraw", { round: r.round, pk: key.pk, to, sig });
      msg.textContent = res.ok ? `Withdrawn. ${zatsToZec(amount)} ZEC is on its way to that address.` : `Withdrawal not accepted: ${res.error}.`;
      if (res.ok) { f.querySelector("button")!.disabled = true; refresh(); }
    } catch (err) {
      msg.textContent = `Withdrawal not accepted: ${(err as Error).message}.`;
    }
  });
  return f;
}

function claimForm(key: TicketKey, r: PubRound) {
  const f = document.createElement("form");
  f.className = "claim";
  f.innerHTML = `
    <label for="acct">Send the zkSNARK to this Zilkroad account. A fresh account keeps this win separate from anything else you own.</label>
    <div class="inline"><input id="acct" placeholder="ZR-7K4Q-M2XD" autocomplete="off" spellcheck="false" />
    <button type="submit" class="primary">Claim zkSNARK</button></div>
    <p class="msg" aria-live="polite"></p>`;
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = f.querySelector(".msg")!;
    const to = (f.querySelector("#acct") as HTMLInputElement).value.trim().toUpperCase();
    try {
      const sig = signClaim(key.code, r.round, r.winner!, to); // signed here; the code never leaves the browser
      const res = await post("/api/claim", { round: r.round, ticket: r.winner, to, sig });
      msg.textContent = res.ok ? `Claimed. The zkSNARK will arrive in ${to} within a few minutes.` : `Claim not accepted: ${res.error}.`;
      if (res.ok) refresh();
    } catch (err) {
      msg.textContent = `Claim not accepted: ${(err as Error).message}.`;
    }
  });
  return f;
}

/* ---------------- wire up ---------------- */

document.addEventListener("DOMContentLoaded", () => {
  $("minus").addEventListener("click", () => { $<HTMLInputElement>("count").value = String(count() - 1); updatePrice(); });
  $("plus").addEventListener("click", () => { $<HTMLInputElement>("count").value = String(count() + 1); updatePrice(); });
  $("count").addEventListener("input", updatePrice);
  $("buy-form").addEventListener("submit", startBuy);
  $("saved").addEventListener("change", (e) => $("pay-step").classList.toggle("locked", !(e.target as HTMLInputElement).checked));
  $("copy-code").addEventListener("click", () => pending && copy(pending.key.code, "Ticket code"));
  $("download-code").addEventListener("click", () => {
    if (!pending) return;
    const blob = new Blob([`SNARKPOT ticket code (keep this private)\n${pending.key.code}\n\nTickets: ${pending.n}\n`], { type: "text/plain" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "snarkpot-ticket.txt" });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("copy-uri").addEventListener("click", () => pending && copy(pending.uri, "Payment link"));
  $("copy-uivk").addEventListener("click", () => state && copy(state.uivk, "Viewing key"));
  $("check-form").addEventListener("submit", check);

  $("mock-pay").addEventListener("click", async () => {
    if (!pending || !state) return;
    await post("/api/mock/pay", { zats: pending.n * state.params.ticketZats, memo: ticketMemo(pending.key.pk) });
    $<HTMLInputElement>("check-code").value = pending.key.code;
    toast("Payment mined on the demo chain");
    await refresh();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-bots]").forEach((b) =>
    b.addEventListener("click", async () => { await post("/api/mock/bots", { n: Number(b.dataset.bots) }); await refresh(); }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-mine]").forEach((b) =>
    b.addEventListener("click", async () => {
      const blocks = Number(b.dataset.mine) === 40 && state ? state.open.closeHeight - state.scannedHeight + 16 : Number(b.dataset.mine);
      await post("/api/mock/mine", { blocks });
      await refresh();
    }),
  );

  refresh().then(updatePrice);
  setInterval(refresh, 10_000);
});

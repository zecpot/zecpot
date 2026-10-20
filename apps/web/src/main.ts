import qrcode from "qrcode-generator";
import { initSwap } from "./swap/ui.ts";
import {
  keyFromCode,
  newTicketKey,
  signBonusClaim,
  signClaim,
  signWithdraw,
  ticketMemo,
  verifyBonus,
  verifyRound,
  withdrawAmountZats,
  withdrawFeeZats,
  zatsToZec,
  zip321Uri,
  type RoundRecord,
  type TicketKey,
} from "../../../packages/core/src/index.ts";

interface PublicState {
  params: { ticketZats: number; roundBlocks: number; feeBps: number; bonusEveryRounds: number; claimWindowBlocks: number };
  poolAddress: string;
  viewingKey: string;
  mode: "mock" | "live";
  floorZats: number | null;
  scannedHeight: number;
  open: { round: number; closeHeight: number; potZats: number; tickets: number; prizeIfDrawnZats: number; feeIfDrawnZats: number };
  treasury: {
    address: string;
    viewingKey: string;
    balanceZats: number | null;
    sweepTargetZats: number | null;
    snarks: number[];
    sweeps: { snarkId: number; priceZats: number; at: string }[];
    nextBonusRound: number;
  };
  rounds: {
    round: number;
    status: string;
    tickets: number;
    potZats: number;
    winner: number | null;
    prizeZats: number | null;
    bonus: { snarkId: number; status: string; winner: number; ticketCount: number } | null;
  }[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BLOCK_SECONDS = 75;
const MAX_STUBS = 60;
let state: PublicState | null = null;
let lastTickets = -1;
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
  if (blocks <= 0) return "a few minutes";
  const mins = Math.round((blocks * BLOCK_SECONDS) / 60);
  if (mins < 90) return `about ${mins} min`;
  const h = Math.round(mins / 60);
  return h < 36 ? `about ${h} h` : `about ${Math.round(h / 24)} days`;
}

const zec = (zats: number) => `${zatsToZec(zats)} ZEC`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const isMock = () => state?.mode === "mock";
const rounds = new Map<number, RoundRecord>();
async function roundFile(n: number) {
  const r = await getJSON<RoundRecord>(`/data/rounds/${n}.json`);
  rounds.set(n, r);
  return r;
}

/* ---------------- render ---------------- */

function renderHero(s: PublicState) {
  const n = s.open.tickets;
  $("pot-amount").textContent = zatsToZec(s.open.potZats);
  const slots = $("slots");
  const shown = Math.min(n, MAX_STUBS);
  const stubs: HTMLElement[] = Array.from({ length: Math.max(shown, 1) }, (_, i) => {
    const d = document.createElement("div");
    d.className = "slot " + (i < shown ? "full" : "empty");
    if (lastTickets >= 0 && i >= lastTickets && i < shown) d.classList.add("new");
    return d;
  });
  if (n > MAX_STUBS) stubs.push(Object.assign(document.createElement("span"), { className: "more", textContent: `+${n - MAX_STUBS}` }));
  slots.replaceChildren(...stubs);
  slots.setAttribute("aria-label", `${plural(n, "ticket")} in today’s pot`);
  lastTickets = shown;

  const left = s.open.closeHeight - s.scannedHeight;
  const sub = $("hero-sub");
  sub.replaceChildren();
  if (n === 0) {
    sub.append(`No tickets yet. Buy the first one and, if nobody else joins, it wins the pot. Draw in ${eta(left)}.`);
  } else {
    sub.append(
      `${plural(n, "ticket")} so far. If drawn now, the winning ticket takes `,
      Object.assign(document.createElement("strong"), { textContent: zec(s.open.prizeIfDrawnZats) }),
      `. Draw in ${eta(left)}.`,
    );
  }
  $("round-meta").textContent = `Pot ${s.open.round}, draws after block ${s.open.closeHeight.toLocaleString("en")}`;
  $("viewing-key").textContent = s.viewingKey;
  $("mock-panel").hidden = !isMock();
  $("mock-pay").hidden = !isMock();
}

function renderTreasury(s: PublicState) {
  const t = s.treasury;
  const bal = t.balanceZats ?? 0;
  const target = t.sweepTargetZats;
  const pct = target ? Math.min(100, Math.round((bal / target) * 100)) : 0;
  $("tr-fill").style.width = `${pct}%`;
  $("tr-bar").setAttribute("aria-valuenow", String(pct));
  $("tr-nums").textContent = target
    ? `${zec(bal)} of ${zec(target)} (floor ${s.floorZats ? zec(s.floorZats) : "unknown"} plus 5% headroom)`
    : `${zec(bal)} saved. The floor price is unavailable right now.`;
  const held = $("tr-snarks");
  held.replaceChildren();
  if (t.snarks.length === 0) held.textContent = "None yet";
  for (const id of t.snarks) {
    held.append(Object.assign(document.createElement("a"), { href: `https://zilkroad.com/explorer/${id}`, target: "_blank", rel: "noopener noreferrer", textContent: `zkSNARK #${id}` }), " ");
  }
  const roundsLeft = t.nextBonusRound - s.open.round;
  $("tr-bonus").textContent =
    t.snarks.length > 0
      ? `Next bonus draw: pot ${t.nextBonusRound}, ${roundsLeft === 0 ? "today" : `in ${plural(roundsLeft, "day")}`}. Every ticket from pot ${t.nextBonusRound - s.params.bonusEveryRounds + 1} to pot ${t.nextBonusRound} is in it.`
      : `The weekly bonus draw starts once the treasury holds a zkSNARK. Next possible draw: pot ${t.nextBonusRound}.`;
  $("tr-key").textContent = t.viewingKey;
}

async function renderPast(s: PublicState) {
  const done = s.rounds.filter((r) => r.status !== "open").slice(-10).reverse();
  const list = $("past");
  if (done.length === 0) {
    list.innerHTML = `<li class="none">No pot has been drawn yet. The first draw happens when today’s pot closes.</li>`;
    return;
  }
  const rows = await Promise.all(
    done.map(async (r) => {
      const li = document.createElement("li");
      const n = Object.assign(document.createElement("span"), { className: "n", textContent: `Pot ${r.round}` });
      const what = document.createElement("span");
      const badge = document.createElement("span");
      if (r.status === "rolled") what.textContent = "No tickets, so the pot rolled into the next day";
      else if (r.winner === null) what.textContent = `${plural(r.tickets, "ticket")}, waiting for the draw block`;
      else {
        const tail = r.status === "paid" ? "paid" : r.status === "claimed" ? "being paid" : r.status === "expired" ? "unclaimed, rolled into a later pot" : "waiting for the winner to claim";
        what.textContent = `Ticket ${r.winner} of ${r.tickets} won ${r.prizeZats !== null ? zec(r.prizeZats) : "the pot"}, ${tail}`;
        if (r.bonus) what.append(Object.assign(document.createElement("small"), { textContent: ` Bonus: zkSNARK #${r.bonus.snarkId} to ticket ${r.bonus.winner} of the week’s ${r.bonus.ticketCount}, ${r.bonus.status}.` }));
        try {
          const rec = await roundFile(r.round);
          const v = verifyRound(rec);
          if (rec.bonus) {
            const byRound: Record<number, string[]> = {};
            for (const x of rec.bonus.rounds) byRound[x] = (rounds.get(x) ?? (await roundFile(x))).tickets;
            const vb = verifyBonus(rec, byRound);
            v.checks.push(...vb.checks);
            v.ok &&= vb.ok;
          }
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
    renderTreasury(state);
    await renderPast(state);
  } catch {
    $("round-meta").textContent = "Can’t reach the pot data. Retrying.";
  }
}

/* ---------------- buy ---------------- */

function count() {
  const el = $<HTMLInputElement>("count");
  const n = Math.max(1, Math.min(500, Math.floor(Number(el.value) || 1)));
  el.value = String(n);
  return n;
}
function updatePrice() {
  const t = state?.params.ticketZats ?? 1_000_000;
  $("price").textContent = zec(count() * t);
}

function startBuy(e: Event) {
  e.preventDefault();
  if (!state) return toast("Pot data hasn’t loaded yet");
  const n = count();
  const key = newTicketKey(); // fresh key every purchase, so purchases can’t be linked
  const zats = n * state.params.ticketZats;
  const uri = zip321Uri(state.poolAddress, zats, ticketMemo(key.pk));
  pending = { key, n, uri };
  const codes = JSON.parse(store.get("zecpot.codes") ?? "[]") as string[];
  store.set("zecpot.codes", JSON.stringify([...codes, key.code].slice(-50)));

  $("ticket-code").textContent = key.code;
  $<HTMLInputElement>("saved").checked = false;
  $("pay-step").classList.add("locked");
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  $("pay-amount").textContent = `${zec(zats)} for ${plural(n, "ticket")}`;
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
  const recs = (await Promise.all(state.rounds.slice(-30).map((r) => roundFile(r.round).catch(() => null)))).filter((r): r is RoundRecord => !!r);
  const mine = (line: string) => line.endsWith(":" + key.pk);
  let any = false;
  const result = (...nodes: (string | Node)[]) => {
    const div = Object.assign(document.createElement("div"), { className: "result" });
    div.append(...nodes);
    out.append(div);
    any = true;
    return div;
  };
  const p = (text: string, cls = "") => Object.assign(document.createElement("p"), { textContent: text, className: cls });

  for (const r of recs) {
    for (const w of r.withdrawn ?? []) {
      const n = w.tickets.filter(mine).length;
      if (n) result(p(`${plural(n, "ticket")} withdrawn from pot ${r.round}. ${zec(w.amountZats)} ${w.txid ? "was sent" : "is being sent"} to the address you gave.`));
    }
    const idxs = r.tickets.map((l, i) => (mine(l) ? i : -1)).filter((i) => i >= 0);
    const carried = idxs.filter((i) => i < (r.carriedCount ?? 0)).length;
    if (idxs.length) {
      const n = idxs.length;
      const won = r.winner !== undefined && idxs.includes(r.winner);
      if (r.status === "open" && carried > 0) {
        result(p(`${plural(carried, "ticket")} rolled in from an earlier pot, so ${carried === 1 ? "it’s" : "they’re"} in pot ${r.round} automatically.`), withdrawForm(key, r, carried));
      } else if (r.status === "open") {
        const odds = state.open.round === r.round && state.open.tickets ? ` That’s ${n} in ${state.open.tickets} right now.` : "";
        result(p(`${plural(n, "ticket")} in today’s pot ${r.round}.${odds}`));
      } else if (r.status === "rolled") {
        /* shown in the round they rolled into */
      } else if (r.status === "closed") {
        result(p(`${plural(n, "ticket")} in pot ${r.round}. The draw happens a few blocks after it closed.`));
      } else if (!won) {
        result(p(`${plural(n, "ticket")} in pot ${r.round}. Ticket ${r.winner} won this time.`));
      } else {
        const div = result(p(`Ticket ${r.winner} won pot ${r.round}: ${zec(r.split!.prizeZats)}.`, "won"));
        if (r.status === "drawn") div.append(prizeForm(key, r));
        if (r.status === "claimed") div.append(p("Claimed. The ZEC is on its way to the address you gave."));
        if (r.status === "paid") div.append(p("Paid to the address you gave."));
        if (r.status === "expired") div.append(p("The claim window has closed; the prize rolled into a later pot."));
      }
    }
    // weekly bonus
    if (r.bonus) {
      const lines = r.bonus.rounds.flatMap((n) => recs.find((x) => x.round === n)?.tickets ?? []);
      const line = lines[r.bonus.winner];
      if (line && mine(line)) {
        const div = result(p(`Your ticket won the weekly bonus in pot ${r.round}: zkSNARK #${r.bonus.snarkId}.`, "won"));
        if (r.bonus.status === "drawn") div.append(bonusForm(key, r));
        if (r.bonus.status === "claimed") div.append(p("Claimed. It’s being transferred to your Zilkroad account."));
        if (r.bonus.status === "delivered") div.append(p("Delivered to your Zilkroad account."));
        if (r.bonus.status === "expired") div.append(p("The claim window has closed; it went back to the treasury."));
      }
    }
  }
  if (!any) out.textContent = "No tickets for this code yet. A payment shows up once it’s in a block, usually within a few minutes.";
}

function withdrawForm(key: TicketKey, r: RoundRecord, n: number) {
  const amount = withdrawAmountZats(n, r.params);
  const fee = withdrawFeeZats(n, r.params);
  const f = document.createElement("form");
  f.className = "claim";
  f.innerHTML = `
    <p class="hint">Do nothing and ${n === 1 ? "it stays" : "they stay"} in. Or take your ZEC back before block ${r.closeHeight.toLocaleString("en")}:
    <strong>${zec(amount)}</strong> (${zec(n * r.params.ticketZats)} minus a ${zec(fee)} network fee).</p>
    <label for="wto">Shielded address to receive it. A fresh one keeps the refund unlinked from your other payments.</label>
    <div class="inline"><input id="wto" placeholder="u1…" autocomplete="off" spellcheck="false" />
    <button type="submit">Withdraw ${zec(amount)}</button></div>
    <p class="msg" aria-live="polite"></p>`;
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = f.querySelector(".msg")!;
    const to = (f.querySelector("#wto") as HTMLInputElement).value.trim();
    try {
      const sig = signWithdraw(key.code, r.round, n, amount, to); // signed here; the code never leaves the browser
      const res = await post("/api/withdraw", { round: r.round, pk: key.pk, to, sig });
      msg.textContent = res.ok ? `Withdrawn. ${zec(amount)} is on its way to that address.` : `Withdrawal not accepted: ${res.error}.`;
      if (res.ok) { f.querySelector("button")!.disabled = true; refresh(); }
    } catch (err) {
      msg.textContent = `Withdrawal not accepted: ${(err as Error).message}.`;
    }
  });
  return f;
}

function prizeForm(key: TicketKey, r: RoundRecord) {
  const amount = r.split!.prizeZats;
  const f = document.createElement("form");
  f.className = "claim";
  f.innerHTML = `
    <label for="pto">Shielded address to receive ${zec(amount)}. A fresh one keeps this win unlinked from your other payments. Only a hash of it is published.</label>
    <div class="inline"><input id="pto" placeholder="u1…" autocomplete="off" spellcheck="false" />
    <button type="submit" class="primary">Claim ${zec(amount)}</button></div>
    <p class="msg" aria-live="polite"></p>`;
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = f.querySelector(".msg")!;
    const to = (f.querySelector("#pto") as HTMLInputElement).value.trim();
    try {
      const sig = signClaim(key.code, r.round, r.winner!, to, amount); // signed here; the code never leaves the browser
      const res = await post("/api/claim", { round: r.round, ticket: r.winner, to, sig });
      msg.textContent = res.ok ? `Claimed. ${zec(amount)} will arrive within a few minutes.` : `Claim not accepted: ${res.error}.`;
      if (res.ok) { f.querySelector("button")!.disabled = true; refresh(); }
    } catch (err) {
      msg.textContent = `Claim not accepted: ${(err as Error).message}.`;
    }
  });
  return f;
}

function bonusForm(key: TicketKey, r: RoundRecord) {
  const b = r.bonus!;
  const f = document.createElement("form");
  f.className = "claim";
  f.innerHTML = `
    <label for="bto">Zilkroad account ID to send zkSNARK #${b.snarkId} to. A fresh account keeps this win separate from anything else you own.</label>
    <div class="inline"><input id="bto" placeholder="ZR-7K4Q-M2XD" autocomplete="off" spellcheck="false" />
    <button type="submit" class="primary">Claim zkSNARK #${b.snarkId}</button></div>
    <p class="msg" aria-live="polite"></p>`;
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = f.querySelector(".msg")!;
    const to = (f.querySelector("#bto") as HTMLInputElement).value.trim().toUpperCase();
    try {
      const sig = signBonusClaim(key.code, r.round, b.winner, to, b.snarkId);
      const res = await post("/api/bonus-claim", { round: r.round, ticket: b.winner, to, sig });
      msg.textContent = res.ok ? `Claimed. zkSNARK #${b.snarkId} will arrive in ${to} soon.` : `Claim not accepted: ${res.error}.`;
      if (res.ok) { f.querySelector("button")!.disabled = true; refresh(); }
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
    const blob = new Blob([`zecPOT ticket code (keep this private)\n${pending.key.code}\n\nTickets: ${pending.n}\n`], { type: "text/plain" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "zecpot-ticket.txt" });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("copy-uri").addEventListener("click", () => pending && copy(pending.uri, "Payment link"));
  $("copy-viewing-key").addEventListener("click", () => state && copy(state.viewingKey, "Pot viewing key"));
  $("copy-tr-key").addEventListener("click", () => state && copy(state.treasury.viewingKey, "Treasury viewing key"));
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
  $("mock-gift").addEventListener("click", async () => { await post("/api/mock/treasury", {}); toast("Treasury topped up on the demo chain"); await refresh(); });

  // Swap default: the tickets in the stepper + 0.0002 ZEC for the fee on the payment to the pot.
  initSwap({ defaultZats: () => count() * (state?.params.ticketZats ?? 1_000_000) + 20_000, toast });

  refresh().then(updatePrice);
  setInterval(refresh, 10_000);
});


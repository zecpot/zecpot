import qrcode from "qrcode-generator";
import { initSwap } from "./swap/ui.ts";
import {
  keyFromCode,
  newTicketKey,
  signRaffleClaim,
  signClaim,
  signWithdraw,
  ticketMemo,
  verifyRaffle,
  verifyRound,
  withdrawAmountZats,
  withdrawFeeZats,
  zatsToZec,
  zip321Uri,
  type RaffleRecord,
  type RoundRecord,
  type TicketKey,
  type VerifyResult,
} from "../../../packages/core/src/index.ts";

interface PublicState {
  params: { ticketZats: number; roundBlocks: number; feeBps: number; claimWindowBlocks: number; feePerActionZats: number };
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
  };
  rounds: {
    round: number;
    status: string;
    tickets: number;
    potZats: number;
    winner: number | null;
    prizeZats: number | null;
  }[];
  raffles: RaffleSummary[];
}

interface RaffleSummary {
  raffle: number;
  snarkId: number;
  status: RaffleRecord["status"];
  openHeight: number;
  closeHeight: number;
  tickets: number;
  winner: number | null;
  snark: RaffleRecord["snark"] | null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (string | Node)[]) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const BLOCK_SECONDS = 75;
const MAX_STUBS = 60;
const CODES_KEY = "zecpot.codes";
const REVEALED_KEY = "zecpot.revealed";
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

let state: PublicState | null = null;
let openRec: RoundRecord | null = null;
let lastStubs = -1;
let pending: { key: TicketKey; n: number; uri: string } | null = null;
let deviceSig = "";
let closeAt = 0; // estimated wall-clock time the open pot closes (live mode)
let formSeq = 0;
let claimedJustNow = false; // re-render the claim area after a claim, even though its input has text

/* ---------------- helpers ---------------- */

const store = {
  get(k: string) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(k, v); } catch { /* private mode: the user saved the code themselves */ }
  },
  del(k: string) {
    try { localStorage.removeItem(k); } catch { /* nothing to do */ }
  },
};

function deviceCodes(): string[] {
  try {
    const v = JSON.parse(store.get(CODES_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function deviceKeys(): TicketKey[] {
  const out: TicketKey[] = [];
  for (const c of deviceCodes()) {
    try { out.push(keyFromCode(c)); } catch { /* skip a damaged entry */ }
  }
  return out;
}
function rememberCode(code: string) {
  const codes = deviceCodes().filter((c) => c !== code);
  store.set(CODES_KEY, JSON.stringify([...codes, code].slice(-100)));
}

function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  setTimeout(() => t.classList.remove("on"), 2400);
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

const zec = (zats: number) => `${zatsToZec(Math.max(0, zats))} ZEC`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const isMock = () => state?.mode === "mock";
const ticketNo = (i: number) => `#${i + 1}`; // people count from 1; the protocol counts from 0
const pct = (a: number, b: number) => {
  const p = (a / b) * 100;
  return p >= 99.5 && a < b ? ">99%" : p < 1 ? "<1%" : `${Math.round(p)}%`;
};

const rounds = new Map<number, RoundRecord>();
async function roundFile(n: number) {
  const r = await getJSON<RoundRecord>(`/data/rounds/${n}.json`);
  rounds.set(n, r);
  return r;
}
const pkOf = (line: string) => line.slice(line.lastIndexOf(":") + 1);

async function verifyFull(rec: RoundRecord): Promise<VerifyResult> {
  return verifyRound(rec);
}

const raffles = new Map<number, RaffleRecord>();
async function raffleFile(n: number) {
  const r = await getJSON<RaffleRecord>(`/data/raffles/${n}.json`);
  raffles.set(n, r);
  return r;
}
/** The raffle the page features: the open one, else the latest result for about two days after it closed. */
const featuredRaffle = (s: PublicState) =>
  s.raffles.find((r) => r.status === "open") ??
  [...s.raffles].reverse().find((r) => r.status !== "empty" && (r.status === "drawn" || r.status === "closed" || s.scannedHeight < r.closeHeight + 2 * s.params.roundBlocks));

/* ---------------- hero ---------------- */

function myOpenIndexes(): Set<number> {
  const pks = new Set(deviceKeys().map((k) => k.pk));
  const out = new Set<number>();
  openRec?.tickets.forEach((l, i) => pks.has(pkOf(l)) && out.add(i));
  return out;
}

function renderHero(s: PublicState) {
  const n = s.open.tickets;
  const mine = myOpenIndexes();
  $("pot-amount").textContent = zatsToZec(s.open.potZats);

  // Stubs: yours first in a lighter colour, so they are easy to spot
  const shown = Math.min(n, MAX_STUBS);
  const order = [...mine].concat([...Array(n).keys()].filter((i) => !mine.has(i))).slice(0, shown);
  const stubs: HTMLElement[] = order.map((i, k) => {
    const d = el("div", { className: "slot " + (mine.has(i) ? "mine" : "full") });
    if (lastStubs >= 0 && k >= lastStubs) d.classList.add("new");
    return d;
  });
  if (n === 0) stubs.push(el("div", { className: "slot empty" }));
  if (n > MAX_STUBS) stubs.push(el("span", { className: "more", textContent: `+${n - MAX_STUBS}` }));
  $("slots").replaceChildren(...stubs);
  $("slots").setAttribute("aria-label", `${plural(n, "ticket")} in today’s pot${mine.size ? `, ${mine.size} of them yours` : ""}`);
  $("slots-key").hidden = mine.size === 0;
  lastStubs = shown;

  const sub = $("hero-sub");
  sub.replaceChildren();
  if (n === 0) {
    sub.append("No tickets yet. Buy the first one: if nobody else joins, it takes the pot.");
  } else {
    const yours = mine.size ? `, ${mine.size} of them yours` : "";
    sub.append(`${plural(n, "ticket")} so far${yours}. If the draw were now, one ticket would take `, el("strong", { textContent: zec(s.open.prizeIfDrawnZats) }), ".");
  }
  $("hero-kicker").textContent = `Pot ${s.open.round}, today`;
  $("round-meta").textContent = `This pot closes after block ${s.open.closeHeight.toLocaleString("en")}.`;
  $("viewing-key").textContent = s.viewingKey;
  $("mock-panel").hidden = !isMock();
  $("mock-pay").hidden = !isMock();

  const left = s.open.closeHeight - s.scannedHeight;
  if (!isMock() && left > 0) {
    const est = Date.now() + left * BLOCK_SECONDS * 1000;
    if (!closeAt || Math.abs(est - closeAt) > 90_000) closeAt = est; // ignore block-time jitter
  } else {
    closeAt = 0;
  }
  tickClock();
}

function tickClock() {
  if (!state) return;
  const left = state.open.closeHeight - state.scannedHeight;
  const label = $("clock-label");
  const time = $("clock-time");
  const note = $("clock-note");
  if (left <= 0) {
    label.textContent = "Tickets for this pot are closed";
    time.textContent = "Drawing soon";
    note.textContent = "The winner is picked a few blocks after closing. New tickets go into the next pot.";
    return;
  }
  label.textContent = "Tickets close in";
  if (isMock()) {
    time.textContent = plural(left, "block");
    note.textContent = "Demo chain: blocks only move when you mine them below.";
    return;
  }
  const secs = Math.max(0, Math.round((closeAt - Date.now()) / 1000));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), sec = secs % 60;
  time.textContent = h > 0 ? `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s` : `${m}m ${String(sec).padStart(2, "0")}s`;
  note.textContent = `About that long: the pot closes at block ${state.open.closeHeight.toLocaleString("en")}, and Zcash blocks come every 75 seconds on average.`;
}

/* ---------------- buy ---------------- */

function count() {
  const input = $<HTMLInputElement>("count");
  const n = Math.max(1, Math.min(500, Math.floor(Number(input.value) || 1)));
  if (document.activeElement !== input || String(n) !== input.value) input.value = String(n);
  return n;
}

function renderOdds() {
  const n = count();
  const t = state?.params.ticketZats ?? 1_000_000;
  $("price").textContent = zatsToZec(n * t);
  $("buy-go").textContent = `Get ${plural(n, "ticket")}`;
  document.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.pick) === n)));
  const odds = $("odds");
  odds.replaceChildren();
  const row = (k: string, v: string) => odds.append(el("dt", { textContent: k }), el("dd", { textContent: v }));
  row("Price", zec(n * t));
  if (!state) return;
  const s = state;
  const others = s.open.tickets;
  const have = myOpenIndexes().size;
  const feeShare = 1 - s.params.feeBps / 10_000;
  const fee = s.params.feePerActionZats ?? 5000;
  const prize = others > 0
    ? s.open.prizeIfDrawnZats + Math.floor(n * t * feeShare) - fee
    : s.open.potZats + Math.floor(n * t * feeShare) - 6 * fee;
  row("Prize if you win, about", zec(prize));
  row(others ? "Your chance if nobody else joins" : "Your chance right now", `${have + n} in ${others + n} (${pct(have + n, others + n)})`);
  const rf = s.raffles.find((r) => r.status === "open");
  if (rf) {
    const mine = myRaffleEntries(rf);
    row("Raffle chance", `${mine + n} in ${rf.tickets + n} (${pct(mine + n, rf.tickets + n)})`);
  }
}

function startBuy(e: Event) {
  e.preventDefault();
  if (!state) return toast("Pot data hasn’t loaded yet");
  const n = count();
  const key = newTicketKey(); // fresh key every purchase, so purchases can’t be linked
  const zats = n * state.params.ticketZats;
  const uri = zip321Uri(state.poolAddress, zats, ticketMemo(key.pk));
  pending = { key, n, uri };
  rememberCode(key.code);

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
  $("buy-panel").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" });
}

/* ---------------- latest draw, with one reveal ---------------- */

let revealing = false;
async function renderLatest(s: PublicState) {
  const last = [...s.rounds].reverse().find((r) => r.winner !== null);
  const box = $("latest");
  if (!last || last.winner === null) { box.hidden = true; return; }
  box.hidden = false;
  if (revealing) return;
  const status =
    last.status === "paid" ? "The prize has been paid."
      : last.status === "claimed" ? "The winner claimed it. Payment is on its way."
      : last.status === "expired" ? "Nobody claimed it, so it rolled into a later pot."
      : "Waiting for the winner to claim it.";
  const line = $("latest-line");
  line.replaceChildren(`Pot ${last.round}: ticket ${ticketNo(last.winner)} of ${last.tickets} took `, el("strong", { textContent: last.prizeZats !== null ? zec(last.prizeZats) : "the pot" }), `. ${status}`);

  const proof = $("latest-proof");
  try {
    const v = await verifyFull(rounds.get(last.round) ?? (await roundFile(last.round)));
    proof.replaceChildren(
      el("span", { className: v.ok ? "verified" : "failed", textContent: v.ok ? "Verified in your browser." : "This browser’s check failed." }),
      v.ok ? " It recomputed the ticket list, the winner from the block hash, and the prize split." : ` ${v.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}.`,
    );
  } catch {
    proof.textContent = "The round file isn’t available right now.";
  }

  const stubsBox = $("latest-slots");
  const N = last.tickets;
  const showStubs = N > 1 && N <= MAX_STUBS;
  const stubs = showStubs ? Array.from({ length: N }, () => el("div", { className: "slot dim" })) : [];
  stubsBox.replaceChildren(...stubs);
  stubsBox.hidden = !showStubs;
  const num = $("latest-n");
  const land = () => {
    stubs.forEach((d, i) => (d.className = "slot " + (i === last.winner ? "drawn" : "dim")));
    num.textContent = ticketNo(last.winner!);
  };
  if (store.get(REVEALED_KEY) === String(last.round) || reducedMotion() || N < 2) return land();

  // The one bit of motion on the page: run through the tickets and land on the drawn one.
  revealing = true;
  const total = (N > 12 ? 1 : 2) * N + last.winner;
  let k = 0;
  const step = () => {
    const i = k % N;
    stubs.forEach((d, j) => (d.className = "slot " + (j === i ? "lit" : "dim")));
    num.textContent = ticketNo(i);
    if (k++ >= total) {
      land();
      store.set(REVEALED_KEY, String(last.round));
      revealing = false;
      return;
    }
    const left = total - k;
    setTimeout(step, left < 6 ? 90 + (6 - left) * 70 : Math.max(18, 900 / total));
  };
  step();
}

/* ---------------- treasury + past ---------------- */

function renderTreasury(s: PublicState) {
  const t = s.treasury;
  const bal = t.balanceZats ?? 0;
  const target = t.sweepTargetZats;
  const p = target ? Math.min(100, Math.round((bal / target) * 100)) : 0;
  $("tr-fill").style.width = `${p}%`;
  $("tr-bar").setAttribute("aria-valuenow", String(p));
  $("tr-nums").textContent = target
    ? `${zec(bal)} saved of ${zec(target)}: the cheapest zkSNARK (${s.floorZats ? zec(s.floorZats) : "price unknown"}) plus 5% headroom.`
    : `${zec(bal)} saved. The zkSNARK floor price is unavailable right now.`;
  const held = $("tr-snarks");
  held.replaceChildren();
  if (t.snarks.length === 0) held.textContent = "None yet";
  for (const id of t.snarks) {
    held.append(el("a", { href: `https://zilkroad.com/explorer/${id}`, target: "_blank", rel: "noopener noreferrer", textContent: `zkSNARK #${id}` }), " ");
  }
  const open = s.raffles.find((r) => r.status === "open");
  $("tr-next").textContent = open
    ? `zkSNARK #${open.snarkId} is being raffled right now.${t.snarks.length ? " The next one is raffled after it." : ""}`
    : t.snarks.length
      ? "Its raffle opens soon. Every ticket bought while it runs is entered."
      : "The next raffle opens once the treasury has bought a zkSNARK.";
  $("tr-key").textContent = t.viewingKey;
}

async function renderRafflePast(s: PublicState) {
  const done = s.raffles.filter((r) => r.status !== "open").slice(-10).reverse();
  const rows = await Promise.all(done.map(async (r) => {
    const what = el("span");
    const badge = el("span");
    if (r.status === "empty") what.textContent = `zkSNARK #${r.snarkId}: no tickets, so it went back to the treasury`;
    else if (r.winner === null) what.textContent = `zkSNARK #${r.snarkId}: ${plural(r.tickets, "ticket")}, waiting for the draw block`;
    else {
      const tail = r.status === "delivered" ? "delivered" : r.status === "claimed" ? "being delivered" : r.status === "expired" ? "unclaimed, back to the treasury" : "waiting for the winner to claim";
      what.textContent = `zkSNARK #${r.snarkId} to ticket ${ticketNo(r.winner)} of ${r.tickets}, ${tail}`;
      try {
        const v = verifyRaffle(await raffleFile(r.raffle));
        badge.className = v.ok ? "verified" : "failed";
        badge.textContent = v.ok ? "Verified" : "Check failed";
        badge.title = v.checks.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.name}: ${c.detail}`).join("\n");
      } catch {
        badge.className = "failed";
        badge.textContent = "Raffle file missing";
      }
    }
    return el("li", {}, el("span", { className: "n", textContent: `Raffle ${r.raffle}` }), what, badge);
  }));
  $("raffle-past").replaceChildren(...rows);
}

/* ---------------- the zkSNARK raffle card ---------------- */

let raffleCloseAt = 0;
let raffleShown = "";
async function renderRaffle(s: PublicState) {
  const r = featuredRaffle(s);
  const box = $("raffle");
  if (!r) { box.hidden = true; return; }
  box.hidden = false;
  const key = `${r.raffle}:${r.snark?.image ?? ""}`;
  if (key !== raffleShown) {
    raffleShown = key;
    const img = $<HTMLImageElement>("raffle-img");
    img.hidden = !r.snark?.image;
    if (r.snark?.image) { img.src = r.snark.image; img.alt = r.snark.name; }
    $("raffle-ph").textContent = `#${r.snarkId}`;
    $("raffle-traits").replaceChildren(...(r.snark?.traits ?? []).map((t) => el("li", {}, `${t.trait} `, el("b", { textContent: t.value }))));
  }
  const open = r.status === "open";
  $("raffle-kicker").textContent = open ? `zkSNARK raffle ${r.raffle}, open now` : `zkSNARK raffle ${r.raffle}`;
  $("raffle-h").textContent = open ? `Win zkSNARK #${r.snarkId}` : `zkSNARK #${r.snarkId}`;
  const mine = open ? myRaffleEntries(r) : 0;
  const sub = $("raffle-sub");
  sub.replaceChildren();
  const proof = $("raffle-proof");
  proof.replaceChildren();
  $("raffle-clock-box").hidden = !(open || r.status === "closed");
  if (open) {
    sub.append(
      "Every ticket you buy before the raffle closes is also entered here, on top of the daily ZEC draw. ",
      el("strong", { textContent: `${plural(r.tickets, "ticket")} entered so far` }),
      mine ? `, ${mine} of them yours.` : ".",
    );
    const left = r.closeHeight - s.scannedHeight;
    if (!isMock()) {
      const est = Date.now() + left * BLOCK_SECONDS * 1000;
      if (!raffleCloseAt || Math.abs(est - raffleCloseAt) > 90_000) raffleCloseAt = est;
    }
  } else if (r.status === "closed") {
    sub.append(`Closed with ${plural(r.tickets, "ticket")}. The winner is picked a few blocks later.`);
  } else if (r.winner !== null) {
    const tail = r.status === "delivered" ? "It has been delivered." : r.status === "claimed" ? "The winner claimed it; it’s being delivered." : r.status === "expired" ? "Nobody claimed it, so it went back to the treasury." : "Waiting for the winner to claim it.";
    sub.append(`Ticket ${ticketNo(r.winner)} of ${r.tickets} won it. ${tail}`);
    try {
      const v = verifyRaffle(raffles.get(r.raffle) ?? (await raffleFile(r.raffle)));
      proof.append(el("span", { className: v.ok ? "verified" : "failed", textContent: v.ok ? "Verified in your browser." : "This browser’s check failed." }), v.ok ? " It recomputed the entry list and the winner from the block hash." : "");
    } catch { /* file not published yet */ }
  }
  tickRaffleClock();
}

function myRaffleEntries(r: RaffleSummary) {
  const rec = raffles.get(r.raffle);
  if (!rec) return 0;
  const pks = new Set(deviceKeys().map((k) => k.pk));
  return rec.tickets.filter((l) => pks.has(pkOf(l))).length;
}

function tickRaffleClock() {
  if (!state) return;
  const r = featuredRaffle(state);
  if (!r || $("raffle-clock-box").hidden) return;
  const label = $("raffle-clock-label");
  const time = $("raffle-clock");
  const left = r.closeHeight - state.scannedHeight;
  if (r.status !== "open" || left <= 0) { label.textContent = "Raffle closed"; time.textContent = "Drawing soon"; return; }
  label.textContent = "Raffle closes in";
  if (isMock()) { time.textContent = plural(left, "block"); return; }
  const secs = Math.max(0, Math.round((raffleCloseAt - Date.now()) / 1000));
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60), sec = secs % 60;
  time.textContent = d > 0 ? `${d}d ${h}h ${String(m).padStart(2, "0")}m` : h > 0 ? `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s` : `${m}m ${String(sec).padStart(2, "0")}s`;
}

async function renderPast(s: PublicState) {
  const done = s.rounds.filter((r) => r.status !== "open").slice(-10).reverse();
  const list = $("past");
  if (done.length === 0) {
    list.replaceChildren(el("li", { className: "none", textContent: "No pot has been drawn yet. The first draw happens when today’s pot closes." }));
    return;
  }
  const rows = await Promise.all(
    done.map(async (r) => {
      const what = el("span");
      const badge = el("span");
      if (r.status === "rolled") what.textContent = "No tickets, so it rolled into the next day";
      else if (r.winner === null) what.textContent = `${plural(r.tickets, "ticket")}, waiting for the draw block`;
      else {
        const tail = r.status === "paid" ? "paid" : r.status === "claimed" ? "being paid" : r.status === "expired" ? "unclaimed, rolled into a later pot" : "waiting for the winner to claim";
        what.textContent = `Ticket ${ticketNo(r.winner)} of ${r.tickets} won ${r.prizeZats !== null ? zec(r.prizeZats) : "the pot"}, ${tail}`;
        try {
          const v = await verifyFull(await roundFile(r.round));
          badge.className = v.ok ? "verified" : "failed";
          badge.textContent = v.ok ? "Verified" : "Check failed";
          badge.title = v.checks.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.name}: ${c.detail}`).join("\n");
        } catch {
          badge.className = "failed";
          badge.textContent = "Round file missing";
        }
      }
      return el("li", {}, el("span", { className: "n", textContent: `Pot ${r.round}` }), what, badge);
    }),
  );
  list.replaceChildren(...rows);
}

/* ---------------- your tickets ---------------- */

interface Found {
  round: number;
  head: string;
  tag: string;
  won: boolean;
  detail: (string | Node)[];
  /** A win that still needs claiming: shown as a banner too */
  banner?: HTMLElement;
}

function scan(keys: TicketKey[], recs: RoundRecord[]): Found[] {
  const byPk = new Map(keys.map((k) => [k.pk, k]));
  const out: Found[] = [];
  for (const r of [...recs].sort((a, b) => b.round - a.round)) {
    for (const w of r.withdrawn ?? []) {
      const n = w.tickets.filter((l) => byPk.has(pkOf(l))).length;
      if (n) out.push({ round: r.round, head: `Pot ${r.round}`, tag: "withdrawn", won: false, detail: [`${plural(n, "ticket")} withdrawn. ${zec(w.amountZats)} ${w.txid ? "was sent" : "is being sent"} to the address you gave.`] });
    }
    const idx = r.tickets.map((l, i) => (byPk.has(pkOf(l)) ? i : -1)).filter((i) => i >= 0);
    if (idx.length) {
      const n = idx.length;
      const f: Found = { round: r.round, head: `Pot ${r.round}: ${plural(n, "ticket")}`, tag: "", won: false, detail: [] };
      const winKey = r.winner !== undefined ? byPk.get(pkOf(r.tickets[r.winner] ?? "")) : undefined;
      if (r.status === "open") {
        f.tag = "in today’s draw";
        f.detail.push(`That’s ${n} of the ${r.tickets.length} tickets so far.`);
        const carried = idx.filter((i) => i < (r.carriedCount ?? 0));
        for (const k of keys) {
          const c = carried.filter((i) => pkOf(r.tickets[i]!) === k.pk).length;
          if (c) f.detail.push(el("p", { textContent: `${plural(c, "ticket")} rolled in from an earlier pot.` }), withdrawForm(k, r, c));
        }
      } else if (r.status === "rolled") {
        continue; // shown in the pot they rolled into
      } else if (r.status === "closed") {
        f.tag = "drawing soon";
        f.detail.push("The winner is picked a few blocks after the pot closed.");
      } else if (!winKey) {
        f.tag = "not this time";
        f.detail.push(`Ticket ${ticketNo(r.winner!)} of ${r.tickets.length} won.`);
      } else {
        const amount = r.split!.prizeZats;
        f.won = true;
        f.tag = r.status === "drawn" ? "you won" : r.status === "claimed" ? "won, being paid" : r.status === "paid" ? "won, paid" : "won, unclaimed";
        f.head = `Pot ${r.round}: you won ${zec(amount)}`;
        if (r.status === "drawn") {
          f.detail.push(`Your ticket ${ticketNo(r.winner!)} was drawn. Claim it at the top of the page.`);
          f.banner = el("section", { className: "win" },
            el("h2", { textContent: `You won pot ${r.round}` }),
            el("p", { textContent: `Ticket ${ticketNo(r.winner!)} of ${r.tickets.length} is yours. Claim ${zec(amount)} to a shielded address within 14 days.` }),
            prizeForm(winKey, r));
        }
        if (r.status === "claimed") f.detail.push("Claimed. The ZEC is on its way to the address you gave.");
        if (r.status === "paid") f.detail.push(`Paid${r.claim?.txid ? ` in transaction ${r.claim.txid.slice(0, 10)}…` : ""}.`);
        if (r.status === "expired") f.detail.push("The 14-day claim window closed, so the prize rolled into a later pot.");
      }
      out.push(f);
    }
  }
  return out;
}

/** Raffle entries and wins for these ticket codes. */
function scanRaffles(keys: TicketKey[], recs: RaffleRecord[]): Found[] {
  const byPk = new Map(keys.map((k) => [k.pk, k]));
  const out: Found[] = [];
  for (const r of [...recs].sort((a, b) => b.raffle - a.raffle)) {
    const n = r.tickets.filter((l) => byPk.has(pkOf(l))).length;
    if (!n) continue;
    const k = r.winner !== undefined ? byPk.get(pkOf(r.tickets[r.winner] ?? "")) : undefined;
    const f: Found = { round: -r.raffle, head: `zkSNARK #${r.snarkId} raffle: ${n} ${n === 1 ? "entry" : "entries"}`, tag: "", won: false, detail: [] };
    if (r.status === "open") { f.tag = "in the raffle"; f.detail.push(`That’s ${n} of the ${r.tickets.length} entries so far.`); }
    else if (r.status === "closed") { f.tag = "drawing soon"; f.detail.push("The winner is picked a few blocks after the raffle closed."); }
    else if (!k) { f.tag = "not this time"; if (r.winner !== undefined) f.detail.push(`Ticket ${ticketNo(r.winner)} of ${r.tickets.length} won it.`); }
    else {
      f.won = true;
      f.head = `You won zkSNARK #${r.snarkId}`;
      f.tag = r.status === "drawn" ? "you won" : r.status === "claimed" ? "won, being delivered" : r.status === "delivered" ? "won, delivered" : "won, unclaimed";
      if (r.status === "drawn") {
        f.detail.push("Claim it at the top of the page with a Zilkroad account ID.");
        f.banner = el("section", { className: "win" },
          el("h2", { textContent: `You won zkSNARK #${r.snarkId}` }),
          el("p", { textContent: `Your ticket ${ticketNo(r.winner!)} of ${r.tickets.length} won raffle ${r.raffle}. Claim it to your Zilkroad account within 14 days.` }),
          raffleForm(k, r));
      }
      if (r.status === "claimed") f.detail.push("Claimed. It’s being transferred to your Zilkroad account.");
      if (r.status === "delivered") f.detail.push("Delivered to your Zilkroad account.");
      if (r.status === "expired") f.detail.push("The claim window closed, so it went back to the treasury.");
    }
    out.push(f);
  }
  return out;
}

async function raffleRecords(s: PublicState) {
  return (await Promise.all(s.raffles.slice(-10).map((r) => raffleFile(r.raffle).catch(() => null)))).filter((r): r is RaffleRecord => !!r);
}

async function recentRecords(s: PublicState) {
  return (await Promise.all(s.rounds.slice(-30).map((r) => roundFile(r.round).catch(() => null)))).filter((r): r is RoundRecord => !!r);
}

function foundList(found: Found[]) {
  return el("ul", { className: "mine-list" }, ...found.map((f) => {
    const li = el("li", {},
      el("div", { className: "head" }, el("strong", { textContent: f.head }), el("span", { className: "tag" + (f.won ? " won" : ""), textContent: f.tag })));
    for (const d of f.detail) li.append(typeof d === "string" ? el("p", { textContent: d }) : d);
    return li;
  }));
}

async function renderDevice(s: PublicState, force = false) {
  const keys = deviceKeys();
  const sig = JSON.stringify([keys.length, s.rounds.map((r) => [r.round, r.status, r.tickets]), s.raffles.map((r) => [r.raffle, r.status, r.tickets])]);
  if (!force && sig === deviceSig) return;
  // Don't wipe a claim form someone is filling in; try again on the next refresh
  const typing = Array.from(document.querySelectorAll<HTMLInputElement>("#wins input, #device-out input")).some((i) => i.value || i === document.activeElement);
  if (!force && typing && deviceSig && !claimedJustNow) return;
  claimedJustNow = false;
  deviceSig = sig;
  const out = $("device-out");
  if (keys.length === 0) {
    out.replaceChildren(el("p", { className: "empty-yours", textContent: "Tickets you buy in this browser show up here, with any wins ready to claim. Nothing is sent anywhere: the check runs on this device." }));
    $("wins").replaceChildren();
    return;
  }
  const [rr, fr] = await Promise.all([recentRecords(s), raffleRecords(s)]);
  const found = [...scanRaffles(keys, fr), ...scan(keys, rr)];
  $("wins").replaceChildren(...found.filter((f) => f.banner).map((f) => f.banner!));

  const tools = el("div", { className: "device-tools" },
    el("button", { type: "button", className: "link", textContent: "Copy all ticket codes", onclick: () => copy(deviceCodes().join("\n"), "Ticket codes") }),
    el("button", { type: "button", className: "link", textContent: "Forget them on this device", onclick: () => {
      if (!confirmForget()) return;
      store.del(CODES_KEY);
      renderDevice(s, true);
      refresh();
    } }));
  if (found.length === 0) {
    out.replaceChildren(el("p", { className: "empty-yours", textContent: `This browser has ${plural(keys.length, "ticket code")}, but no payment for ${keys.length === 1 ? "it" : "them"} has arrived yet. A payment shows up a few minutes after it’s mined.` }), tools);
    return;
  }
  out.replaceChildren(foundList(found.map((f) => (f.banner ? { ...f, detail: f.detail.slice(0, 1) } : f))), tools);
}

let forgetArmed = 0;
function confirmForget() {
  // Two clicks instead of a browser dialog
  if (Date.now() - forgetArmed < 5000) return true;
  forgetArmed = Date.now();
  toast("Save your codes first. Click again to forget them.");
  return false;
}

async function checkPasted(e: Event) {
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
  const [rr, fr] = await Promise.all([recentRecords(state), raffleRecords(state)]);
  const found = [...scanRaffles([key], fr), ...scan([key], rr)];
  if (found.length === 0) {
    out.append(el("p", { className: "fine", textContent: "No tickets for this code yet. A payment shows up a few minutes after it’s mined." }));
    return;
  }
  out.append(foundList(found.map((f) => (f.banner ? { ...f, detail: [...f.detail, f.banner.querySelector("form")!] } : f))));
  const add = el("button", { type: "button", className: "link", textContent: "Remember this code on this device", onclick: () => { rememberCode(key.code); toast("Saved in this browser"); renderDevice(state!, true); renderHero(state!); renderOdds(); } });
  out.append(add);
}

/* ---------------- claim forms ---------------- */

function withdrawForm(key: TicketKey, r: RoundRecord, n: number) {
  const amount = withdrawAmountZats(n, r.params);
  const fee = withdrawFeeZats(n, r.params);
  const id = `wto${++formSeq}`;
  const f = el("form", { className: "claim" });
  f.innerHTML = `
    <p class="hint">Do nothing and ${n === 1 ? "it stays" : "they stay"} in. Or take your ZEC back before block ${r.closeHeight.toLocaleString("en")}:
    <strong>${zec(amount)}</strong> (${zec(n * r.params.ticketZats)} minus a ${zec(fee)} network fee).</p>
    <label for="${id}">Shielded address to receive it. A fresh one keeps the refund unlinked from your other payments.</label>
    <div class="inline"><input id="${id}" placeholder="u1…" autocomplete="off" spellcheck="false" />
    <button type="submit">Withdraw ${zec(amount)}</button></div>
    <p class="msg" aria-live="polite"></p>`;
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = f.querySelector(".msg")!;
    const to = (f.querySelector("input") as HTMLInputElement).value.trim();
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
  const id = `pto${++formSeq}`;
  const f = el("form", { className: "claim prize" });
  f.innerHTML = `
    <label for="${id}">Your shielded address. A fresh one keeps this win unlinked from your other payments. Only a hash of it is published.</label>
    <div class="inline"><input id="${id}" class="pto" placeholder="u1…" autocomplete="off" spellcheck="false" />
    <button type="submit" class="primary">Claim ${zec(amount)}</button></div>
    <p class="msg" aria-live="polite"></p>`;
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = f.querySelector(".msg")!;
    const to = (f.querySelector("input") as HTMLInputElement).value.trim();
    try {
      const sig = signClaim(key.code, r.round, r.winner!, to, amount); // signed here; the code never leaves the browser
      const res = await post("/api/claim", { round: r.round, ticket: r.winner, to, sig });
      msg.textContent = res.ok ? `Claimed. ${zec(amount)} will arrive within a few minutes.` : `Claim not accepted: ${res.error}.`;
      if (res.ok) { f.querySelector("button")!.disabled = true; setTimeout(() => { deviceSig = ""; claimedJustNow = true; refresh(); }, 2500); }
    } catch (err) {
      msg.textContent = `Claim not accepted: ${(err as Error).message}.`;
    }
  });
  return f;
}

function raffleForm(key: TicketKey, r: RaffleRecord) {
  const id = `rto${++formSeq}`;
  const f = el("form", { className: "claim raffle-claim" });
  f.innerHTML = `
    <label for="${id}">Zilkroad account ID to send zkSNARK #${r.snarkId} to. A fresh account keeps this win separate from anything else you own.</label>
    <div class="inline"><input id="${id}" class="rto" placeholder="ZR-7K4Q-M2XD" autocomplete="off" spellcheck="false" />
    <button type="submit" class="primary">Claim zkSNARK #${r.snarkId}</button></div>
    <p class="msg" aria-live="polite"></p>`;
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = f.querySelector(".msg")!;
    const to = (f.querySelector("input") as HTMLInputElement).value.trim().toUpperCase();
    try {
      const sig = signRaffleClaim(key.code, r.raffle, r.winner!, to, r.snarkId); // signed here; the code never leaves the browser
      const res = await post("/api/raffle-claim", { raffle: r.raffle, ticket: r.winner, to, sig });
      msg.textContent = res.ok ? `Claimed. zkSNARK #${r.snarkId} will arrive in ${to} soon.` : `Claim not accepted: ${res.error}.`;
      if (res.ok) { f.querySelector("button")!.disabled = true; setTimeout(() => { deviceSig = ""; claimedJustNow = true; refresh(); }, 2500); }
    } catch (err) {
      msg.textContent = `Claim not accepted: ${(err as Error).message}.`;
    }
  });
  return f;
}

/* ---------------- refresh loop ---------------- */

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await getJSON<PublicState>("/data/state.json");
    openRec = await roundFile(state.open.round).catch(() => null);
    const live = state.raffles.find((r) => r.status === "open");
    if (live) await raffleFile(live.raffle).catch(() => null);
    renderHero(state);
    renderOdds();
    renderTreasury(state);
    await Promise.all([renderRaffle(state), renderLatest(state), renderPast(state), renderRafflePast(state), renderDevice(state)]);
  } catch {
    $("hero-sub").textContent = "Can’t reach the pot data right now. Retrying.";
  } finally {
    refreshing = false;
  }
}

/* ---------------- wire up ---------------- */

document.addEventListener("DOMContentLoaded", () => {
  const setCount = (n: number) => { $<HTMLInputElement>("count").value = String(n); renderOdds(); };
  $("minus").addEventListener("click", () => setCount(count() - 1));
  $("plus").addEventListener("click", () => setCount(count() + 1));
  document.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach((b) => b.addEventListener("click", () => setCount(Number(b.dataset.pick))));
  $("count").addEventListener("input", renderOdds);
  $("count").addEventListener("blur", () => { count(); renderOdds(); });
  $("buy-form").addEventListener("submit", startBuy);
  $("saved").addEventListener("change", (e) => $("pay-step").classList.toggle("locked", !(e.target as HTMLInputElement).checked));
  $("copy-code").addEventListener("click", () => pending && copy(pending.key.code, "Ticket code"));
  $("download-code").addEventListener("click", () => {
    if (!pending) return;
    const blob = new Blob([`zecPOT ticket code (keep this private: whoever has it can claim the win)\n${pending.key.code}\n\nTickets: ${pending.n}\n`], { type: "text/plain" });
    const a = el("a", { href: URL.createObjectURL(blob), download: "zecpot-ticket.txt" });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("copy-uri").addEventListener("click", () => pending && copy(pending.uri, "Payment link"));
  $("copy-viewing-key").addEventListener("click", () => state && copy(state.viewingKey, "Pot viewing key"));
  $("copy-tr-key").addEventListener("click", () => state && copy(state.treasury.viewingKey, "Treasury viewing key"));
  $("check-form").addEventListener("submit", checkPasted);

  $("mock-pay").addEventListener("click", async () => {
    if (!pending || !state) return;
    await post("/api/mock/pay", { zats: pending.n * state.params.ticketZats, memo: ticketMemo(pending.key.pk) });
    toast("Payment mined on the demo chain");
    $("buy-panel").hidden = true;
    await refresh();
    document.querySelector(".hero")!.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" });
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
  $("mock-raffle").addEventListener("click", async () => {
    const r = await post("/api/mock/raffle", {});
    toast(r.ok ? "Raffle opened on the demo chain" : `Couldn’t open a raffle: ${r.error}`);
    await refresh();
  });
  $("mock-gift").addEventListener("click", async () => { await post("/api/mock/treasury", {}); toast("Treasury topped up on the demo chain"); await refresh(); });

  // Swap default: the tickets on the ticket + 0.0002 ZEC for the fee on the payment to the pot.
  initSwap({ defaultZats: () => count() * (state?.params.ticketZats ?? 1_000_000) + 20_000, toast });

  renderOdds();
  refresh();
  setInterval(refresh, 10_000);
  setInterval(() => { tickClock(); tickRaffleClock(); }, 1000);
});

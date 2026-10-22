// Ends ONE Zilkroad session: the one whose cookie is in ZILKROAD_COOKIE. Never prints the cookie.
// Use it to kill a cookie that leaked, without touching your current session:
//   ZILKROAD_COOKIE="$(sed -n "s/^ZILKROAD_COOKIE=//p" .env.save | tr -d "'\"")" node tools/zilkroad-logout.mjs
const cookie = process.env.ZILKROAD_COOKIE;
if (!cookie || !/zr_session=/.test(cookie)) {
  console.log("ZILKROAD_COOKIE is empty or has no zr_session part; nothing to sign out.");
  process.exit(1);
}
const ua = process.env.ZILKROAD_USER_AGENT;
const headers = {
  accept: "application/json",
  "content-type": "application/json",
  origin: "https://zilkroad.com",
  referer: "https://zilkroad.com/account",
  cookie,
  ...(ua ? { "user-agent": ua } : {}),
};
const me = async () => {
  const r = await fetch("https://zilkroad.com/api/me", { headers });
  if (!r.ok) return { status: r.status, accountId: null };
  const j = await r.json().catch(() => ({}));
  return { status: r.status, accountId: j.accountId ?? null };
};
try {
  const before = await me();
  if (!before.accountId) {
    console.log(`That session is already dead (HTTP ${before.status}, not signed in). Nothing to do.`);
    process.exit(0);
  }
  const out = await fetch("https://zilkroad.com/api/auth/logout", { method: "POST", headers, body: "{}" });
  console.log(`Sign-out request: HTTP ${out.status}`);
  const after = await me();
  if (after.accountId) {
    console.log("That session STILL works. Don't continue; tell Claude this output.");
    process.exit(1);
  }
  console.log("Done: that cookie no longer signs in.");
} catch (e) {
  console.log("Request failed (" + (e.name || "error") + "). Nothing was printed from the cookie.");
  process.exit(1);
}

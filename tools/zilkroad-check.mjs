// Checks the Zilkroad session in ZILKROAD_COOKIE without printing the cookie.
//   set -a; source .env; set +a; node tools/zilkroad-check.mjs
const cookie = process.env.ZILKROAD_COOKIE;
if (!cookie) {
  console.log("ZILKROAD_COOKIE is empty. Run: set -a; source .env; set +a");
  process.exit(1);
}
// Sanity-check the shape first, so a bad paste is explained without ever printing the value.
const names = cookie.split(";").map((p) => p.trim().split("=")[0]);
const problems = [];
if (/["'\u2018\u2019\u201c\u201d]/.test(cookie)) problems.push("it contains quote marks: remove them");
if (!names.includes("cf_clearance")) problems.push("there is no cf_clearance= part");
if (!names.includes("zr_session")) problems.push("there is no zr_session= part (add '; zr_session=VALUE')");
if (/[^\x20-\x7e]/.test(cookie)) problems.push("it contains a line break or a non-ASCII character");
if (problems.length) {
  console.log("ZILKROAD_COOKIE looks wrong: " + problems.join("; ") + ".");
  console.log("It should be one line: ZILKROAD_COOKIE=cf_clearance=VALUE; zr_session=VALUE");
  process.exit(1);
}
const ua = process.env.ZILKROAD_USER_AGENT;
try {
  const res = await fetch("https://zilkroad.com/api/me", { headers: { accept: "application/json", cookie, ...(ua ? { "user-agent": ua } : {}) } });
  const text = await res.text();
  if (!res.ok) {
    console.log(`Zilkroad said HTTP ${res.status}.${res.status === 403 ? " Cloudflare may want ZILKROAD_USER_AGENT set to your browser's navigator.userAgent." : ""}`);
    process.exit(1);
  }
  const me = JSON.parse(text);
  console.log("account:", me.accountId ?? "(not signed in)", "| canTrade:", me.canTrade, "| canTransfer:", me.canTransfer);
  process.exit(me.accountId && me.canTrade && me.canTransfer ? 0 : 1);
} catch (e) {
  // Never print e.message here: Node includes the header value in some errors.
  console.log("Request failed (" + (e.name || "error") + "). Check the ZILKROAD_COOKIE and ZILKROAD_USER_AGENT lines in .env.");
  process.exit(1);
}

// Bundles the web app and copies the self-hosted font. No CDN, no third-party requests.
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "public");

await mkdir(join(pub, "fonts"), { recursive: true });
await copyFile(
  join(here, "../../node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2"),
  join(pub, "fonts/bricolage.woff2"),
);

await build({
  entryPoints: [join(here, "src/main.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
  outfile: join(pub, "app.js"),
  logLevel: "info",
});

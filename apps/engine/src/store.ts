import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Engine, EngineState } from "./engine.ts";

async function atomicWrite(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export async function loadState(path: string): Promise<EngineState | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as EngineState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function saveState(path: string, s: EngineState) {
  await atomicWrite(path, JSON.stringify(s, null, 2));
}

/** Writes the public files the website and verifiers read. */
export async function publish(dataDir: string, engine: Engine) {
  await atomicWrite(join(dataDir, "state.json"), JSON.stringify(engine.publicState(), null, 2));
  for (const r of engine.state.rounds) {
    await atomicWrite(join(dataDir, "rounds", `${r.round}.json`), JSON.stringify(engine.publicRound(r), null, 2));
  }
}

/**
 * Peers directory I/O for multipi: registry entries, inboxes, liveness sweep,
 * target resolution. Pure node:fs, no pi imports, so it is unit-testable.
 * Layout: <root>/<pid>.json, <root>/<pid>/inbox/<msg_id>.json.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RegistryEntry {
  v: 1;
  pid: number;
  name: string;
  sessionId: string;
  sessionFile: string | null;
  cwd: string;
  status: "idle" | "busy";
  startedAt: number;
  updatedAt: number;
}

export interface Frame {
  v: 1;
  msg_id: string;
  from: string;
  fromPid: number;
  fromSessionId: string;
  to: string;
  body: string;
  ts: number;
}

export function defaultRoot(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "peers");
}

export function inboxDir(root: string, pid: number): string {
  return join(root, String(pid), "inbox");
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sanitise(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return s || "pi";
}

/** Append -2, -3, ... until the name is unique among `others`. */
export function uniqueName(base: string, others: RegistryEntry[]): string {
  const taken = new Set(others.map((p) => p.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function ensureInbox(root: string, pid: number): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(inboxDir(root, pid), { recursive: true, mode: 0o700 });
}

function writeAtomic(dir: string, name: string, data: unknown): void {
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, join(dir, `${name}.json`));
}

export function writeEntry(root: string, entry: RegistryEntry): void {
  entry.updatedAt = Date.now();
  writeAtomic(root, String(entry.pid), entry);
}

/** Remove this pid's entry and inbox. Idempotent. */
export function removeEntry(root: string, pid: number): void {
  rmSync(join(root, `${pid}.json`), { force: true });
  rmSync(join(root, String(pid)), { recursive: true, force: true });
}

function tryParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Live registry entries, including self if registered. Sweeps dead peers as a side effect. */
export function listPeers(root: string): RegistryEntry[] {
  if (!existsSync(root)) return [];
  const live: RegistryEntry[] = [];
  for (const f of readdirSync(root)) {
    const pid = Number.parseInt(f.endsWith(".json") ? f.slice(0, -5) : f, 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!isAlive(pid)) {
      removeEntry(root, pid);
      continue;
    }
    if (!f.endsWith(".json")) continue;
    const entry = tryParse<RegistryEntry>(readFileSync(join(root, f), "utf8"));
    if (entry && entry.v === 1) live.push(entry);
  }
  return live.sort((a, b) => a.name.localeCompare(b.name));
}

const shortId = (p: RegistryEntry) => p.sessionId.slice(0, 8);

/** Resolve `to`: self check, exact name, then a >=4 char sessionId prefix. Throws with the exact error strings. */
export function resolveTarget(to: string, self: Pick<RegistryEntry, "name" | "sessionId">, others: RegistryEntry[]): RegistryEntry {
  const isPrefix = (p: Pick<RegistryEntry, "sessionId">) => to.length >= 4 && p.sessionId.startsWith(to);
  if (to === self.name || isPrefix(self)) throw new Error(`"${to}" is this session. Pick another session.`);
  const exact = others.find((p) => p.name === to);
  if (exact) return exact;
  const byId = others.filter(isPrefix);
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) {
    throw new Error(`"${to}" is ambiguous: matches ${byId.map((p) => `${p.name} [${shortId(p)}]`).join(", ")}. Use a longer id prefix.`);
  }
  throw new Error(`No live pi session matches "${to}". Call list_sessions to see who is running.`);
}

/** Drop a frame into a peer's inbox: write .<id>.tmp, rename to <id>.json. */
export function writeFrame(root: string, target: RegistryEntry, frame: Frame): void {
  const inbox = inboxDir(root, target.pid);
  if (!existsSync(inbox)) throw new Error(`Session ${target.name} is shutting down (inbox missing). Try list_sessions again.`);
  writeAtomic(inbox, frame.msg_id, frame);
}

/** Table used by list_sessions and /peers. `others` excludes self. */
export function formatTable(selfName: string, others: RegistryEntry[]): string {
  if (others.length === 0) return `This session is ${selfName}. No other pi sessions are running.`;
  const w = Math.max(4, ...others.map((p) => p.name.length));
  const rows = others.map((p) => `${p.name.padEnd(w)}  ${shortId(p)}  ${p.status.padEnd(6)}  ${p.cwd}`);
  return `This session is ${selfName}.\n\n${"name".padEnd(w)}  ${"id".padEnd(8)}  status  cwd\n${rows.join("\n")}`;
}

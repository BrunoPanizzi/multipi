import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureInbox,
  formatTable,
  inboxDir,
  listPeers,
  type RegistryEntry,
  removeEntry,
  resolveTarget,
  sanitise,
  uniqueName,
  writeEntry,
  writeFrame,
  type Frame,
} from "../src/registry.ts";

function entry(over: Partial<RegistryEntry>): RegistryEntry {
  return {
    v: 1,
    pid: process.pid,
    name: "me",
    sessionId: "0123456789abcdef",
    sessionFile: null,
    cwd: "/tmp",
    status: "idle",
    startedAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** A pid that has definitely exited. */
function deadPid(): number {
  const r = spawnSync("true");
  return r.pid;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "multipi-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("register / list / sweep", () => {
  it("registers self and lists it", () => {
    ensureInbox(root, process.pid);
    writeEntry(root, entry({ name: "alpha" }));
    expect(existsSync(inboxDir(root, process.pid))).toBe(true);
    const peers = listPeers(root);
    expect(peers.map((p) => p.name)).toEqual(["alpha"]);
    expect(peers[0].updatedAt).toBeGreaterThan(1);
  });

  it("sweeps dead peers and their inbox dirs", () => {
    const dead = deadPid();
    ensureInbox(root, dead);
    writeEntry(root, entry({ pid: dead, name: "ghost" }));
    ensureInbox(root, process.pid);
    writeEntry(root, entry({ name: "alive" }));
    expect(listPeers(root).map((p) => p.name)).toEqual(["alive"]);
    expect(existsSync(join(root, `${dead}.json`))).toBe(false);
    expect(existsSync(join(root, String(dead)))).toBe(false);
  });

  it("removeEntry is idempotent", () => {
    ensureInbox(root, process.pid);
    writeEntry(root, entry({}));
    removeEntry(root, process.pid);
    removeEntry(root, process.pid);
    expect(listPeers(root)).toEqual([]);
  });

  it("returns [] when the root does not exist", () => {
    expect(listPeers(join(root, "nope"))).toEqual([]);
  });
});

describe("resolveTarget", () => {
  const self = { name: "me", sessionId: "aaaa1111bbbb2222" };
  const a = entry({ pid: 1, name: "bruno-db", sessionId: "af32f751deadbeef" });
  const b = entry({ pid: 2, name: "scratch-91ce", sessionId: "af3299990000ffff" });
  const others = [a, b];

  it("exact name", () => expect(resolveTarget("bruno-db", self, others)).toBe(a));
  it("unique id prefix", () => expect(resolveTarget("af32f", self, others)).toBe(a));
  it("ambiguous prefix", () =>
    expect(() => resolveTarget("af32", self, others)).toThrow(
      '"af32" is ambiguous: matches bruno-db [af32f751], scratch-91ce [af329999]. Use a longer id prefix.',
    ));
  it("self by name and by id", () => {
    expect(() => resolveTarget("me", self, others)).toThrow('"me" is this session. Pick another session.');
    expect(() => resolveTarget("aaaa1", self, others)).toThrow('"aaaa1" is this session. Pick another session.');
  });
  it("short prefix and name prefix are not tried", () => {
    expect(() => resolveTarget("af3", self, others)).toThrow(
      'No live pi session matches "af3". Call list_sessions to see who is running.',
    );
    expect(() => resolveTarget("bruno", self, others)).toThrow('No live pi session matches "bruno"');
  });
  it("dead pid is swept before resolution", () => {
    const dead = deadPid();
    ensureInbox(root, dead);
    writeEntry(root, entry({ pid: dead, name: "ghost" }));
    expect(() => resolveTarget("ghost", self, listPeers(root))).toThrow('No live pi session matches "ghost"');
  });
});

describe("writeFrame", () => {
  const frame: Frame = { v: 1, msg_id: "m1", from: "me", fromPid: 1, fromSessionId: "x", to: "you", body: "hi", ts: 1 };
  it("lands as <msg_id>.json with no tmp left behind", () => {
    ensureInbox(root, process.pid);
    writeFrame(root, entry({}), frame);
    const inbox = inboxDir(root, process.pid);
    expect(JSON.parse(readFileSync(join(inbox, "m1.json"), "utf8"))).toEqual(frame);
    expect(existsSync(join(inbox, ".m1.tmp"))).toBe(false);
  });
  it("errors when the inbox is missing", () => {
    expect(() => writeFrame(root, entry({ pid: 99999999, name: "gone" }), frame)).toThrow(
      "Session gone is shutting down (inbox missing). Try list_sessions again.",
    );
  });
});

describe("names and table", () => {
  it("sanitise", () => {
    expect(sanitise("my project/x")).toBe("my-project-x");
    expect(sanitise("--a--b--")).toBe("a-b");
    expect(sanitise("///")).toBe("pi");
    expect(sanitise("x".repeat(50))).toHaveLength(40);
  });
  it("uniqueName suffixes on collision", () => {
    const taken = [entry({ name: "a" }), entry({ name: "a-2" })];
    expect(uniqueName("a", taken)).toBe("a-3");
    expect(uniqueName("b", taken)).toBe("b");
  });
  it("formatTable", () => {
    expect(formatTable("hortti-3f9a", [])).toBe("This session is hortti-3f9a. No other pi sessions are running.");
    const t = formatTable("hortti-3f9a", [
      entry({ name: "bruno-db", sessionId: "af32f751deadbeef", status: "busy", cwd: "/home/bruno" }),
      entry({ name: "scratch-91ce", sessionId: "01a09d0e00000000", cwd: "/tmp/x" }),
    ]);
    expect(t).toBe(
      "This session is hortti-3f9a.\n\nname          id        status  cwd\nbruno-db      af32f751  busy    /home/bruno\nscratch-91ce  01a09d0e  idle    /tmp/x",
    );
  });
});

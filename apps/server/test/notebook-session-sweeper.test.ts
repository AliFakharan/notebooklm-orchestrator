import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db } from "../src/db/db.js";
import { NotebookSessionsRepo } from "../src/domain/notebook-sessions.repo.js";
import { NotebookSessionSweeper } from "../src/queue/notebook-session-sweeper.js";

/**
 * NotebookSessionSweeper: the idle-TTL reaper. Uses injectable timers so the
 * interval is deterministic, and a real in-memory DB for the session rows.
 */

const TTL = 1000;

function ageSession(db: Db, id: string, ms: number): void {
  const aged = new Date(Date.now() - ms).toISOString();
  db.raw.prepare("UPDATE notebook_sessions SET last_used_at=? WHERE id=?").run(aged, id);
}

describe("enabled flag", () => {
  it("is disabled when ttlMs <= 0 and sweep() is a no-op", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nlo-sweeper-"));
    const db = Db.open(path.join(dir, "t.sqlite"));
    const sessions = new NotebookSessionsRepo(db);
    const s = sessions.create({ chatId: 1, notebookTitle: "t" });
    ageSession(db, s.id, 5000);
    const sw = new NotebookSessionSweeper({ sessions, ttlMs: 0, intervalMs: 10, log: () => {} });
    expect(sw.enabled).toBe(false);
    expect(sw.sweep()).toEqual([]);
    expect(sessions.get(s.id)!.status).toBe("open");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("sweep()", () => {
  it("expires only open sessions idle longer than the ttl (fresh + closed untouched)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nlo-sweeper-"));
    const db = Db.open(path.join(dir, "t.sqlite"));
    const sessions = new NotebookSessionsRepo(db);
    const stale = sessions.create({ chatId: 1, notebookTitle: "stale" });
    const fresh = sessions.create({ chatId: 2, notebookTitle: "fresh" });
    const closed = sessions.create({ chatId: 3, notebookTitle: "closed" });
    sessions.close(closed.id);
    ageSession(db, stale.id, 5000); // idle well past the ttl

    const sw = new NotebookSessionSweeper({ sessions, ttlMs: TTL, intervalMs: 10, log: () => {} });
    const expired = sw.sweep();

    expect(expired).toEqual([stale.id]);
    expect(sessions.get(stale.id)!.status).toBe("expired");
    expect(sessions.get(fresh.id)!.status).toBe("open");
    expect(sessions.get(closed.id)!.status).toBe("closed");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("start()/stop() with injectable timers", () => {
  it("runs the sweep on every interval tick and stops cleanly", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nlo-sweeper-"));
    const db = Db.open(path.join(dir, "t.sqlite"));
    const sessions = new NotebookSessionsRepo(db);
    const stale = sessions.create({ chatId: 1, notebookTitle: "stale" });
    ageSession(db, stale.id, 5000);

    let tickFn: (() => void) | null = null;
    const started: number[] = [];
    let cleared = false;
    const sw = new NotebookSessionSweeper({
      sessions,
      ttlMs: TTL,
      intervalMs: 10,
      log: () => {},
      setIntervalFn: (fn, ms) => {
        tickFn = fn;
        started.push(ms);
        return { unref() {} } as unknown as NodeJS.Timeout;
      },
      clearIntervalFn: () => {
        cleared = true;
      },
    });
    sw.start();
    expect(started).toEqual([10]);
    expect(sessions.get(stale.id)!.status).toBe("open"); // not swept until the tick fires

    tickFn!(); // fire the interval once
    expect(sessions.get(stale.id)!.status).toBe("expired");

    sw.stop();
    expect(cleared).toBe(true);
    // Starting again after a stop re-arms the interval.
    sw.start();
    expect(started.length).toBe(2);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not start a timer when disabled", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nlo-sweeper-"));
    const db = Db.open(path.join(dir, "t.sqlite"));
    const sessions = new NotebookSessionsRepo(db);
    let started = 0;
    const sw = new NotebookSessionSweeper({
      sessions,
      ttlMs: 0,
      intervalMs: 10,
      log: () => {},
      setIntervalFn: () => {
        started++;
        return { unref() {} } as unknown as NodeJS.Timeout;
      },
    });
    sw.start();
    sw.start(); // idempotent
    expect(started).toBe(0);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

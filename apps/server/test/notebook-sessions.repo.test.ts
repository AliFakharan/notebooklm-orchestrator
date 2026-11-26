import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/db/db.js";
import { AccountsRepo } from "../src/domain/accounts.repo.js";
import { NotebookSessionsRepo } from "../src/domain/notebook-sessions.repo.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * NotebookSessionsRepo: anchor CRUD, one-open-per-chat, touch (TTL + anchor
 * patch), close/expire (one-way + idempotent), and the idle-TTL sweep.
 */
let dir: string;
let db: Db;
let repo: NotebookSessionsRepo;
/** A real account row so `account_id` FK constraints hold (mirrors production). */
let accountId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nlo-nb-session-"));
  db = Db.open(path.join(dir, "test.sqlite"));
  repo = new NotebookSessionsRepo(db);
  accountId = new AccountsRepo(db).create({ email: "owner@example.com" }).id;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("create + get", () => {
  it("creates an open session with a generated id and the given title", () => {
    const s = repo.create({ chatId: 123, notebookTitle: "My notes · NLO-abcd1234" });
    expect(s.id).toMatch(/^ns_[0-9a-f]{32}$/);
    expect(s.chatId).toBe(123);
    expect(s.notebookTitle).toBe("My notes · NLO-abcd1234");
    expect(s.status).toBe("open");
    expect(s.notebookId).toBeNull();
    expect(s.conversationId).toBeNull();
    expect(s.accountId).toBeNull();
    expect(s.closedAt).toBeNull();
    expect(repo.get(s.id)).toEqual(s);
  });

  it("generates a distinct id per session", () => {
    expect(repo.create({ chatId: 1, notebookTitle: "a" }).id).not.toBe(
      repo.create({ chatId: 1, notebookTitle: "b" }).id,
    );
  });

  it("get returns null for an unknown id and getOrThrow throws", () => {
    expect(repo.get("ns_deadbeefdeadbeefdeadbeefdeadbeef")).toBeNull();
    expect(() => repo.getOrThrow("ns_deadbeefdeadbeefdeadbeefdeadbeef")).toThrow(/not found/);
  });
});

describe("one open session per chat", () => {
  it("getOpenByChat returns the open session for that chat only", () => {
    const a = repo.create({ chatId: 1, notebookTitle: "a" });
    const b = repo.create({ chatId: 2, notebookTitle: "b" });
    expect(repo.getOpenByChat(1)?.id).toBe(a.id);
    expect(repo.getOpenByChat(2)?.id).toBe(b.id);
    expect(repo.getOpenByChat(3)).toBeNull();
  });

  it("returns null once the open session is closed", () => {
    const a = repo.create({ chatId: 1, notebookTitle: "a" });
    repo.close(a.id);
    expect(repo.getOpenByChat(1)).toBeNull();
    // A new open session for the same chat is found again.
    const b = repo.create({ chatId: 1, notebookTitle: "b" });
    expect(repo.getOpenByChat(1)?.id).toBe(b.id);
  });
});

describe("touch", () => {
  it("patches anchor fields and keeps the session open", () => {
    const s = repo.create({ chatId: 1, notebookTitle: "t" });
    const t = repo.touch(s.id, {
      notebookId: "nb_1",
      conversationId: "conv_1",
      accountId,
    });
    expect(t.status).toBe("open");
    expect(t.notebookId).toBe("nb_1");
    expect(t.conversationId).toBe("conv_1");
    expect(t.accountId).toBe(accountId);
  });

  it("does not overwrite anchor fields when the patch omits them", () => {
    const s = repo.create({ chatId: 1, notebookTitle: "t" });
    repo.touch(s.id, { notebookId: "nb_1", conversationId: "conv_1", accountId });
    // Touch with only a conversation update: notebook/account preserved.
    const t = repo.touch(s.id, { conversationId: "conv_2" });
    expect(t.notebookId).toBe("nb_1");
    expect(t.accountId).toBe(accountId);
    expect(t.conversationId).toBe("conv_2");
  });

  it("throws for an unknown id", () => {
    expect(() => repo.touch("ns_deadbeefdeadbeefdeadbeefdeadbeef", {})).toThrow(/not found/);
  });
});

describe("close / expire (one-way + idempotent)", () => {
  it("close moves an open session to closed and stamps closed_at", () => {
    const s = repo.create({ chatId: 1, notebookTitle: "t" });
    const c = repo.close(s.id);
    expect(c.status).toBe("closed");
    expect(c.closedAt).not.toBeNull();
  });

  it("expire moves an open session to expired", () => {
    const s = repo.create({ chatId: 1, notebookTitle: "t" });
    expect(repo.expire(s.id).status).toBe("expired");
  });

  it("is idempotent: closing an already-closed session is a no-op", () => {
    const s = repo.create({ chatId: 1, notebookTitle: "t" });
    const first = repo.close(s.id);
    const second = repo.close(s.id);
    expect(second.status).toBe("closed");
    expect(second.closedAt).toBe(first.closedAt);
  });

  it("a closed session is not returned by getOpenByChat even after a stray touch", () => {
    const s = repo.create({ chatId: 1, notebookTitle: "t" });
    repo.close(s.id);
    repo.touch(s.id, { conversationId: "conv" }); // touch must not reopen
    expect(repo.get(s.id)!.status).toBe("closed");
    expect(repo.getOpenByChat(1)).toBeNull();
  });
});

describe("expireStale (idle TTL sweep)", () => {
  it("expires only open sessions idle longer than the ttl", () => {
    const stale = repo.create({ chatId: 1, notebookTitle: "stale" });
    const fresh = repo.create({ chatId: 2, notebookTitle: "fresh" });
    const closed = repo.create({ chatId: 3, notebookTitle: "closed" });
    repo.close(closed.id);

    // Age the stale session past the (1000ms) ttl by rewriting its row.
    const aged = new Date(Date.now() - 2000).toISOString();
    db.raw.prepare("UPDATE notebook_sessions SET last_used_at=? WHERE id=?").run(aged, stale.id);

    const expired = repo.expireStale(1000);
    expect(expired).toEqual([stale.id]);
    expect(repo.get(stale.id)!.status).toBe("expired");
    expect(repo.get(fresh.id)!.status).toBe("open");
    expect(repo.get(closed.id)!.status).toBe("closed");
  });

  it("leaves a fresh session open", () => {
    const fresh = repo.create({ chatId: 1, notebookTitle: "fresh" });
    expect(repo.expireStale(1000)).toEqual([]);
    expect(repo.get(fresh.id)!.status).toBe("open");
  });
});

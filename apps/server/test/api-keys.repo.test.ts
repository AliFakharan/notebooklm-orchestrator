import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Db } from "../src/db/db.js";
import { ApiKeyRepo } from "../src/domain/api-keys.repo.js";

let dir: string;
let db: Db;
let repo: ApiKeyRepo;

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  dir = mkdtempSync(path.join(tmpdir(), "nlo-ak-"));
  db = Db.open(path.join(dir, "test.sqlite"));
  repo = new ApiKeyRepo(db);
}

describe("ApiKeyRepo", () => {
  it("create returns raw/prefix/id in the pinned format", () => {
    setup();
    const k = repo.create("litellm");
    expect(k.raw).toMatch(/^nlo_[A-Za-z0-9_-]{43}$/);
    expect(k.prefix).toBe(k.raw.slice(0, 8));
    expect(k.id).toMatch(/^ak_[0-9a-f]{16}$/);
  });

  it("verify finds a created key and stamps last_used_at", () => {
    setup();
    const k = repo.create("a");
    expect(repo.verify(k.raw)?.name).toBe("a");
    expect(repo.list()[0]!.lastUsedAt).not.toBeNull();
  });

  it("verify returns null for an unknown key", () => {
    setup();
    expect(repo.verify("nlo_" + "x".repeat(43))).toBeNull();
  });

  it("verify returns null for a revoked key", () => {
    setup();
    const k = repo.create("b");
    expect(repo.revoke(k.id)).toBe(true);
    expect(repo.verify(k.raw)).toBeNull();
  });

  it("list never exposes the raw key or its hash", () => {
    setup();
    const k = repo.create("c");
    const json = JSON.stringify(repo.list());
    expect(json).not.toContain(k.raw);
    expect(json).not.toContain("hash");
  });

  it("revoke is idempotent", () => {
    setup();
    const k = repo.create("d");
    repo.revoke(k.id);
    expect(repo.revoke(k.id)).toBe(false);
  });
});

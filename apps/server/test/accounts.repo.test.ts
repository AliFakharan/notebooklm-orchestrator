import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Db } from "../src/db/db.js";
import { AccountsRepo } from "../src/domain/accounts.repo.js";

let dir: string;
let db: Db;
let accounts: AccountsRepo;

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  dir = mkdtempSync(path.join(tmpdir(), "nlo-acct-"));
  db = Db.open(path.join(dir, "test.sqlite"));
  accounts = new AccountsRepo(db);
}

describe("AccountsRepo", () => {
  it("creates accounts keyed by email (label === email), no auth evidence, no default", () => {
    setup();
    const a = accounts.create({ email: "One@Example.com" });
    expect(a.displayEmail).toBe("one@example.com");
    expect(a.label).toBe("one@example.com");
    expect(a.enabled).toBe(true);
    expect(a.status).toBe("UNKNOWN");
    expect(a.authSecretRef).toBeNull();
    expect(a.lastVerifiedAt).toBeNull();
    expect(a.isDefault).toBe(false);
  });

  it("rejects duplicate emails on create", () => {
    setup();
    accounts.create({ email: "dup@example.com" });
    expect(() => accounts.create({ email: "DUP@example.com" })).toThrow(/already exists/);
  });

  it("update can change the email (label follows) and reject duplicates", () => {
    setup();
    const a = accounts.create({ email: "one@example.com" });
    accounts.create({ email: "two@example.com" });
    const u = accounts.update(a.id, { displayEmail: "new@example.com" });
    expect(u!.displayEmail).toBe("new@example.com");
    expect(u!.label).toBe("new@example.com");
    expect(() => accounts.update(a.id, { displayEmail: "two@example.com" })).toThrow(
      /already exists/,
    );
  });

  it("update can set lastVerifiedAt and authSecretRef (auth evidence)", () => {
    setup();
    const a = accounts.create({ email: "acct-1@example.com" });
    const ts = new Date().toISOString();
    const u = accounts.update(a.id, {
      authSecretRef: "nbl-session:acc_1",
      lastVerifiedAt: ts,
    });
    expect(u).not.toBeNull();
    expect(u!.lastVerifiedAt).toBe(ts);
    expect(u!.displayEmail).toBe("acct-1@example.com");
    expect(u!.authSecretRef).toBe("nbl-session:acc_1");
  });

  describe("default account invariant (at most one default)", () => {
    it("sets a default and clears it explicitly", () => {
      setup();
      const a = accounts.create({ email: "a@example.com" });
      const b = accounts.create({ email: "b@example.com" });

      expect(accounts.setDefault(a.id, true)).not.toBeNull();
      expect(accounts.get(a.id)!.isDefault).toBe(true);

      expect(accounts.setDefault(a.id, false)).not.toBeNull();
      expect(accounts.get(a.id)!.isDefault).toBe(false);
      expect(accounts.get(b.id)!.isDefault).toBe(false);
    });

    it("moving the default to another account clears the previous one", () => {
      setup();
      const a = accounts.create({ email: "a@example.com" });
      const b = accounts.create({ email: "b@example.com" });
      const c = accounts.create({ email: "c@example.com" });

      accounts.setDefault(a.id, true);
      accounts.setDefault(b.id, true);
      expect(accounts.get(a.id)!.isDefault).toBe(false);
      expect(accounts.get(b.id)!.isDefault).toBe(true);
      expect(accounts.get(c.id)!.isDefault).toBe(false);
    });

    it("clearing the default of a non-default account is a no-op", () => {
      setup();
      const a = accounts.create({ email: "a@example.com" });
      expect(accounts.setDefault(a.id, false)).not.toBeNull();
      expect(accounts.get(a.id)!.isDefault).toBe(false);
    });

    it("throws on unknown account ids", () => {
      setup();
      expect(() => accounts.setDefault("missing", true)).toThrow();
    });
  });

  it("delete removes the account but keeps other accounts intact", () => {
    setup();
    const a = accounts.create({ email: "a@example.com" });
    const b = accounts.create({ email: "b@example.com" });
    accounts.recordSuccess(a.id);
    accounts.recordError(b.id, "boom", "DEGRADED");

    expect(accounts.delete(a.id)).toBe(true);
    expect(accounts.get(a.id)).toBeNull();
    expect(accounts.list().map((x) => x.label)).toEqual(["b@example.com"]);
  });

  it("eligible() excludes disabled and AUTH_REQUIRED accounts", () => {
    setup();
    const a = accounts.create({ email: "a@example.com" });
    const b = accounts.create({ email: "b@example.com" });
    accounts.update(a.id, { enabled: false });
    accounts.update(b.id, { status: "AUTH_REQUIRED" });
    expect(accounts.eligible()).toEqual([]);
  });
});

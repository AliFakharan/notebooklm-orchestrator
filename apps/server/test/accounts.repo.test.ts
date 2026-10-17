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
  it("creates accounts with no auth evidence and no default", () => {
    setup();
    const a = accounts.create({ label: "acct-1", displayEmail: "one@example.com" });
    expect(a.enabled).toBe(true);
    expect(a.status).toBe("UNKNOWN");
    expect(a.authSecretRef).toBeNull();
    expect(a.lastVerifiedAt).toBeNull();
    expect(a.isDefault).toBe(false);
  });

  it("update can set lastVerifiedAt and authSecretRef (auth evidence)", () => {
    setup();
    const a = accounts.create({ label: "acct-1" });
    const ts = new Date().toISOString();
    const u = accounts.update(a.id, {
      displayEmail: "me@gmail.com",
      authSecretRef: "nbl-session:acc_1",
      lastVerifiedAt: ts,
    });
    expect(u).not.toBeNull();
    expect(u!.lastVerifiedAt).toBe(ts);
    expect(u!.displayEmail).toBe("me@gmail.com");
    expect(u!.authSecretRef).toBe("nbl-session:acc_1");
  });

  describe("default account invariant (at most one default)", () => {
    it("sets a default and clears it explicitly", () => {
      setup();
      const a = accounts.create({ label: "a" });
      const b = accounts.create({ label: "b" });

      expect(accounts.setDefault(a.id, true)).not.toBeNull();
      expect(accounts.get(a.id)!.isDefault).toBe(true);

      expect(accounts.setDefault(a.id, false)).not.toBeNull();
      expect(accounts.get(a.id)!.isDefault).toBe(false);
      expect(accounts.get(b.id)!.isDefault).toBe(false);
    });

    it("moving the default to another account clears the previous one", () => {
      setup();
      const a = accounts.create({ label: "a" });
      const b = accounts.create({ label: "b" });
      const c = accounts.create({ label: "c" });

      accounts.setDefault(a.id, true);
      accounts.setDefault(b.id, true);
      expect(accounts.get(a.id)!.isDefault).toBe(false);
      expect(accounts.get(b.id)!.isDefault).toBe(true);
      expect(accounts.get(c.id)!.isDefault).toBe(false);
    });

    it("clearing the default of a non-default account is a no-op", () => {
      setup();
      const a = accounts.create({ label: "a" });
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
    const a = accounts.create({ label: "a" });
    const b = accounts.create({ label: "b" });
    accounts.recordSuccess(a.id);
    accounts.recordError(b.id, "boom", "DEGRADED");

    expect(accounts.delete(a.id)).toBe(true);
    expect(accounts.get(a.id)).toBeNull();
    expect(accounts.list().map((x) => x.label)).toEqual(["b"]);
  });

  it("eligible() excludes disabled and AUTH_REQUIRED accounts", () => {
    setup();
    const a = accounts.create({ label: "a" });
    const b = accounts.create({ label: "b" });
    accounts.update(a.id, { enabled: false });
    accounts.update(b.id, { status: "AUTH_REQUIRED" });
    expect(accounts.eligible()).toEqual([]);
  });
});

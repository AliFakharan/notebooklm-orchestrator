import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import type { Db } from "../db/db.js";

/**
 * File-DB hybrid secret store: AES-256-GCM, per-record random nonce.
 *
 * Threat model (documented in docs/security.md):
 *  - Protects against casual exposure, backup mistakes, and accidental
 *    logging of DB files.
 *  - The key file lives beside the data dir (mode 0600). Anyone with full
 *    access to the data dir can read secrets. That is an accepted local
 *    limitation; upgrading to an OS keyring or external key is a follow-up.
 *
 * Records live in the `secrets` table keyed by `ref`. The key is held in
 * memory for the process lifetime (loaded from env or key file).
 */
const ALG = "aes-256-gcm";
const NONCE_LEN = 12;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export class SecretVault {
  private readonly key: Buffer;
  private readonly db: Db;

  private constructor(key: Buffer, db: Db) {
    this.key = key;
    this.db = db;
  }

  /**
   * Resolve the vault key: env `NLO_VAULT_KEY` first, else the key file
   * (created on first use with mode 0600).
   */
  static open(db: Db, opts: { keyHex?: string | null; keyFile: string }): SecretVault {
    let key: Buffer;
    if (opts.keyHex) {
      if (!/^[0-9a-fA-F]{64}$/.test(opts.keyHex)) {
        throw new VaultError("vault key must be 64 hex chars");
      }
      key = Buffer.from(opts.keyHex, "hex");
    } else if (existsSync(opts.keyFile)) {
      key = Buffer.from(readFileSync(opts.keyFile, "utf8").trim(), "hex");
      if (key.length !== 32) throw new VaultError("vault key file is corrupt");
    } else {
      mkdirSync(path.dirname(opts.keyFile), { recursive: true });
      key = randomBytes(32);
      writeFileSync(opts.keyFile, key.toString("hex"), { mode: 0o600 });
      chmodSync(opts.keyFile, 0o600);
    }
    return new SecretVault(key, db);
  }

  /** Store or overwrite a secret under `ref`. */
  put(ref: string, value: string, kind: string): void {
    const nonce = randomBytes(NONCE_LEN);
    const cipher = createCipheriv(ALG, this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    const now = this.db.now();
    const existing = this.db.raw.prepare("SELECT ref FROM secrets WHERE ref = ?").get(ref);
    if (existing) {
      this.db.raw
        .prepare(
          "UPDATE secrets SET ciphertext=?, nonce=?, tag=?, kind=?, updated_at=? WHERE ref=?",
        )
        .run(ciphertext, nonce, tag, kind, now, ref);
    } else {
      this.db.raw
        .prepare(
          "INSERT INTO secrets (ref, ciphertext, nonce, tag, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(ref, ciphertext, nonce, tag, kind, now, now);
    }
  }

  /** Read a secret. Throws VaultError if missing or undecryptable. */
  get(ref: string): string {
    const row = this.db.raw
      .prepare("SELECT ciphertext, nonce, tag, kind FROM secrets WHERE ref = ?")
      .get(ref) as
      { ciphertext: Uint8Array; nonce: Uint8Array; tag: Uint8Array; kind: string } | undefined;
    if (!row) throw new VaultError(`secret not found: ${ref}`);
    try {
      const decipher = createDecipheriv(ALG, this.key, row.nonce);
      decipher.setAuthTag(row.tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new VaultError(`secret undecryptable: ${ref}`);
    }
  }

  delete(ref: string): boolean {
    const res = this.db.raw.prepare("DELETE FROM secrets WHERE ref = ?").run(ref);
    return Number(res.changes) > 0;
  }

  has(ref: string): boolean {
    return this.db.raw.prepare("SELECT 1 AS x FROM secrets WHERE ref = ?").get(ref) !== undefined;
  }

  /**
   * List refs with their kind — NEVER the values. Used by the admin UI to
   * show which secrets exist without exposing them.
   */
  list(): { ref: string; kind: string; updatedAt: string }[] {
    return this.db.raw
      .prepare("SELECT ref, kind, updated_at AS updatedAt FROM secrets ORDER BY ref")
      .all() as { ref: string; kind: string; updatedAt: string }[];
  }
}

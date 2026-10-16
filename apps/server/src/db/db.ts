import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SQLite access via the built-in `node:sqlite` (zero native dependencies).
 * All access is synchronous + single-connection: appropriate for a local,
 * single-user service. The connection is created in WAL mode for resilience.
 */
export class Db {
  readonly raw: DatabaseSync;

  private constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  static open(file: string): Db {
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA journal_mode = WAL;");
    raw.exec("PRAGMA foreign_keys = ON;");
    raw.exec("PRAGMA busy_timeout = 5000;");
    const db = new Db(raw);
    db.migrate();
    return db;
  }

  migrate(): void {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
    const files = readdirSync(migrationsDir)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();

    const applied = new Set(
      this.raw
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((r) => Number((r as { version: number }).version)),
    );

    for (const file of files) {
      const version = Number(file.slice(0, 4));
      if (applied.has(version)) continue;
      const sql = readFileSync(path.join(migrationsDir, file), "utf8");
      this.raw.exec("BEGIN");
      try {
        this.raw.exec(sql);
        this.raw
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(version, new Date().toISOString());
        this.raw.exec("COMMIT");
      } catch (err) {
        this.raw.exec("ROLLBACK");
        throw new Error(`migration ${file} failed: ${String(err)}`);
      }
    }
  }

  now(): string {
    return new Date().toISOString();
  }

  close(): void {
    this.raw.close();
  }
}

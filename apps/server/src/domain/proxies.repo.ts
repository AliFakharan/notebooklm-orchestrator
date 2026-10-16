import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";
import type { ProxyNode, ProxyNodeConfig, ProxyHealth } from "@nlo/shared";

export class ProxiesRepo {
  constructor(private readonly db: Db) {}

  create(config: ProxyNodeConfig, opts: { priority?: number } = {}): ProxyNode {
    const dup = this.db.raw
      .prepare("SELECT 1 AS x FROM proxy_nodes WHERE name = ?")
      .get(config.name);
    if (dup) throw new Error(`proxy node name already exists: ${config.name}`);
    const now = this.db.now();
    const id = `node_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.db.raw
      .prepare(
        `INSERT INTO proxy_nodes
          (id, name, server, port, uuid_secret_ref, transport, security, sni, ws_host, ws_path,
           pbk, sid, spx, flow, encryption, alpn, extra_json, enabled, priority, preferred, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,0,?,?)`,
      )
      .run(
        id,
        config.name,
        config.server,
        config.port,
        config.uuidSecretRef,
        config.transport,
        config.security,
        config.sni ?? null,
        config.wsHost ?? null,
        config.wsPath ?? null,
        config.pbk ?? null,
        config.sid ?? null,
        config.spx ?? null,
        config.flow ?? null,
        config.encryption ?? null,
        config.alpn ?? null,
        JSON.stringify(config.extra ?? {}),
        opts.priority ?? 100,
        now,
        now,
      );
    return this.getOrThrow(id);
  }

  get(id: string): ProxyNode | null {
    const row = this.db.raw.prepare("SELECT * FROM proxy_nodes WHERE id = ?").get(id);
    return row ? this.map(row) : null;
  }

  getOrThrow(id: string): ProxyNode {
    const n = this.get(id);
    if (!n) throw new Error(`proxy node not found: ${id}`);
    return n;
  }

  list(): ProxyNode[] {
    return (
      this.db.raw.prepare("SELECT * FROM proxy_nodes ORDER BY priority, name").all() as unknown[]
    ).map((r) => this.map(r as Record<string, unknown>));
  }

  update(
    id: string,
    patch: Partial<Pick<ProxyNode, "config" | "enabled" | "priority" | "preferred">>,
  ): ProxyNode {
    const current = this.getOrThrow(id);
    const cfg: ProxyNodeConfig = patch.config ? patch.config : { ...current.config };
    const name = cfg.name;
    const dup = this.db.raw
      .prepare("SELECT 1 AS x FROM proxy_nodes WHERE name = ? AND id != ?")
      .get(name, id);
    if (dup) throw new Error(`proxy node name already exists: ${name}`);

    const now = this.db.now();
    this.db.raw
      .prepare(
        `UPDATE proxy_nodes SET name=?, server=?, port=?, uuid_secret_ref=?, transport=?, security=?,
           sni=?, ws_host=?, ws_path=?, pbk=?, sid=?, spx=?, flow=?, encryption=?, alpn=?,
           extra_json=?, enabled=?, priority=?, preferred=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        cfg.name,
        cfg.server,
        cfg.port,
        cfg.uuidSecretRef,
        cfg.transport,
        cfg.security,
        cfg.sni ?? null,
        cfg.wsHost ?? null,
        cfg.wsPath ?? null,
        cfg.pbk ?? null,
        cfg.sid ?? null,
        cfg.spx ?? null,
        cfg.flow ?? null,
        cfg.encryption ?? null,
        cfg.alpn ?? null,
        JSON.stringify(cfg.extra ?? {}),
        patch.enabled === undefined ? (current.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
        patch.priority ?? current.priority,
        patch.preferred === undefined ? (current.preferred ? 1 : 0) : patch.preferred ? 1 : 0,
        now,
        id,
      );
    return this.getOrThrow(id);
  }

  delete(id: string): boolean {
    this.db.raw.prepare("DELETE FROM proxy_health WHERE node_id = ?").run(id);
    const res = this.db.raw.prepare("DELETE FROM proxy_nodes WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  /** Enabled nodes in fallback order (lower priority number first). */
  fallbackOrder(): ProxyNode[] {
    return this.list().filter((n) => n.enabled);
  }

  health(nodeId: string): ProxyHealth | null {
    const row = this.db.raw.prepare("SELECT * FROM proxy_health WHERE node_id = ?").get(nodeId) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      nodeId,
      lastCheckedAt: (row.last_checked_at as string | null) ?? null,
      ok: Boolean(row.ok),
      egressIp: (row.egress_ip as string | null) ?? null,
      latencyMs: (row.latency_ms as number | null) ?? null,
      error: (row.error as string | null) ?? null,
    };
  }

  setHealth(h: Omit<ProxyHealth, "nodeId">, nodeId: string): void {
    const now = this.db.now();
    this.db.raw
      .prepare(
        `INSERT INTO proxy_health (node_id, last_checked_at, ok, egress_ip, latency_ms, error)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(node_id) DO UPDATE SET
           last_checked_at=excluded.last_checked_at,
           ok=excluded.ok,
           egress_ip=excluded.egress_ip,
           latency_ms=excluded.latency_ms,
           error=excluded.error`,
      )
      .run(nodeId, now, h.ok ? 1 : 0, h.egressIp, h.latencyMs, h.error);
    this.db.raw
      .prepare(
        `INSERT INTO proxy_health_history (node_id, checked_at, ok, egress_ip, latency_ms, error)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(nodeId, now, h.ok ? 1 : 0, h.egressIp, h.latencyMs, h.error);
    // Keep the history table bounded (most recent 200 per node).
    this.db.raw
      .prepare(
        `DELETE FROM proxy_health_history
         WHERE id IN (
           SELECT id FROM proxy_health_history
           WHERE node_id = ?
           ORDER BY id DESC
           LIMIT -1 OFFSET 200
         )`,
      )
      .run(nodeId);
  }

  history(
    nodeId: string,
    limit = 50,
  ): {
    checkedAt: string;
    ok: boolean;
    egressIp: string | null;
    latencyMs: number | null;
    error: string | null;
  }[] {
    const rows = this.db.raw
      .prepare(
        `SELECT checked_at AS checkedAt, ok, egress_ip AS egressIp, latency_ms AS latencyMs, error
         FROM proxy_health_history WHERE node_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(nodeId, limit) as unknown as {
      checkedAt: string;
      ok: number;
      egressIp: string | null;
      latencyMs: number | null;
      error: string | null;
    }[];
    return rows.map((r) => ({ ...r, ok: Boolean(r.ok) }));
  }

  private map(row: Record<string, unknown>): ProxyNode {
    return {
      id: row.id as string,
      config: {
        name: row.name as string,
        server: row.server as string,
        port: row.port as number,
        uuidSecretRef: row.uuid_secret_ref as string,
        transport: row.transport as ProxyNodeConfig["transport"],
        security: row.security as ProxyNodeConfig["security"],
        sni: (row.sni as string | null) ?? undefined,
        wsHost: (row.ws_host as string | null) ?? undefined,
        wsPath: (row.ws_path as string | null) ?? undefined,
        pbk: (row.pbk as string | null) ?? undefined,
        sid: (row.sid as string | null) ?? undefined,
        spx: (row.spx as string | null) ?? undefined,
        flow: (row.flow as string | null) ?? undefined,
        encryption: (row.encryption as string | null) ?? undefined,
        alpn: (row.alpn as string | null) ?? undefined,
        extra: (JSON.parse(row.extra_json as string) as Record<string, string>) ?? {},
      },
      enabled: Boolean(row.enabled),
      priority: row.priority as number,
      preferred: Boolean(row.preferred),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

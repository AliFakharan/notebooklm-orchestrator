import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { redactSecrets } from "@nlo/shared";
import type { AppContext } from "../../app-context.js";

/**
 * Runtime settings + secret inventory.
 *
 * Only a small, explicit whitelist of non-secret settings can be changed at
 * runtime. Environment-level settings (host/port/allowlist/vault key) are
 * process configuration and intentionally NOT writable through the API.
 */

const settingsSchema = z.object({
  /** Default max attempts for new jobs. */
  jobsMaxAttemptsDefault: z.number().int().min(1).max(10).optional(),
  /** Max prompt length accepted by POST /api/jobs. */
  jobsMaxPromptChars: z.number().int().min(100).max(100_000).optional(),
});

const DEFAULTS: Record<string, number> = {
  jobs_max_attempts_default: 3,
  jobs_max_prompt_chars: 20_000,
};

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/settings", async () => {
    const rows = ctx.db.raw.prepare("SELECT key, value_json, updated_at FROM settings").all() as {
      key: string;
      value_json: string;
      updated_at: string;
    }[];
    const stored = new Map(rows.map((r) => [r.key, Number(r.value_json)]));
    return {
      settings: {
        jobsMaxAttemptsDefault:
          stored.get("jobs_max_attempts_default") ?? DEFAULTS["jobs_max_attempts_default"],
        jobsMaxPromptChars:
          stored.get("jobs_max_prompt_chars") ?? DEFAULTS["jobs_max_prompt_chars"],
      },
      defaults: DEFAULTS,
      writableKeys: ["jobsMaxAttemptsDefault", "jobsMaxPromptChars"],
    };
  });

  app.put("/api/settings", async (req, reply) => {
    const body = settingsSchema.parse(req.body);
    if (Object.keys(body).length === 0) {
      return reply.code(400).send({
        error: { code: "validation_error", message: "no settings provided" },
      });
    }
    const updates: Record<string, number> = {};
    const updatedApiKeys: string[] = [];
    if (body.jobsMaxAttemptsDefault !== undefined) {
      updates["jobs_max_attempts_default"] = body.jobsMaxAttemptsDefault;
      updatedApiKeys.push("jobsMaxAttemptsDefault");
    }
    if (body.jobsMaxPromptChars !== undefined) {
      updates["jobs_max_prompt_chars"] = body.jobsMaxPromptChars;
      updatedApiKeys.push("jobsMaxPromptChars");
    }
    const now = ctx.db.now();
    for (const [key, value] of Object.entries(updates)) {
      ctx.db.raw
        .prepare(
          `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run(key, String(value), now);
    }
    return { ok: true, updated: updatedApiKeys };
  });

  /**
   * Secret inventory for the admin UI: refs + kinds only, NEVER values.
   * The UI renders masked refs (e.g. `vless-uuid:••••-1234`).
   */
  app.get("/api/secrets", async () => {
    // Refs may embed credentials (e.g. `vless-uuid:<uuid>`); mask them.
    const secrets = ctx.vault.list().map((s) => ({ ...s, ref: redactSecrets(s.ref) }));
    return { secrets };
  });
}

import type { FastifyInstance } from "fastify";
import { ApiError, ApiCodes } from "@nlo/shared";
import type { AppContext } from "../../app-context.js";

/**
 * Persistent notebook-session routes (distinct from the admin `/api/sessions`
 * auth-session routes above). These are job-adjacent control endpoints the bot
 * uses to close a session and poll its state. Creating/following a session is
 * done through `POST /api/jobs` with `mode`/`sessionId` (it creates a real job
 * row so it flows through the existing queue/retry/archive).
 *
 * Paths are namespaced under `/api/notebook-sessions` to avoid colliding with
 * the admin-gated `/api/sessions/:id` auth routes.
 */
export function registerNotebookSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { id: string } }>(
    "/api/notebook-sessions/:id",
    {
      schema: {
        summary: "Get a notebook session (status + anchor)",
        tags: ["notebook-sessions"],
        security: [{ bearerAuth: [] }],
        description:
          "Returns the session row (status, notebookId/conversationId, owner account). " +
          "The bot polls this to know when the initial job bound the notebook. " +
          "Also reachable from loopback or with a valid admin cookie.",
        params: { type: "object", properties: { id: { type: "string" } } },
        response: { 200: { $ref: "NotebookSession" }, 404: { $ref: "Error" } },
      },
    },
    async (req) => {
      const session = ctx.notebookSessions.get(req.params.id);
      if (!session) throw new ApiError(ApiCodes.notFound, "notebook session not found", 404);
      return session;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/notebook-sessions/:id/finish",
    {
      schema: {
        summary: "Finish (close) a notebook session",
        tags: ["notebook-sessions"],
        security: [{ bearerAuth: [] }],
        description:
          "Logically closes the session (the notebook stays in Google; the bot stops " +
          "addressing it). Idempotent: an already-closed/expired session is unchanged. " +
          "Also reachable from loopback or with a valid admin cookie.",
        params: { type: "object", properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["ok", "status"],
            properties: {
              ok: { type: "boolean" },
              status: { type: "string" },
              note: { type: ["string", "null"] },
            },
          },
          404: { $ref: "Error" },
        },
      },
    },
    async (req) => {
      const existing = ctx.notebookSessions.get(req.params.id);
      if (!existing) throw new ApiError(ApiCodes.notFound, "notebook session not found", 404);
      // Already terminal: nothing to do (idempotent finish).
      if (existing.status !== "open") {
        return { ok: true, status: existing.status, note: "already terminal" };
      }
      const closed = ctx.notebookSessions.close(existing.id);
      return { ok: true, status: closed.status, note: null };
    },
  );
}

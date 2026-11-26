import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import { makeAppContext } from "./helpers.js";
import type { AppContext } from "../src/app-context.js";

/**
 * API tests for the persistent notebook-session surface:
 *  - POST /api/jobs with `mode`/`chatId`/`sessionId` (create + follow-ups)
 *  - GET  /api/notebook-sessions/:id
 *  - POST /api/notebook-sessions/:id/finish
 *
 * The background queue is stopped (see makeAppContext), so a created job stays
 * CREATED and its notebook is not yet bound; a follow-up that must be accepted
 * is pre-anchored by touching the session directly.
 */

let ctx: AppContext;
let app: FastifyInstance;
const auth: Record<string, string> = {};
const MP_BOUNDARY = "----nlo-nb-session-boundary";

type MpPart = string | { field: string; filename?: string; bytes?: Buffer; type?: string };

function multipart(parts: MpPart[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      const eq = part.indexOf("=");
      const name = part.slice(0, eq);
      const value = part.slice(eq + 1);
      chunks.push(
        Buffer.from(`--${MP_BOUNDARY}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
      );
    } else {
      const header = `--${MP_BOUNDARY}\r\ncontent-disposition: form-data; name="${part.field}"; filename="${part.filename ?? "upload.bin"}"\r\ncontent-type: ${part.type ?? "application/octet-stream"}\r\n\r\n`;
      chunks.push(Buffer.from(header));
      if (part.bytes && part.bytes.length > 0) chunks.push(part.bytes);
      chunks.push(Buffer.from("\r\n"));
    }
  }
  chunks.push(Buffer.from(`--${MP_BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

function mpInject(parts: MpPart[]) {
  return app.inject({
    method: "POST",
    url: "/api/jobs",
    headers: { ...auth, "content-type": `multipart/form-data; boundary=${MP_BOUNDARY}` },
    payload: multipart(parts),
  });
}

async function addAccount(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/accounts",
    headers: auth,
    payload: { email: "owner@example.com" },
  });
  return (res.json() as { id: string }).id;
}

beforeEach(async () => {
  ctx = await makeAppContext({});
  app = await buildApp(ctx);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await ctx.close();
});

describe("POST /api/jobs session bookkeeping", () => {
  it("mode=create opens a fresh session and returns its id/title (no notebook yet)", async () => {
    await addAccount();
    const res = await mpInject([
      "prompt=open it",
      "title=My notes",
      "mode=create",
      "chatId=77",
    ]);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^j_/);
    expect(body.status).toBe("CREATED");
    expect(body.sessionId).toMatch(/^ns_/);
    expect(body.mode).toBe("create");
    expect(body.notebookId).toBeNull();
    expect(body.notebookTitle).toMatch(/^My notes · NLO-[0-9a-f]{8}$/);
    // The session row exists and is open, unanchored (no notebook yet).
    const session = ctx.notebookSessions.get(body.sessionId)!;
    expect(session.status).toBe("open");
    expect(session.chatId).toBe(77);
    expect(session.notebookId).toBeNull();
  });

  it("a second mode=create for the same chat resets (closes) the previous open session", async () => {
    await addAccount();
    const first = (await mpInject(["prompt=a", "mode=create", "chatId=5"]))
      .json() as { sessionId: string };
    const second = (await mpInject(["prompt=b", "mode=create", "chatId=5"]))
      .json() as { sessionId: string };
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(ctx.notebookSessions.get(first.sessionId)!.status).toBe("closed");
    expect(ctx.notebookSessions.get(second.sessionId)!.status).toBe("open");
    // Only one open session per chat.
    expect(ctx.notebookSessions.getOpenByChat(5)!.id).toBe(second.sessionId);
  });

  it("a follow-up mode without a sessionId is rejected", async () => {
    await addAccount();
    const res = await mpInject(["prompt=hi", "mode=ask"]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("a follow-up mode with an unknown sessionId is rejected", async () => {
    await addAccount();
    const res = await mpInject([
      "prompt=hi",
      "mode=ask",
      "sessionId=ns_deadbeefdeadbeefdeadbeefdeadbeef",
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("a follow-up against a closed session is rejected (invalid state)", async () => {
    await addAccount();
    const created = (await mpInject(["prompt=a", "mode=create", "chatId=9"]))
      .json() as { sessionId: string };
    ctx.notebookSessions.close(created.sessionId);
    const res = await mpInject(["prompt=hi", "mode=ask", `sessionId=${created.sessionId}`]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("invalid_state_transition");
  });

  it("a follow-up against an open-but-unanchored session is rejected (no notebook yet)", async () => {
    await addAccount();
    const created = (await mpInject(["prompt=a", "mode=create", "chatId=10"]))
      .json() as { sessionId: string };
    const res = await mpInject(["prompt=hi", "mode=ask", `sessionId=${created.sessionId}`]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("invalid_state_transition");
  });

  it("an anchored follow-up is accepted once the session has a notebook", async () => {
    await addAccount();
    const created = (await mpInject(["prompt=a", "mode=create", "chatId=11"]))
      .json() as { sessionId: string };
    // Simulate the first job having bound the notebook + owner account.
    const acc = await addAccount();
    ctx.notebookSessions.touch(created.sessionId, {
      notebookId: "nb_bound",
      conversationId: "conv_1",
      accountId: acc,
    });
    const res = await mpInject(["prompt=follow up", "mode=ask", `sessionId=${created.sessionId}`]);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.mode).toBe("ask");
    expect(body.sessionId).toBe(created.sessionId);
    expect(body.notebookId).toBe("nb_bound");
    const job = ctx.jobs.get(body.id)!;
    expect(job.input.sessionId).toBe(created.sessionId);
    expect(job.input.mode).toBe("ask");
  });

  it("artifact/add_source modes allow an empty prompt", async () => {
    await addAccount();
    const created = (await mpInject(["prompt=a", "mode=create", "chatId=12"]))
      .json() as { sessionId: string };
    const acc = await addAccount();
    ctx.notebookSessions.touch(created.sessionId, {
      notebookId: "nb_bound",
      accountId: acc,
    });
    // No prompt field at all, just the kind + a file.
    const res = await mpInject([
      "mode=artifact",
      `sessionId=${created.sessionId}`,
      "output=infographic",
      { field: "file", filename: "a.txt", bytes: Buffer.from("x"), type: "text/plain" },
    ]);
    expect(res.statusCode).toBe(201);
    expect(res.json().mode).toBe("artifact");
    // add_source with no prompt is also accepted.
    const addRes = await mpInject([
      "mode=add_source",
      `sessionId=${created.sessionId}`,
      { field: "file", filename: "b.txt", bytes: Buffer.from("y"), type: "text/plain" },
    ]);
    expect(addRes.statusCode).toBe(201);
    expect(addRes.json().mode).toBe("add_source");
  });

  it("an invalid mode is rejected up front", async () => {
    await addAccount();
    const res = await mpInject(["prompt=hi", "mode=bogus"]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("mode=create without a chatId is rejected", async () => {
    await addAccount();
    const res = await mpInject(["prompt=a", "mode=create"]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("an unanchored job (no mode) is unaffected and carries null session fields", async () => {
    await addAccount();
    const res = await mpInject(["prompt=hello"]);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.sessionId).toBeNull();
    expect(body.mode).toBeNull();
    expect(body.notebookTitle).toBeNull();
    expect(body.notebookId).toBeNull();
  });
});

describe("GET /api/notebook-sessions/:id", () => {
  it("returns the session, 404 for an unknown id", async () => {
    await addAccount();
    const created = (await mpInject(["prompt=a", "mode=create", "chatId=20"]))
      .json() as { sessionId: string };
    const ok = await app.inject({
      method: "GET",
      url: `/api/notebook-sessions/${created.sessionId}`,
      headers: auth,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBe(created.sessionId);
    expect(ok.json().status).toBe("open");

    const missing = await app.inject({
      method: "GET",
      url: "/api/notebook-sessions/ns_deadbeefdeadbeefdeadbeefdeadbeef",
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
  });
});

describe("POST /api/notebook-sessions/:id/finish", () => {
  it("closes an open session and is idempotent; 404 for unknown", async () => {
    await addAccount();
    const created = (await mpInject(["prompt=a", "mode=create", "chatId=30"]))
      .json() as { sessionId: string };

    const first = await app.inject({
      method: "POST",
      url: `/api/notebook-sessions/${created.sessionId}/finish`,
      headers: auth,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, status: "closed", note: null });
    expect(ctx.notebookSessions.get(created.sessionId)!.status).toBe("closed");

    // Idempotent: finishing an already-closed session is a no-op.
    const second = await app.inject({
      method: "POST",
      url: `/api/notebook-sessions/${created.sessionId}/finish`,
      headers: auth,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("closed");
    expect(second.json().note).toBe("already terminal");

    const missing = await app.inject({
      method: "POST",
      url: "/api/notebook-sessions/ns_deadbeefdeadbeefdeadbeefdeadbeef/finish",
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
  });
});

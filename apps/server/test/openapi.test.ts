import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import { makeAppContext, addNode, markHealthy } from "./helpers.js";
import type { AppContext } from "../src/app-context.js";

/**
 * OpenAPI / Swagger UI tests. Verifies the spec is served at
 * /documentation/json, the UI at /documentation/, and that the spec
 * documents the job surface, the api-key surface, and the output field
 * (answerMarkdown). A multipart job-creation regression guards against the
 * added schemas rejecting valid requests.
 */

let ctx: AppContext;
let app: FastifyInstance;
// The job surface is open to loopback callers, so no credentials are needed.
const auth: Record<string, string> = {};
const MP_BOUNDARY = "----nlo-openapi-boundary";

beforeEach(async () => {
  ctx = await makeAppContext({});
  app = await buildApp(ctx);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await ctx.close();
});

type MpPart = string | { field: string; filename?: string; bytes?: Buffer; type?: string };

/** Build a correct multipart/form-data body (CRLF-terminated parts). */
function multipart(parts: MpPart[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      const eq = part.indexOf("=");
      const name = part.slice(0, eq);
      const value = part.slice(eq + 1);
      chunks.push(
        Buffer.from(
          `--${MP_BOUNDARY}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
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

describe("openapi", () => {
  it("serves the OpenAPI spec with the documented paths and schemes", async () => {
    const res = await app.inject({ method: "GET", url: "/documentation/json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.paths["/api/jobs"]).toBeDefined();
    expect(spec.paths["/api/jobs/{id}"]).toBeDefined();
    expect(spec.paths["/api/api-keys"]).toBeDefined();
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  it("serves the Swagger UI", async () => {
    const res = await app.inject({ method: "GET", url: "/documentation/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("job details response documents answerMarkdown (the output field)", async () => {
    const spec = (await app.inject({ method: "GET", url: "/documentation/json" })).json();
    expect(JSON.stringify(spec)).toContain("answerMarkdown");
  });

  it("multipart job creation still works identically after the schema is added", async () => {
    // Job creation requires a registered account.
    const acc = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { email: "openapi@example.com" },
      })
    ).json();
    expect(acc).toHaveProperty("id");

    const res = await mpInject(["prompt=hello", `preferredAccountId=${acc.id}`]);
    expect(res.statusCode).toBe(201);
    const job = res.json();
    expect(job.id).toMatch(/^j_[0-9a-f]{32}$/);
    expect(job.status).toBe("CREATED");
  });

  // Runs a full mock job; give it headroom under parallel-suite load.
  it("artifact download streams exact bytes under the content-map response schema", async () => {
    // makeAppContext stops the queue by default (API-only tests); this test
    // runs a real job end-to-end, so start it. close() (afterEach) stops it.
    ctx.queue.start();
    const acc = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { email: "artifact@example.com" },
      })
    ).json();
    // Mock-mode fixtures (same stand-ins the domain tests use): a usable
    // account and a healthy node. A real verified session requires live
    // Google; the mock has no session gate, so status ACTIVE is enough.
    ctx.accounts.update(acc.id, { status: "ACTIVE" });
    const node = addNode(ctx.proxies, ctx.vault, "artifact-node");
    markHealthy(ctx.proxies, node.id);

    const created = await mpInject(["prompt=hello"]);
    expect(created.statusCode).toBe(201);
    const job = created.json();

    // Poll until the in-process worker finishes the mock job.
    let status = "";
    for (let i = 0; i < 100; i++) {
      const detail = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json();
      status = detail.status;
      if (status === "SUCCEEDED" || status === "FAILED") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe("SUCCEEDED");

    const list = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/artifacts` });
    expect(list.statusCode).toBe(200);
    const arts = list.json();
    expect(arts.length).toBe(1);
    const art = arts[0]!;
    expect(art.mediaType).toBe("text/plain");

    const dl = await app.inject({
      method: "GET",
      url: `/api/jobs/${job.id}/artifacts/${art.id}`,
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toContain("text/plain");
    expect(dl.headers["content-length"]).toBe(String(art.size));
    expect(dl.headers["content-disposition"]).toContain("attachment");
    const bytes = dl.rawPayload as Buffer;
    expect(bytes.length).toBe(art.size);
    expect(bytes.toString("utf8")).toBe(
      `Mock sample artifact for job ${job.id}\n` +
        "Generated by the mock provider (NOT a real NotebookLM output).\n",
    );
  }, 20000);
});

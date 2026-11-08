import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import { makeAppContext } from "./helpers.js";
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
// Local single-user model: no bearer token — loopback access is trusted.
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
});

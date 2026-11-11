import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NloApi, NloApiError } from "../src/nlo-api.js";

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

const requests: Captured[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void = (_q, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
};

let server: Server;
let port: number;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((e) => (e ? reject(e) : resolve()));
  });
});

const api = (): NloApi => new NloApi({ apiBase: `http://127.0.0.1:${port}`, apiKey: "nlo_test_key" });

describe("NloApi", () => {
  it("creates a job as multipart with prompt, title and file parts", async () => {
    requests.length = 0;
    const dir = mkdtempSync(path.join(tmpdir(), "nlo-bot-test-"));
    const p = path.join(dir, "hello.txt");
    writeFileSync(p, "متن تست");
    handler = (_q, res) => json(res, 201, { id: "j1", status: "CREATED" });

    const r = await api().createJob({
      prompt: "خلاصه کن",
      title: "عنوان تست",
      files: [{ path: p, filename: "hello.txt", contentType: "text/plain" }],
    });
    expect(r).toEqual({ id: "j1", status: "CREATED" });

    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/jobs");
    expect(req.headers.authorization).toBe("Bearer nlo_test_key");
    expect(String(req.headers["content-type"] ?? "").startsWith("multipart/form-data; boundary=")).toBe(true);
    const body = req.body.toString("utf8");
    expect(body).toContain('name="prompt"');
    expect(body).toContain("خلاصه کن");
    expect(body).toContain('name="title"');
    expect(body).toContain("عنوان تست");
    expect(body).toContain('filename="hello.txt"');
    expect(body).toContain("متن تست");
    expect(body).toContain("text/plain");
  });

  it("omits an empty title field and allows zero files", async () => {
    requests.length = 0;
    handler = (_q, res) => json(res, 201, { id: "j2", status: "CREATED" });
    await api().createJob({ prompt: "p", title: null, files: [] });
    const body = requests[0]!.body.toString("utf8");
    expect(body).toContain('name="prompt"');
    expect(body).toContain("p");
    expect(body).not.toContain('name="title"');
    expect(body).not.toContain("filename=");
  });

  it("polls a job to a terminal state (RUNNING → SUCCEEDED)", async () => {
    let calls = 0;
    handler = (_q, res) => {
      calls++;
      if (calls === 1) {
        json(res, 200, {
          id: "j3",
          status: "RUNNING",
          answerMarkdown: null,
          errorClass: null,
          errorMessage: null,
          createdAt: "t",
        });
      } else {
        json(res, 200, {
          id: "j3",
          status: "SUCCEEDED",
          answerMarkdown: "# جواب",
          errorClass: null,
          errorMessage: null,
          createdAt: "t",
        });
      }
    };
    const a = api();
    expect((await a.getJob("j3")).status).toBe("RUNNING");
    const second = await a.getJob("j3");
    expect(second.status).toBe("SUCCEEDED");
    expect(second.answerMarkdown).toBe("# جواب");
  });

  it("classifies a failed job by errorClass", async () => {
    handler = (_q, res) =>
      json(res, 200, {
        id: "j4",
        status: "FAILED",
        answerMarkdown: null,
        errorClass: "auth",
        errorMessage: "session rejected",
        createdAt: "t",
      });
    const job = await api().getJob("j4");
    expect(job.status).toBe("FAILED");
    expect(job.errorClass).toBe("auth");
  });

  it("passes 4xx error messages through", async () => {
    handler = (_q, res) => json(res, 400, { error: { code: "validation", message: "unsupported file type: .exe" } });
    const err = await api().createJob({ prompt: "p", title: null, files: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(NloApiError);
    expect((err as NloApiError).status).toBe(400);
    expect((err as NloApiError).message).toBe("unsupported file type: .exe");
  });

  it("surfaces 401 as an auth error", async () => {
    handler = (_q, res) => json(res, 401, { error: { code: "unauthorized", message: "api key required" } });
    const err = await api().getJob("j5").catch((e) => e);
    expect(err).toBeInstanceOf(NloApiError);
    expect((err as NloApiError).status).toBe(401);
  });

  it("reports a dead server as unreachable (status 0)", async () => {
    const dead = createServer();
    await new Promise<void>((resolve, reject) => {
      dead.once("error", reject);
      dead.listen(0, "127.0.0.1", () => resolve());
    });
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => {
      dead.close((e) => (e ? reject(e) : resolve()));
    });
    const a = new NloApi({ apiBase: `http://127.0.0.1:${deadPort}`, apiKey: "k" });
    const err = await a.getJob("j6").catch((e) => e);
    expect(err).toBeInstanceOf(NloApiError);
    expect((err as NloApiError).status).toBe(0);
    expect((err as NloApiError).unreachable).toBe(true);
  });

  it("cancels a job via POST /api/jobs/:id/cancel", async () => {
    requests.length = 0;
    handler = (_q, res) => json(res, 200, { ok: true, cancelled: true, status: "CANCELLED" });
    const r = await api().cancelJob("j7");
    expect(r).toEqual({ ok: true, cancelled: true, status: "CANCELLED" });
    expect(requests[requests.length - 1]!.url).toBe("/api/jobs/j7/cancel");
    expect(requests[requests.length - 1]!.method).toBe("POST");
  });

  it("rejects an unknown job status from the API", async () => {
    handler = (_q, res) =>
      json(res, 200, { id: "j8", status: "BOGUS", answerMarkdown: null, createdAt: "t" });
    const err = await api().getJob("j8").catch((e) => e);
    expect(err).toBeInstanceOf(NloApiError);
    expect((err as NloApiError).status).toBe(502);
  });
});

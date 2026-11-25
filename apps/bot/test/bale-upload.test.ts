import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BaleClient } from "../src/bale.js";

/**
 * BaleClient multipart uploads (sendDocument / sendAudio / sendPhoto). A fake
 * fetch captures the FormData body so the multipart contract (chat_id, caption,
 * file part + name, audio duration) is asserted without a network.
 */

interface Cap {
  url: string;
  body: FormData;
  method: string;
}

interface BaleResp {
  status: number;
  ok: boolean;
  result?: unknown;
  description?: string;
  parameters?: { retry_after?: number };
}

function client(result: (url: string, body: FormData) => BaleResp): BaleClient {
  const fetchImpl = (async (input: unknown, init: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = init.body as FormData;
    const r = result(url, body);
    return new Response(
      JSON.stringify({
        ok: r.ok,
        result: r.result,
        description: r.description,
        parameters: r.parameters,
      }),
      { status: r.status, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return new BaleClient({ token: "tok", fetchImpl });
}

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nlo-bale-"));
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe("BaleClient uploads", () => {
  it("sendDocument posts multipart with chat_id, caption and a named file part", async () => {
    let cap: Cap | null = null;
    const c = client((url, body) => {
      cap = { url, body, method: "POST" };
      return { status: 200, ok: true, result: { message_id: 1 } };
    });
    const p = tempFile("doc.pdf", "PDFBYTES");
    const ok = await c.sendDocument(42, p, "doc.pdf", "سلام");
    expect(ok).toBe(true);
    expect(cap!.url).toBe("https://tapi.bale.ai/bottok/sendDocument");
    expect(cap!.body.get("chat_id")).toBe("42");
    expect(cap!.body.get("caption")).toBe("سلام");
    const file = cap!.body.get("file") as File | null;
    expect(file).toBeInstanceOf(File);
    expect(file!.name).toBe("doc.pdf");
    expect(Buffer.from(await file!.arrayBuffer()).toString()).toBe("PDFBYTES");
  });

  it("sendAudio includes a duration field when provided", async () => {
    let cap: Cap | null = null;
    const c = client((url, body) => {
      cap = { url, body, method: "POST" };
      return { status: 200, ok: true, result: {} };
    });
    const p = tempFile("a.m4a", "AAAA");
    await c.sendAudio(7, p, "a.m4a", "podcast", 125.4);
    expect(cap!.url).toContain("/sendAudio");
    expect(cap!.body.get("duration")).toBe("125");
    expect(cap!.body.get("caption")).toBe("podcast");
  });

  it("sendPhoto posts to sendPhoto", async () => {
    let cap: Cap | null = null;
    const c = client((url, body) => {
      cap = { url, body, method: "POST" };
      return { status: 200, ok: true, result: {} };
    });
    const p = tempFile("i.png", "PNG");
    const ok = await c.sendPhoto(7, p, "i.png");
    expect(ok).toBe(true);
    expect(cap!.url).toContain("/sendPhoto");
    expect(cap!.body.get("chat_id")).toBe("7");
  });

  it("omits caption and duration when not provided", async () => {
    let cap: Cap | null = null;
    const c = client((url, body) => {
      cap = { url, body, method: "POST" };
      return { status: 200, ok: true, result: {} };
    });
    const p = tempFile("a.m4a", "AAAA");
    await c.sendAudio(7, p, "a.m4a");
    expect(cap!.body.get("caption")).toBeNull();
    expect(cap!.body.get("duration")).toBeNull();
  });

  it("returns false (does not throw) on a Bale error", async () => {
    const c = client(() => ({ status: 400, ok: false, description: "bad request" }));
    const p = tempFile("x.pdf", "x");
    const ok = await c.sendDocument(1, p, "x.pdf");
    expect(ok).toBe(false);
  });

  it("retries once on a 429 and succeeds", async () => {
    let calls = 0;
    const c = client(() => {
      calls++;
      if (calls === 1)
        return { status: 429, ok: false, description: "rate limited", parameters: { retry_after: 0 } };
      return { status: 200, ok: true, result: {} };
    });
    // The 429 handler sleeps for retry_after (0 here), so this is fast.
    const p = tempFile("y.pdf", "y");
    const ok = await c.sendDocument(1, p, "y.pdf");
    expect(ok).toBe(true);
    expect(calls).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import { BaleNotifier, baleMessages } from "../src/notify/bale.js";

/**
 * BaleNotifier contract:
 *  - correct URL + JSON body
 *  - disabled (missing token/chat) -> no-op, no fetch
 *  - fetch error / non-2xx -> swallowed, never throws
 *  - token is never logged
 */

interface Call {
  url: string;
  init: RequestInit;
}

function makeFetch(result: { status?: number; body?: string } | Error) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (result instanceof Error) throw result;
    return new Response(result.body ?? "ok", { status: result.status ?? 200 });
  }) as typeof fetch;
  return { calls, impl };
}

describe("BaleNotifier", () => {
  it("sends to the correct URL with chat_id + text body", async () => {
    const { calls, impl } = makeFetch({ status: 200, body: JSON.stringify({ ok: true }) });
    const n = new BaleNotifier({ botToken: "TOKEN123", chatId: "999", fetchImpl: impl });
    expect(n.enabled).toBe(true);

    await n.send("hello");

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://tapi.bale.ai/botTOKEN123/sendMessage");
    expect(call.init.method).toBe("POST");
    const body = JSON.parse(String(call.init.body));
    expect(body.chat_id).toBe("999");
    expect(body.text).toBe("hello");
  });

  it("is a no-op when the token is missing", async () => {
    const { calls, impl } = makeFetch({ status: 200 });
    const logs: string[] = [];
    const n = new BaleNotifier({ botToken: null, chatId: "999", fetchImpl: impl, log: (m) => logs.push(m) });
    expect(n.enabled).toBe(false);

    await n.send("should not send");

    expect(calls.length).toBe(0);
    expect(logs.some((l) => l.includes("disabled"))).toBe(true);
  });

  it("is a no-op when the chat id is missing", async () => {
    const { calls, impl } = makeFetch({ status: 200 });
    const n = new BaleNotifier({ botToken: "TOKEN123", chatId: "   ", fetchImpl: impl });
    expect(n.enabled).toBe(false);

    await n.send("no chat");

    expect(calls.length).toBe(0);
  });

  it("swallows a fetch network error (never throws)", async () => {
    const { impl } = makeFetch(new Error("ECONNREFUSED"));
    const logs: string[] = [];
    const n = new BaleNotifier({ botToken: "T", chatId: "1", fetchImpl: impl, log: (m) => logs.push(m) });

    await expect(n.send("boom")).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("bale send failed"))).toBe(true);
  });

  it("logs (but does not throw on) a non-2xx response", async () => {
    const { impl } = makeFetch({ status: 429, body: "rate limited" });
    const logs: string[] = [];
    const n = new BaleNotifier({ botToken: "T", chatId: "1", fetchImpl: impl, log: (m) => logs.push(m) });

    await expect(n.send("x")).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("HTTP 429"))).toBe(true);
  });

  it("never includes the token in log output", async () => {
    const { impl } = makeFetch(new Error("fail"));
    const logs: string[] = [];
    const n = new BaleNotifier({
      botToken: "SUPERSECRETTOKEN",
      chatId: "1",
      fetchImpl: impl,
      log: (m) => logs.push(m),
    });
    await n.send("x");
    for (const l of logs) {
      expect(l).not.toContain("SUPERSECRETTOKEN");
    }
  });

  it("produces the expected Persian templates", () => {
    expect(baleMessages.expiry("a@gmail.com")).toContain("a@gmail.com");
    expect(baleMessages.expiry("a@gmail.com")).toContain("منقضی شده");
    expect(baleMessages.recovery("a@gmail.com")).toContain("دوباره فعال شد");
    expect(baleMessages.infra("a@gmail.com")).toContain("امکان بررسی");
  });
});

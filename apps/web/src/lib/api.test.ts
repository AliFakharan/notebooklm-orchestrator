import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountsList,
  ApiClientError,
  apiKeyCreate,
  apiKeyRevoke,
  apiKeysList,
  jobCreate,
  jobsList,
  NetworkError,
  providerInfo,
} from "./api";

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request envelope", () => {
  it("returns parsed JSON on 2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          name: "mock",
          isMock: true,
          liveDisabled: true,
          configured: true,
          issues: [],
          capabilities: [],
        }),
      ),
    );
    await expect(providerInfo()).resolves.toMatchObject({ name: "mock", isMock: true });
  });

  it("throws ApiClientError with the envelope on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(404, { error: { code: "not_found", message: "job not found" } }),
        ),
    );
    const err = await accountsList().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).status).toBe(404);
    expect((err as ApiClientError).code).toBe("not_found");
    expect((err as ApiClientError).message).toBe("job not found");
  });

  it("throws NetworkError when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const err = await providerInfo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
  });

  it("omits the auth header (no token model)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    await accountsList();
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });
});

describe("jobsList query building", () => {
  it("encodes status, search, pagination and filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [], total: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await jobsList({
      status: ["RUNNING", "QUEUED"],
      search: "hello",
      limit: 10,
      offset: 20,
      nodeId: "n1",
    });
    const [url] = fetchMock.mock.calls[0]!;
    const u = new URL(url, "http://x");
    expect(u.pathname).toBe("/api/jobs");
    expect(u.searchParams.get("status")).toBe("RUNNING,QUEUED");
    expect(u.searchParams.get("search")).toBe("hello");
    expect(u.searchParams.get("limit")).toBe("10");
    expect(u.searchParams.get("offset")).toBe("20");
    expect(u.searchParams.get("nodeId")).toBe("n1");
  });

  it("omits the query string when no filters are given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [], total: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await jobsList();
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/jobs");
  });
});

describe("api key helpers", () => {
  it("apiKeysList GETs /api/api-keys", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, [
        {
          id: "ak_1",
          name: "litellm",
          prefix: "nlo_ab12",
          createdAt: "2026-11-07T00:00:00Z",
          lastUsedAt: null,
          revokedAt: null,
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const list = await apiKeysList();
    expect(list[0]!.prefix).toBe("nlo_ab12");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/api-keys");
  });

  it("apiKeyCreate POSTs { name } and returns the create envelope (incl. raw key)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        id: "ak_2",
        name: "litellm",
        key: "nlo_rawkey",
        prefix: "nlo_rawk",
        createdAt: "2026-11-07T00:00:00Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const created = await apiKeyCreate("litellm");
    expect(created.key).toBe("nlo_rawkey");
    expect(created.prefix).toBe("nlo_rawk");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/api-keys");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "litellm" }));
  });

  it("apiKeyRevoke POSTs /api/api-keys/:id/revoke", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await apiKeyRevoke("ak_deadbeefdeadbeef");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/api-keys/ak_deadbeefdeadbeef/revoke");
    expect(init.method).toBe("POST");
  });
});

describe("jobCreate multipart", () => {
  it("sends prompt and every file as repeated multipart parts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { id: "j1", status: "CREATED" }));
    vi.stubGlobal("fetch", fetchMock);
    const a = new File(["audio-bytes"], "a.wav", { type: "audio/wav" });
    const b = new File(["pdf-bytes"], "doc.pdf", { type: "application/pdf" });
    await jobCreate({ prompt: "hello", files: [a, b] });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect(body.get("prompt")).toBe("hello");
    const parts = body.getAll("sources") as File[];
    expect(parts.map((f) => f.name)).toEqual(["a.wav", "doc.pdf"]);
  });

  it("sends only the prompt when no files are provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { id: "j2", status: "CREATED" }));
    vi.stubGlobal("fetch", fetchMock);
    await jobCreate({ prompt: "q", files: [] });
    const body = (fetchMock.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(body.get("prompt")).toBe("q");
    expect(body.getAll("sources")).toHaveLength(0);
  });
});

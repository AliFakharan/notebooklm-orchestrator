import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountsList,
  ApiClientError,
  jobCreate,
  jobsList,
  NetworkError,
  providerInfo,
  setAdminToken,
} from "./api";

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  setAdminToken(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  setAdminToken(null);
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

  it("sends the bearer token when one is set", async () => {
    setAdminToken("sekret-token");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    await accountsList();
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sekret-token");
    setAdminToken(null);
  });

  it("omits the auth header when no token is set", async () => {
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

describe("jobCreate multipart", () => {
  it("sends prompt and audio as multipart fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { id: "j1", status: "CREATED" }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["audio-bytes"], "a.wav", { type: "audio/wav" });
    await jobCreate({ prompt: "hello", audio: file, preferredAccountId: "acc1" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect(body.get("prompt")).toBe("hello");
    expect(body.get("preferredAccountId")).toBe("acc1");
    expect((body.get("audio") as File).name).toBe("a.wav");
  });

  it("omits audio and empty preferences", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { id: "j2", status: "CREATED" }));
    vi.stubGlobal("fetch", fetchMock);
    await jobCreate({ prompt: "q", audio: null });
    const body = (fetchMock.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(body.get("prompt")).toBe("q");
    expect(body.get("audio")).toBeNull();
    expect(body.get("preferredAccountId")).toBeNull();
    expect(body.get("preferredNodeId")).toBeNull();
  });
});

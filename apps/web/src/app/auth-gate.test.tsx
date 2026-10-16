import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "./auth-gate";

function readyResponse(ok = true) {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        ok: true,
        ready: ok,
        provider: { name: "mock", configured: true, issues: [] },
        proxyRuntime: { state: "available", name: "mock" },
        liveDisabled: true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(readyResponse()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function AppWithGate() {
  return (
    <AuthGate>
      <main>پنل مدیریت بارگذاری شد</main>
    </AuthGate>
  );
}

describe("AuthGate", () => {
  it("shows the form before verification", async () => {
    render(<AppWithGate />);
    expect(await screen.findByText("ورود به پنل مدیریت")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ورود" })).toBeInTheDocument();
  });

  it("verifies with an empty token (auth disabled) and renders children", async () => {
    const user = userEvent.setup();
    render(<AppWithGate />);
    await user.click(screen.getByRole("button", { name: "ورود" }));
    await waitFor(() => expect(screen.getByText("پنل مدیریت بارگذاری شد")).toBeInTheDocument());
    // The token field should have been sent empty -> no Authorization header.
    const fetchMock = vi.mocked(fetch);
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/api/health/ready");
    expect((init!.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("sends the bearer token when one is typed", async () => {
    const user = userEvent.setup();
    render(<AppWithGate />);
    await user.type(screen.getByLabelText("توکن مدیریت"), "abc123");
    await user.click(screen.getByRole("button", { name: "ورود" }));
    await waitFor(() => expect(screen.getByText("پنل مدیریت بارگذاری شد")).toBeInTheDocument());
    const fetchMock = vi.mocked(fetch);
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect((init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer abc123");
  });

  it("surfaces an error and keeps the form on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { code: "unauthorized", message: "admin token required" } }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
        ),
    );
    const user = userEvent.setup();
    render(<AppWithGate />);
    await user.click(screen.getByRole("button", { name: "ورود" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("admin token required");
    expect(screen.queryByText("پنل مدیریت بارگذاری شد")).not.toBeInTheDocument();
  });
});

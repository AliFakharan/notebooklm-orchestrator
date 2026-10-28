import { describe, expect, it } from "vitest";
import {
  CookieImportError,
  parsePastedCookies,
  toStorageState,
} from "../src/domain/cookie-import.js";

const FUTURE = 2145900000; // 2037

describe("parsePastedCookies", () => {
  it("accepts a Playwright storage state and keeps google cookies only", () => {
    const doc = JSON.stringify({
      cookies: [
        {
          name: "SID",
          value: "s3cr3t",
          domain: ".google.com",
          path: "/",
          expires: FUTURE,
          httpOnly: true,
          secure: true,
          sameSite: "none",
        },
        {
          name: "APISID",
          value: "x",
          domain: ".notebooklm.google.com",
          path: "/",
          expires: FUTURE,
          httpOnly: true,
          secure: true,
          sameSite: "lax",
        },
        {
          name: "unrelated",
          value: "y",
          domain: ".evil.com",
          path: "/",
          expires: FUTURE,
        },
      ],
      origins: [],
    });
    const r = parsePastedCookies(doc);
    expect(r.source).toBe("storage-state");
    const names = r.cookies.map((c) => c.name);
    expect(names).toContain("SID");
    expect(names).toContain("APISID");
    expect(names).not.toContain("unrelated");
    const sid = r.cookies.find((c) => c.name === "SID")!;
    expect(sid.httpOnly).toBe(true);
    expect(sid.secure).toBe(true);
    expect(sid.sameSite).toBe("None");
    expect(sid.expires).toBe(FUTURE);
    const json = JSON.parse(toStorageState(r));
    expect(Array.isArray(json.cookies)).toBe(true);
  });

  it("accepts a Chrome Cookie-Editor JSON array (expirationDate)", () => {
    const arr = JSON.stringify([
      {
        domain: ".google.com",
        expirationDate: FUTURE,
        hostOnly: false,
        httpOnly: true,
        name: "SID",
        path: "/",
        sameSite: "no_restriction",
        secure: true,
        session: false,
        value: "abc",
      },
      {
        domain: "google.com",
        expirationDate: 0, // session cookie -> expires -1
        hostOnly: true,
        httpOnly: false,
        name: "__Secure-1PSID",
        path: "/",
        sameSite: "unspecified",
        secure: true,
        session: true,
        value: "def",
      },
    ]);
    const r = parsePastedCookies(arr);
    expect(r.source).toBe("json-array");
    expect(r.cookies).toHaveLength(2);
    const session = r.cookies.find((c) => c.name === "__Secure-1PSID")!;
    expect(session.expires).toBe(-1);
    const sid = r.cookies.find((c) => c.name === "SID")!;
    expect(sid.expires).toBe(FUTURE);
    expect(sid.sameSite).toBe("None");
  });

  it("accepts a Netscape cookies.txt export with #HttpOnly_ lines", () => {
    const txt = [
      "# Netscape HTTP Cookie File",
      "#HttpOnly_.google.com\tTRUE\t/\tTRUE\t" + FUTURE + "\t__Secure-1PSID\tv1",
      "#HttpOnly_.google.com\tTRUE\t/\tTRUE\t" + FUTURE + "\t__Secure-1PSIDTS\tt1",
      ".google.com\tTRUE\t/\tFALSE\t0\tSID\ts3cr3t",
      ".google.com\tFALSE\t/notebooklm\tTRUE\t" + FUTURE + "\tNID\tn1",
      ".other.com\tTRUE\t/\tFALSE\t0\tNOPE\tn",
    ].join("\n");
    const r = parsePastedCookies(txt);
    expect(r.source).toBe("netscape");
    expect(r.cookies).toHaveLength(4);
    const psid = r.cookies.find((c) => c.name === "__Secure-1PSID")!;
    expect(psid.httpOnly).toBe(true);
    expect(psid.secure).toBe(true);
    const sid = r.cookies.find((c) => c.name === "SID")!;
    expect(sid.expires).toBe(-1); // 0 -> session
    expect(sid.secure).toBe(false);
  });

  it("rejects input without any google.com cookie", () => {
    expect(() => parsePastedCookies('[{"domain":".example.com","name":"a","value":"b"}]')).toThrow(
      CookieImportError,
    );
    expect(() => parsePastedCookies(".example.com\tTRUE\t/\tFALSE\t0\tA\tb")).toThrow(
      CookieImportError,
    );
    expect(() =>
      parsePastedCookies(
        JSON.stringify({ cookies: [{ domain: ".x.com", name: "a", value: "b" }] }),
      ),
    ).toThrow(CookieImportError);
  });

  it("rejects malformed input with actionable messages", () => {
    expect(() => parsePastedCookies("   ")).toThrow(/empty/);
    expect(() => parsePastedCookies("{nope")).toThrow(/not valid/);
    expect(() => parsePastedCookies('{"origins":[]}')).toThrow(/cookies/);
    expect(() => parsePastedCookies("random text without tabs")).toThrow(/no cookie lines/);
    expect(() => parsePastedCookies('[{"value":"no-name"}]')).toThrow(/missing its name/);
    expect(() => parsePastedCookies('[{"name":"n","domain":".google.com"}]')).toThrow(
      /missing its value/,
    );
  });

  it("tolerates a BOM and CRLF line endings", () => {
    const txt = "\ufeff#HttpOnly_.google.com\tTRUE\t/\tTRUE\t0\tSID\ts\r\n\r\n";
    const r = parsePastedCookies(txt);
    expect(r.cookies).toHaveLength(1);
    expect(r.cookies[0]!.name).toBe("SID");
  });
});

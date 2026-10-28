/**
 * Parsing user-pasted browser cookies into a Playwright storage-state
 * document — the credential the python-worker provider stores 0600 and
 * verifies against the REAL service before the account is usable.
 *
 * The user signs into notebooklm.google.com in their own (non-automated)
 * browser, exports the session cookies with any standard "copy cookies"
 * extension, and pastes them into the UI. Accepted input shapes
 * (auto-detected):
 *
 *  1. Playwright storage state:
 *        {"cookies":[{...}], "origins":[{...}]}
 *  2. A JSON cookie array (e.g. the Chrome "Cookie-Editor" export):
 *        [{"domain":".google.com","name":"SID","value":"...","path":"/",
 *          "secure":true,"httpOnly":true,"expirationDate":1735689600}, ...]
 *  3. A Netscape cookies.txt export (e.g. the "Get cookies.txt LOCALLY"
 *     extension, or a manual tab-separated dump):
 *        #HttpOnly_.google.com	TRUE	/	TRUE	1735689600	__Secure-1PSID	v
 *        .google.com	TRUE	/	FALSE	0	SID	abc
 *
 * Hygiene:
 *  - Only google.com-family cookies are kept — the session targets
 *    notebooklm.google.com. A paste containing no google cookie is rejected
 *    with an actionable error instead of being silently stored.
 *  - Session cookies (expiration 0/missing) become expires=-1, the
 *    Playwright convention.
 *  - The parsed document is data only; nothing here is executed or fetched.
 */

export interface ParsedCookieInput {
  cookies: Record<string, unknown>[];
  /** localStorage origins, preserved verbatim from a storage-state paste. */
  origins?: Record<string, unknown>[];
  source: "storage-state" | "json-array" | "netscape";
}

export class CookieImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CookieImportError";
  }
}

/** True for google.com and any subdomain (.google.com, accounts.google.com…). */
function isGoogleDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/^\./, "");
  return d === "google.com" || d.endsWith(".google.com");
}

const SAME_SITE_MAP: Record<string, "Strict" | "Lax" | "None"> = {
  strict: "Strict",
  lax: "Lax",
  no_restriction: "None",
  none: "None",
  unspecified: "Lax",
};

/** Normalize one cookie (any of the accepted shapes) to Playwright form. */
function toPlaywrightCookie(raw: Record<string, unknown>): Record<string, unknown> {
  const name = raw.name;
  const value = raw.value;
  const domain = raw.domain;
  if (typeof name !== "string" || name.length === 0) {
    throw new CookieImportError("a cookie is missing its name");
  }
  if (typeof value !== "string") {
    throw new CookieImportError(`cookie "${name}" is missing its value`);
  }
  if (typeof domain !== "string" || domain.length === 0) {
    throw new CookieImportError(`cookie "${name}" is missing its domain`);
  }
  const path = typeof raw.path === "string" && raw.path.length > 0 ? raw.path : "/";

  // Expiration: Playwright uses `expires` (epoch seconds, -1 = session);
  // Chrome exports use `expirationDate` (epoch seconds, omitted = session).
  let expires: number;
  const rawExpiry = raw.expires ?? raw.expirationDate;
  if (typeof rawExpiry === "number" && Number.isFinite(rawExpiry) && rawExpiry > 0) {
    expires = Math.floor(rawExpiry);
  } else {
    expires = -1;
  }

  const out: Record<string, unknown> = {
    name,
    value,
    domain,
    path,
    expires,
    secure: raw.secure === true || raw.secure === "TRUE",
    httpOnly: raw.httpOnly === true,
  };
  const sameSite = raw.sameSite;
  if (typeof sameSite === "string" && SAME_SITE_MAP[sameSite.toLowerCase()]) {
    out.sameSite = SAME_SITE_MAP[sameSite.toLowerCase()];
  }
  return out;
}

function requireGoogleCookies(cookies: Record<string, unknown>[]): Record<string, unknown>[] {
  const kept = cookies.filter((c) => {
    const d = c.domain;
    return typeof d === "string" && isGoogleDomain(d);
  });
  if (kept.length === 0) {
    throw new CookieImportError(
      "no google.com cookies in the pasted input — export the cookies of the browser profile signed into notebooklm.google.com (a cookies.txt / Cookie-Editor export of the google.com cookies)",
    );
  }
  return kept;
}

/**
 * Detect + parse a pasted cookie export. Throws CookieImportError with an
 * actionable message on any malformed input.
 */
export function parsePastedCookies(text: string): ParsedCookieInput {
  const trimmed = text.replace(/^\uFEFF/, "").trim(); // tolerate a pasted BOM
  if (!trimmed) throw new CookieImportError("the pasted input is empty");

  // 1) Playwright storage state: {"cookies":[...], "origins":[...]}
  if (trimmed.startsWith("{")) {
    let doc: unknown;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      throw new CookieImportError("the pasted JSON is not valid");
    }
    if (
      typeof doc !== "object" ||
      doc === null ||
      !Array.isArray((doc as { cookies?: unknown }).cookies)
    ) {
      throw new CookieImportError(
        'a pasted object must be a Playwright storage state: {"cookies":[...] , "origins":[...]}',
      );
    }
    const docObj = doc as { cookies: unknown[]; origins?: unknown };
    const cookies = requireGoogleCookies(
      docObj.cookies.map((c) => toPlaywrightCookie(c as Record<string, unknown>)),
    );
    const origins =
      Array.isArray(docObj.origins) && docObj.origins.length > 0 ? docObj.origins : undefined;
    return { cookies, origins, source: "storage-state" };
  }

  // 2) JSON cookie array (Cookie-Editor style): [{...}, ...]
  if (trimmed.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch {
      throw new CookieImportError("the pasted JSON array is not valid");
    }
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new CookieImportError("the pasted JSON array is empty");
    }
    const cookies = requireGoogleCookies(
      (arr as Record<string, unknown>[]).map((c) => toPlaywrightCookie(c)),
    );
    return { cookies, source: "json-array" };
  }

  // 3) Netscape cookies.txt (tab-separated; "#HttpOnly_" prefix on lines).
  const cookies: Record<string, unknown>[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (l === "" || (l.startsWith("#") && !l.startsWith("#HttpOnly_"))) continue;
    const httpOnly = l.startsWith("#HttpOnly_");
    const body = httpOnly ? l.slice("#HttpOnly_".length) : l;
    if (body.startsWith("#")) continue; // comment
    const parts = body.split("\t");
    if (parts.length < 7) continue; // not a cookie line (e.g. stray comment)
    const [domain, , path, secure, expires, name, value] = parts;
    cookies.push(
      toPlaywrightCookie({
        domain: domain?.trim(),
        path: path?.trim() || "/",
        expires: Number(expires?.trim()) || 0,
        secure: secure?.trim().toUpperCase() === "TRUE",
        httpOnly,
        name: name?.trim(),
        value: value ?? "",
      }),
    );
  }
  if (cookies.length === 0) {
    throw new CookieImportError(
      "no cookie lines found — expected a Netscape cookies.txt export (tab-separated) or a JSON export",
    );
  }
  return { cookies: requireGoogleCookies(cookies), source: "netscape" };
}

/** Serialize the parsed input back to a Playwright storage-state document. */
export function toStorageState(input: ParsedCookieInput): string {
  const doc: Record<string, unknown> = { cookies: input.cookies };
  if (input.origins) doc.origins = input.origins;
  return JSON.stringify(doc, null, 2);
}

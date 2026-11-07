/**
 * File name safety: user-supplied names NEVER become filesystem paths.
 * We sanitize for display/storage and keep the original in the manifest.
 * Pure (no node builtins) — safe to run server- or client-side.
 */
const ALLOWED_RE = /[^A-Za-z0-9._-]/g;

/**
 * Sanitize a file name to `[A-Za-z0-9._-]` only, cap length, and ensure it is
 * not a path separator or traversal token. Throws on empty results.
 * Pure function (no filesystem access) — safe to run server- or client-side.
 */
export function safeName(original: string, maxLen = 80): string {
  if (!original || typeof original !== "string") {
    throw new Error("file name must be a non-empty string");
  }
  // Take basename only (strip any path, both / and \).
  const lastSlash = Math.max(original.lastIndexOf("/"), original.lastIndexOf("\\"));
  const base = lastSlash >= 0 ? original.slice(lastSlash + 1) : original;

  const cleaned = base
    .replace(/\0/g, "")
    .replace(ALLOWED_RE, "_")
    .replace(/^\.+/, "_") // no leading dots (hidden / traversal)
    .slice(0, maxLen)
    .replace(/\.+$/, ""); // no trailing dots

  if (!cleaned || cleaned === "_") {
    throw new Error("file name is empty after sanitization");
  }
  if (cleaned === "." || cleaned === "..") {
    throw new Error("file name is a traversal token");
  }
  return cleaned;
}

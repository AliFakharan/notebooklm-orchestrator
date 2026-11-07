/**
 * Path containment guard (NODE-ONLY — uses node:path, so it is deliberately
 * NOT part of the "@nlo/shared" barrel; web code must not import it).
 */
import { resolve as nodeResolve, sep as nodeSep } from "node:path";

/**
 * Resolve a path under `root` and verify the result stays inside `root`.
 * Throws if any segment would escape the root (path traversal defense).
 */
export function resolveWithin(root: string, ...segments: string[]): string {
  const cleanRoot = nodeResolve(root).replace(/[\\/]+$/, "");
  const target = nodeResolve(cleanRoot, ...segments);
  if (target !== cleanRoot && !target.startsWith(cleanRoot + nodeSep)) {
    throw new Error(`path escapes root: ${segments.join("/")}`);
  }
  return target;
}

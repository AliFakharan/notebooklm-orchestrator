/**
 * Deterministic fake "notebooklm worker" for PythonWorkerProvider tests.
 *
 * Spawned by WorkerSupervisor exactly like the real worker:
 * `node fake-worker.mjs` (pythonBin = process.execPath). It speaks the same
 * JSON-line protocol as nbl_worker.py (ping/verify).
 *
 * Behavior is driven by env (set by the test before the provider spawns):
 *   FAKE_WORKER_SCRIPT      JSON array of per-verify-attempt outcomes, e.g.
 *                           ["connectivity","ok","auth"]. Attempt i (0-based,
 *                           counted ACROSS spawned worker processes via the
 *                           state file) uses script[i]; missing index -> "ok".
 *                           Valid failure outcomes: any worker error code
 *                           (auth, rate_limit, timeout, connectivity, ...).
 *   FAKE_WORKER_STATE_FILE  Path where the attempt counter is persisted
 *                           (each verify attempt spawns a fresh process).
 *   FAKE_WORKER_DELAY_MS    Sleep this long before answering `verify`
 *                           (widens race windows for drain tests).
 */
import { readFileSync, writeFileSync } from "node:fs";

let script = ["ok"];
try {
  const parsed = JSON.parse(process.env.FAKE_WORKER_SCRIPT ?? "[]");
  if (Array.isArray(parsed) && parsed.length > 0) script = parsed;
} catch {
  /* keep default */
}
const stateFile = process.env.FAKE_WORKER_STATE_FILE ?? null;
const delayMs = Number(process.env.FAKE_WORKER_DELAY_MS ?? 0);

function nextAttemptIndex() {
  if (!stateFile) return 0;
  let count = 0;
  try {
    count = Number(JSON.parse(readFileSync(stateFile, "utf8")).count ?? 0);
  } catch {
    count = 0;
  }
  try {
    writeFileSync(stateFile, JSON.stringify({ count: count + 1 }));
  } catch {
    /* ignore */
  }
  return count;
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let buf = "";
process.stdin.on("data", (chunk) => {
  void (async () => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      if (req.op === "ping") {
        send({ id: req.id, ok: true, result: { version: "fake-worker-1", playwright: false } });
        continue;
      }
      if (req.op === "verify") {
        if (delayMs > 0) await sleep(delayMs);
        const attempt = nextAttemptIndex();
        const outcome = script[attempt] ?? "ok";
        if (outcome === "ok") {
          send({
            id: req.id,
            ok: true,
            result: {
              email: "fake@example.com",
              notebooks: 2,
              checkedAt: new Date().toISOString(),
            },
          });
        } else {
          send({
            id: req.id,
            ok: false,
            error: {
              code: outcome,
              message: `fake worker: scripted ${outcome} failure (attempt ${attempt})`,
            },
          });
        }
        continue;
      }
      send({
        id: req.id,
        ok: false,
        error: { code: "unknown", message: `fake worker: unhandled op ${req.op}` },
      });
    }
  })();
});

process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

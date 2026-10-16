#!/usr/bin/env python3
"""One-off: re-run staged health (target=notebooklm) on ALL proxy nodes after
the Xray v26 runtime fix. Re-enables previously disabled nodes, checks each,
disables failures, marks the best healthy node preferred. Prints egress IPs.
"""

import json
import time
import urllib.request

BASE = "http://127.0.0.1:4870"


def api(method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def main() -> None:
    st, nodes = api("GET", "/api/proxies")
    assert st == 200
    # Re-enable everything so this check is authoritative.
    for n in nodes:
        if not n["enabled"]:
            api("PATCH", f"/api/proxies/{n['id']}", {"enabled": True})

    healthy = []
    for n in nodes:
        name = n["config"]["name"]
        st, r = api("POST", f"/api/proxies/{n['id']}/health", {"target": "notebooklm"})
        if not (isinstance(r, dict) and r.get("ok")):
            # Shared VLESS nodes rate-limit rapid probes; one retry after a
            # backoff avoids false-disabling a good node on a transient reset.
            time.sleep(4)
            st, r = api(
                "POST", f"/api/proxies/{n['id']}/health", {"target": "notebooklm"}
            )
        time.sleep(1.5)  # be gentle between nodes
        ok = isinstance(r, dict) and r.get("ok")
        if ok:
            ip = r.get("egressIp")
            lat = r.get("latencyMs")
            print(f"  OK   {name[:44]:44s} egress={ip} {lat}ms")
            healthy.append((n, ip, lat))
        else:
            err = str((r or {}).get("error"))[:50] if isinstance(r, dict) else "?"
            cat = (r or {}).get("category", "?") if isinstance(r, dict) else "?"
            print(f"  FAIL {name[:44]:44s} cat={cat} {err}")
            api("PATCH", f"/api/proxies/{n['id']}", {"enabled": False})

    print(f"\n{len(healthy)} healthy / {len(nodes)} total")
    if healthy:
        # Prefer the one with the lowest latency.
        best = min(healthy, key=lambda h: h[2] or 10**9)
        api("PATCH", f"/api/proxies/{best[0]['id']}", {"preferred": True})
        print(f"PREFERRED: {best[0]['config']['name']} (egress={best[1]}, {best[2]}ms)")
        print("First 5 healthy (priority order):")
        for n, ip, lat in sorted(healthy, key=lambda h: h[0].get("priority", 999))[:5]:
            print(f"  [{n.get('priority')}] {n['config']['name']} egress={ip} {lat}ms")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""One-off: import the user's VLESS pool via the live API (UUID -> vault).
Deletes the mock placeholder node, adds all real nodes (priority=index),
then runs staged health checks (target=notebooklm) on the top N and
disables the failing ones. Prints a summary. Never prints the UUID.
"""

import json
import urllib.request

BASE = "http://127.0.0.1:4870"

URIS = [
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@finl-212-non-pr.kelmora.ir:443?security=tls&type=ws&path=%2Fhappy-2026-fall#FI-212-non-pr-all",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@finl-212-pr.kelmora.ir:443?security=tls&type=ws&path=%2Fhappy-2026-fall#FI-212-pr-IranSat",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@germ-77-rel.kelmora.ir:30520?security=tls&type=ws&path=%2Fhappy-2026-fall#DE-77-VIP-tunnel-first",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@finrel24.kelmora.ir:30520?security=tls&type=ws&path=%2Fhappy-2026-fall#FI-24-VIP-tunnel-first",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@us2-hw-2.melqora.ir:443?security=tls&type=ws&path=%2Fhappy-2026-fall#US2-VIP-CF",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@us2-hw-12.melqora.ir:443?security=tls&type=ws&path=%2Fhappy-2026-fall#US2-VIP-Di",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@germ-77-non-pr.kelmora.ir:443?security=tls&type=ws&path=%2Fhappy-2026-fall#DE-77-non-pr-all",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@germ-77-pr.kelmora.ir:443?security=tls&type=ws&path=%2Fhappy-2026-fall#DE-77-pr-IranSat",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@finrel24.kelmora.ir:30530?security=tls&type=ws&path=%2Fhappy-2026-fall#FI-24-VIP-tunnel-first-2",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@germ2-cdn-3.zarveto.ir:443?security=tls&type=ws&path=%2Fhappy-2026-fall#DE-CDN-CF-VIP",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@germ2-cdn-13.zarveto.ir:443?security=tls&type=ws&path=%2Fhappy-2026-fall#DE-CDN-Di-VIP",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@germ-77-rel.kelmora.ir:30570?security=tls&type=ws&path=%2Fhappy-2026-fall#DE-77-VIP-English-tunnel",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@finrel24.kelmora.ir:30570?security=tls&type=ws&path=%2Fhappy-2026-fall#FI-24-VIP-English-tunnel",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn1.zarveto.ir:443?security=tls&type=ws&path=%2Fhappy-2026-fall#DE-CDN-VIP-English-CF",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn11.zarveto.ir:443?security=tls&type=ws&path=%2Fhappy-2026-fall#DE-CDN-VIP-English-Di",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@germ-77-rel.kelmora.ir:30540?security=tls&type=ws&path=%2Fhappy-2026-fall#DE-77-VIP-FI-tunnel-first",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@germ-77-rel.kelmora.ir:30550?security=tls&type=ws&path=%2Fhappy-2026-fall#DE-77-VIP-Youtube-tunnel",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@finrel24.kelmora.ir:30550?security=tls&type=ws&path=%2Fhappy-2026-fall#FI-24-VIP-Youtube-tunnel",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@germ-77-rel.kelmora.ir:30535?security=tls&type=ws&path=%2Fhappy-2026-fall#DE-77-VIP-HL-tunnel-first",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@germ-77-rel.kelmora.ir:30536?security=tls&type=ws&path=%2Fhappy-2026-fall#DE-77-VIP-ALB-tunnel-first",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@germ-77-rel.kelmora.ir:30560?security=tls&type=ws&path=%2Fhappy-2026-fall#DE-77-VIP-Saudi-tunnel",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@finrel24.kelmora.ir:30560?security=tls&type=ws&path=%2Fhappy-2026-fall#FI-24-VIP-Saudi-tunnel",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@germ-77-rel.kelmora.ir:30580?security=tls&type=ws&path=%2Fhappy-2026-fall#DE-77-VIP-TRK-tunnel-first",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@finrel24.kelmora.ir:30580?security=tls&type=ws&path=%2Fhappy-2026-fall#FI-24-VIP-TRK-tunnel-first",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn-sp27-11.torqena.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#ES-SP27-all",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn-sp27-1.torqena.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#ES-SP27-IranSat",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn-sp27-rel-11.torqena.ir:30550?security=tls&type=ws&path=%2Fhappy-2026-winter#ES-SP27-VIP-Youtube-tunnel",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@utah-pr.zarveto.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#UT-VIP-Youtube-CF",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@utah-nonpr.zarveto.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#UT-VIP-Youtube-Di",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn-sp27-rel-11.torqena.ir:30560?security=tls&type=ws&path=%2Fhappy-2026-winter#ES-SP27-Saudi-tunnel",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@swd-sport-2.nelqora.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#SA-VIP-Saudi-CF",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@swd-sport-12.nelqora.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#SA-VIP-Saudi-Di",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn-sp27-rel-11.torqena.ir:30536?security=tls&type=ws&path=%2Fhappy-2026-winter#ES-SP27-ALB-tunnel-youtube",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@alb-cdn-2.nelqora.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#ALB-CDN-VIP-CF-youtube",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@alb-cdn-12.nelqora.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#ALB-CDN-VIP-Di-youtube",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn-sp27-rel-11.torqena.ir:30535?security=tls&type=ws&path=%2Fhappy-2026-winter#ES-SP27-HL-tunnel-first",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn102.novrisa.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#HL-CDN-CF",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn112.novrisa.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#HL-CDN-Di",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn-sp27-rel-11.torqena.ir:30540?security=tls&type=ws&path=%2Fhappy-2026-winter#ES-SP27-FI-tunnel-first",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn-sp27-rel-11.torqena.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#ES-SP27-FI-CF",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@pay1fn.kafshora.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#FI-PAY-CF2",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn112.qemitra.ir:443?security=tls&type=ws&path=%2Fhappy-2026-fall#FI-CDN-Di",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn-sp27-rel-11.torqena.ir:30530?security=tls&type=ws&path=%2Fhappy-2026-winter#ES-SP27-DE-tunnel-first",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn16.qemitra.ir:30524?security=tls&type=ws&path=%2Fhappy-2026-winter#DE-CDN-IranSat-tunnel",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn3.torvixa.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#DE-CDN-CF",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@pay4gm.velnaro.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#DE-CDN-CF2",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn13.torvixa.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#DE-CDN-Di",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn-alp-020.qemitra.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#RU-CDN-CF",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn-alp-021.qemitra.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#RU-CDN-Di",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn-sp27-rel-11.torqena.ir:30580?security=tls&type=ws&path=%2Fhappy-2026-winter#ES-SP27-TRK-tunnel-first",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn2.nelqora.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#TR-CDN-CF",
    "vless://b625fad2-69f4-44ed-ae30-ac01486bf5a4@cdn13.nelqora.ir:443?security=tls&type=ws&path=%2Fhappy-2026-winter#TR-CDN-Di",
]


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
    # 1. Delete the mock placeholder node.
    st, nodes = api("GET", "/api/proxies")
    assert st == 200, (st, nodes)
    for n in nodes:
        if n["config"]["name"] == "mock-node":
            st2, _ = api("DELETE", f"/api/proxies/{n['id']}")
            print(f"removed mock node {n['id']} -> {st2}")

    # 2. Add all real nodes (priority = index).
    added = []
    for i, uri in enumerate(URIS):
        st, r = api("POST", "/api/proxies", {"uri": uri, "priority": i})
        if st == 201:
            added.append((i, r["node"]["id"], r["node"]["config"]["name"]))
            print(
                f"  added [{i:02d}] {r['node']['config']['name']} -> {r['node']['id']}"
            )
        else:
            print(f"  FAILED [{i:02d}] -> {st}: {str(r)[:120]}")

    # 3. Staged health check (target=notebooklm) on the top 12; disable failures.
    print("\nhealth checks (top 12, target=notebooklm.google.com:443):")
    healthy = []
    for i, nid, name in added[:12]:
        st, r = api("POST", f"/api/proxies/{nid}/health", {"target": "notebooklm"})
        ok = isinstance(r, dict) and r.get("ok")
        ip = (r or {}).get("egressIp") if isinstance(r, dict) else None
        cat = (r or {}).get("category") if isinstance(r, dict) else "?"
        err = (r or {}).get("error") if isinstance(r, dict) else "?"
        print(
            f"  [{i:02d}] {name[:40]:40s} ok={ok} egress={ip} cat={cat} err={str(err)[:60]}"
        )
        if ok:
            healthy.append((i, nid, name, ip))
        else:
            api("PATCH", f"/api/proxies/{nid}", {"enabled": False})
            print(f"       -> disabled {name}")
        if len(healthy) >= 4:
            break

    print(f"\nSUMMARY: {len(added)} nodes added; {len(healthy)} healthy so far:")
    for i, nid, name, ip in healthy:
        print(f"  [{i:02d}] {name} egress={ip}")
    print("first healthy node set preferred=true")
    if healthy:
        api("PATCH", f"/api/proxies/{healthy[0][1]}", {"preferred": True})


if __name__ == "__main__":
    main()

from __future__ import annotations

import json
import math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "sample_assets.json"
PORT = 8765

ROAD_WEIGHTS = np.array([25, 20, 15, 15, 10, 10, 5], dtype=float)
BRIDGE_WEIGHTS = np.array([30, 25, 10, 15, 10, 5, 5], dtype=float)


def load_sample() -> list[dict[str, Any]]:
    return json.loads(DATA.read_text(encoding="utf-8"))


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def features(record: dict[str, Any]) -> np.ndarray:
    return np.array([
        float(record.get("condition", 0)),
        float(record.get("criticality", 0)),
        float(record.get("traffic", 0)),
        float(record.get("climate", 0)),
        float(record.get("safety", 0)),
        float(record.get("equity", 0)),
        float(record.get("readiness", 0)),
    ], dtype=float)


def priority_score(record: dict[str, Any]) -> float:
    weights = BRIDGE_WEIGHTS if record.get("assetType") == "Bridge" else ROAD_WEIGHTS
    return float(np.round(np.dot(features(record), weights) / 5.0, 2))


def neural_risk(records: list[dict[str, Any]]) -> dict[str, float]:
    """Small deterministic two-hidden-layer neural risk model.

    The model is intentionally dependency-light and auditable. It behaves like a
    compact MLP: normalized engineering features -> hidden risk interactions ->
    sigmoid risk probability. In production, replace the fixed weights with
    trained weights from historical completed-work and deterioration data.
    """
    out: dict[str, float] = {}
    w1 = np.array([
        [0.72, 0.55, 0.18, 0.62, 0.66, 0.22, -0.28],
        [0.30, 0.78, 0.40, 0.35, 0.75, 0.28, -0.18],
        [0.62, 0.35, 0.18, 0.84, 0.44, 0.30, -0.22],
        [0.15, 0.45, 0.22, 0.28, 0.35, 0.66, -0.12],
    ])
    w2 = np.array([
        [0.78, 0.52, 0.72, 0.38],
        [0.40, 0.72, 0.48, 0.55],
    ])
    w3 = np.array([0.62, 0.55])
    for rec in records:
        x = features(rec) / 5.0
        h1 = np.maximum(0, w1 @ x)
        h2 = np.maximum(0, w2 @ h1)
        logit = float(w3 @ h2 - 0.88)
        risk = 1 / (1 + math.exp(-logit))
        if rec.get("maintainable") == "No":
            risk = min(0.99, risk + 0.25)
        out[str(rec.get("assetId"))] = round(float(risk), 4)
    return out


def kmeans(points: np.ndarray, k: int = 3, iterations: int = 20) -> tuple[np.ndarray, np.ndarray]:
    if len(points) == 0:
        return np.empty((0,), dtype=int), np.empty((0, 2))
    k = min(k, len(points))
    centroids = points[np.linspace(0, len(points) - 1, k).astype(int)].copy()
    labels = np.zeros(len(points), dtype=int)
    for _ in range(iterations):
        dist = ((points[:, None, :] - centroids[None, :, :]) ** 2).sum(axis=2)
        labels = dist.argmin(axis=1)
        for i in range(k):
            if np.any(labels == i):
                centroids[i] = points[labels == i].mean(axis=0)
    return labels, centroids


def geospatial_analysis(records: list[dict[str, Any]], risks: dict[str, float]) -> dict[str, Any]:
    pts = np.array([[float(r.get("lat", 0)), float(r.get("lon", 0))] for r in records], dtype=float)
    labels, centroids = kmeans(pts, 3)
    hotspots = []
    for idx, centroid in enumerate(centroids):
        members = [records[i] for i, lab in enumerate(labels) if lab == idx]
        if not members:
            continue
        avg_risk = float(np.mean([risks[str(m.get("assetId"))] for m in members]))
        hotspots.append({
            "cluster": int(idx + 1),
            "lat": round(float(centroid[0]), 5),
            "lon": round(float(centroid[1]), 5),
            "assets": len(members),
            "averageRisk": round(avg_risk, 4),
            "dominantRegion": max(set(m.get("region", "Unclassified") for m in members), key=[m.get("region", "Unclassified") for m in members].count),
        })

    nearest = {}
    bridges = [r for r in records if r.get("assetType") == "Bridge"]
    roads = [r for r in records if r.get("assetType") == "Road"]
    for road in roads:
        if not bridges:
            nearest[road["assetId"]] = None
            continue
        candidates = sorted(
            (
                (bridge["assetId"], haversine_km(float(road["lat"]), float(road["lon"]), float(bridge["lat"]), float(bridge["lon"])))
                for bridge in bridges
            ),
            key=lambda x: x[1],
        )
        nearest[road["assetId"]] = {"bridgeId": candidates[0][0], "distanceKm": round(candidates[0][1], 2)}

    bbox = {
        "minLat": round(float(pts[:, 0].min()), 5),
        "maxLat": round(float(pts[:, 0].max()), 5),
        "minLon": round(float(pts[:, 1].min()), 5),
        "maxLon": round(float(pts[:, 1].max()), 5),
    }
    return {"hotspots": hotspots, "nearestBridge": nearest, "bbox": bbox}


def programme(records: list[dict[str, Any]], budget: float) -> list[dict[str, Any]]:
    enriched = []
    for rec in records:
        cost = float(rec.get("quantity", 0)) * float(rec.get("unitRate", 0))
        eligibility = "Referral" if rec.get("maintainable") == "No" else ("Eligible" if cost > 0 else "Check cost")
        enriched.append({**rec, "cost": cost, "score": priority_score(rec), "eligibility": eligibility})
    enriched.sort(key=lambda x: x["score"], reverse=True)
    running = 0.0
    for idx, rec in enumerate(enriched, 1):
        if rec["eligibility"] == "Referral":
            status = "Referred"
        elif rec["eligibility"] != "Eligible":
            status = rec["eligibility"]
        elif running + rec["cost"] <= budget:
            status = "Selected"
            running += rec["cost"]
        else:
            status = "Deferred"
        rec["rank"] = idx
        rec["status"] = status
    return enriched


def analyse(payload: dict[str, Any]) -> dict[str, Any]:
    records = payload.get("records") or load_sample()
    budget = float(payload.get("budget", 250_000_000))
    reserve = float(payload.get("reservePercent", 5))
    net_budget = budget * (1 - reserve / 100)
    risks = neural_risk(records)
    prog = programme(records, net_budget)
    for item in prog:
        item["mlRisk"] = risks.get(item["assetId"], 0)
        item["riskBand"] = "High" if item["mlRisk"] >= 0.72 else ("Medium" if item["mlRisk"] >= 0.55 else "Low")
    selected_cost = sum(x["cost"] for x in prog if x["status"] == "Selected")
    deferred_cost = sum(x["cost"] for x in prog if x["status"] == "Deferred")
    return {
        "netBudget": round(net_budget, 2),
        "programme": prog,
        "ml": {
            "model": "Deterministic two-hidden-layer NumPy MLP risk model",
            "riskByAsset": risks,
            "note": "Replace fixed weights with trained historical deterioration and completed-works data for production calibration.",
        },
        "geospatial": geospatial_analysis(records, risks),
        "summary": {
            "records": len(records),
            "selectedCost": round(selected_cost, 2),
            "deferredCost": round(deferred_cost, 2),
            "referrals": sum(1 for x in prog if x["status"] == "Referred"),
            "selected": sum(1 for x in prog if x["status"] == "Selected"),
            "highRisk": sum(1 for x in prog if x["riskBand"] == "High"),
        },
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: Any) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        self._send(200, {"ok": True})

    def do_GET(self) -> None:
        if self.path.startswith("/api/health"):
            self._send(200, {"ok": True, "service": "DUCAR ML/geospatial API"})
        elif self.path.startswith("/api/sample"):
            self._send(200, {"records": load_sample()})
        elif self.path.startswith("/api/analyse"):
            self._send(200, analyse({"records": load_sample()}))
        else:
            self._send(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if not self.path.startswith("/api/analyse"):
            self._send(404, {"error": "Not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
            self._send(200, analyse(payload))
        except Exception as exc:
            self._send(400, {"error": str(exc)})

    def log_message(self, fmt: str, *args: Any) -> None:
        print("%s - %s" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"DUCAR ML/geospatial API running at http://127.0.0.1:{PORT}")
    server.serve_forever()

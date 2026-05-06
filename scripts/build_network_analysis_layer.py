"""Build clean road-network analysis layers for the web app.

The app still keeps the full unified source layer for audit/provenance, but this
script creates a cartographic/network layer that is deduplicated, node-joined,
and suitable for flow visualisation.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import linemerge, transform, unary_union

from uganda_layers_manifest import update_manifest

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public" / "data"
DATA = ROOT / "data"
SOURCE = PUBLIC / "uganda_unified_roads_web_2026-05-05.geojson"
if not SOURCE.exists():
    SOURCE = PUBLIC / "uganda_unified_roads_web.geojson"

EDGES_OUT = PUBLIC / "uganda_network_edges_web.geojson"
CARTO_OUT = PUBLIC / "uganda_clean_road_routes_web.geojson"
NODES_OUT = PUBLIC / "uganda_network_nodes_web.geojson"
FLOWS_OUT = PUBLIC / "uganda_traffic_flows_web.geojson"
MATRIX_OUT = PUBLIC / "uganda_route_matrix.json"
SUMMARY_OUT = PUBLIC / "uganda_network_analysis_summary.json"
MATRIX_ARCHIVE_OUT = DATA / "uganda_route_matrix.json"
SUMMARY_ARCHIVE_OUT = DATA / "uganda_network_analysis_summary.json"


SYSTEM_PRIORITY = {
    "National": 1,
    "CBD Selected": 2,
    "Urban": 3,
    "DUCAR": 4,
    "Open mapping": 5,
}


def drop_z(geom):
    if geom is None or geom.is_empty:
        return geom
    return transform(lambda x, y, z=None: (x, y), geom)


def iter_lines(geom):
    if geom is None or geom.is_empty:
        return
    if isinstance(geom, LineString):
        yield geom
    elif isinstance(geom, MultiLineString):
        for part in geom.geoms:
            yield part


def snap_coord(coord, precision=4):
    return (round(float(coord[0]), precision), round(float(coord[1]), precision))


def canonical_key(line):
    coords = list(line.coords)
    if len(coords) < 2:
        return None
    start = snap_coord(coords[0])
    end = snap_coord(coords[-1])
    middle = snap_coord(coords[len(coords) // 2])
    return tuple(sorted([start, end])) + (middle,)


def category(row):
    system = str(row.get("road_system") or "")
    cls = str(row.get("road_class") or "")
    source = str(row.get("road_source") or "")
    if system == "National":
        return "National Roads"
    if source == "KCCA roads":
        return "KCCA"
    if system == "CBD Selected" or cls in {"Urban Road", "Urban CBD Priority Link"}:
        return "City Roads"
    if cls in {"Community Access Road", "Community Access Roads", "CAR"}:
        return "Community Access Roads"
    if cls in {"Municipal Road", "Municipal Roads", "M"}:
        return "Municipal Roads"
    if cls in {"Town Council Road", "Town Council Roads", "TC"}:
        return "Town Council Roads"
    return "District Roads"


def flow_index(row):
    cls = str(row.get("network_category") or "")
    length = float(row.get("length_km") or 0)
    base = {
        "National Roads": 92,
        "KCCA": 82,
        "City Roads": 74,
        "Municipal Roads": 61,
        "District Roads": 54,
        "Town Council Roads": 44,
        "Community Access Roads": 34,
    }.get(cls, 40)
    length_bump = min(18, math.log1p(max(length, 0)) * 4)
    return int(min(100, round(base + length_bump)))


def clean_text(value, fallback="Unassigned"):
    text = str(value or "").strip()
    return text if text and text.lower() not in {"nan", "none", "null"} else fallback


def display_route_key(row):
    name = clean_text(row.get("road_name"), "Unnamed road")
    if name.lower() in {"unnamed road", "road", "unknown"}:
        name = f"{clean_text(row.get('road_source'))}-{clean_text(row.get('road_class'))}"
    return "|".join(
        [
            clean_text(row.get("network_category")),
            clean_text(row.get("road_system")),
            clean_text(row.get("district")),
            name.lower(),
            clean_text(row.get("surface")),
        ]
    )


def merge_group_geometries(geoms):
    unioned = unary_union(list(geoms))
    if isinstance(unioned, LineString):
        return unioned
    return linemerge(unioned)


def build_cartographic_routes(edges):
    route_rows = []
    working = edges.copy()
    working["route_key"] = working.apply(display_route_key, axis=1)
    for index, (route_key, group) in enumerate(working.groupby("route_key", dropna=False), start=1):
        first = group.iloc[0]
        geom = merge_group_geometries(group.geometry)
        route_rows.append(
            {
                "route_id": f"R{index:05d}",
                "route_key": route_key,
                "road_name": clean_text(first.get("road_name"), "Unnamed road"),
                "road_system": clean_text(first.get("road_system")),
                "road_source": clean_text(first.get("road_source")),
                "road_class": clean_text(first.get("road_class")),
                "network_category": clean_text(first.get("network_category")),
                "surface": clean_text(first.get("surface")),
                "district": clean_text(first.get("district")),
                "region": clean_text(first.get("region")),
                "segment_count": int(len(group)),
                "length_km": round(float(group["length_km"].sum()), 3),
                "traffic_flow_index": int(round(float(group["traffic_flow_index"].mean()))),
                "ducar_analysis_scope": clean_text(first.get("ducar_analysis_scope")),
                "geometry": geom,
            }
        )
    routes = gpd.GeoDataFrame(route_rows, geometry="geometry", crs=edges.crs)
    routes = routes[routes.geometry.notna() & ~routes.geometry.is_empty].copy()
    routes["geometry"] = routes.geometry.simplify(0.00012, preserve_topology=True)
    routes_m = routes.to_crs(epsg=32636)
    routes["length_km"] = (routes_m.length / 1000).round(3)
    routes = routes[routes["length_km"] >= 0.03].copy()
    routes = routes.sort_values(["network_category", "district", "road_name"]).reset_index(drop=True)
    routes["route_id"] = [f"R{i:05d}" for i in range(1, len(routes) + 1)]
    return routes


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    gdf = gpd.read_file(SOURCE).to_crs(epsg=4326)
    gdf["geometry"] = gdf.geometry.apply(drop_z)

    rows = []
    seen = {}
    candidate_segments = 0
    for _, row in gdf.iterrows():
        for line in iter_lines(row.geometry):
            candidate_segments += 1
            key = canonical_key(line)
            if not key:
                continue
            priority = SYSTEM_PRIORITY.get(str(row.get("road_system")), 9)
            length_km = float(row.get("length_km") or 0)
            candidate = {
                "priority": priority,
                "length_km": length_km,
                "row": row,
                "geometry": line,
            }
            previous = seen.get(key)
            if previous is None or (priority, -length_km) < (previous["priority"], -previous["length_km"]):
                seen[key] = candidate

    node_ids = {}
    node_degree = defaultdict(int)

    def node_id(coord):
        snapped = snap_coord(coord)
        if snapped not in node_ids:
            node_ids[snapped] = f"N{len(node_ids) + 1:06d}"
        node_degree[snapped] += 1
        return node_ids[snapped]

    for item in seen.values():
        coords = list(item["geometry"].coords)
        item["from_node"] = node_id(coords[0])
        item["to_node"] = node_id(coords[-1])

    for index, item in enumerate(seen.values(), start=1):
        row = item["row"]
        cat = category(row)
        rows.append(
            {
                "edge_id": f"E{index:06d}",
                "from_node": item["from_node"],
                "to_node": item["to_node"],
                "road_name": row.get("road_name") or "Unnamed road",
                "road_system": row.get("road_system"),
                "road_source": row.get("road_source"),
                "road_class": row.get("road_class"),
                "network_category": cat,
                "surface": row.get("surface"),
                "district": row.get("district"),
                "region": row.get("region"),
                "length_km": round(float(item["length_km"] or 0), 3),
                "traffic_flow_index": 0,
                "ducar_analysis_scope": row.get("ducar_analysis_scope"),
                "geometry": item["geometry"],
            }
        )

    edges = gpd.GeoDataFrame(rows, geometry="geometry", crs="EPSG:4326")
    edges_m = edges.to_crs(epsg=32636)
    edges["length_km"] = (edges_m.length / 1000).round(3)
    edges = edges[edges["length_km"] >= 0.01].copy()
    edges["traffic_flow_index"] = edges.apply(flow_index, axis=1)
    edges.to_file(EDGES_OUT, driver="GeoJSON")
    cartographic_routes = build_cartographic_routes(edges)
    cartographic_routes.to_file(CARTO_OUT, driver="GeoJSON")

    node_rows = []
    for coord, nid in node_ids.items():
        node_rows.append(
            {
                "node_id": nid,
                "degree": int(node_degree[coord]),
                "junction_type": "junction" if node_degree[coord] > 2 else "terminal" if node_degree[coord] == 1 else "through-node",
                "geometry": Point(coord),
            }
        )
    nodes = gpd.GeoDataFrame(node_rows, geometry="geometry", crs="EPSG:4326")
    nodes.to_file(NODES_OUT, driver="GeoJSON")

    flows = cartographic_routes.sort_values(["traffic_flow_index", "length_km"], ascending=False).head(900).copy()
    flows.to_file(FLOWS_OUT, driver="GeoJSON")

    district_edges = cartographic_routes[cartographic_routes["district"].notna() & (cartographic_routes["district"].astype(str) != "Unassigned")].copy()
    district_summary = (
        district_edges.groupby("district")
        .agg(length_km=("length_km", "sum"), flow=("traffic_flow_index", "mean"), records=("route_id", "count"))
        .sort_values("length_km", ascending=False)
        .head(12)
        .reset_index()
    )
    centroids = district_edges.to_crs(epsg=32636).dissolve(by="district").centroid.to_crs(epsg=4326)
    matrix = []
    for _, a in district_summary.iterrows():
        for _, b in district_summary.iterrows():
            if a["district"] == b["district"]:
                continue
            ca = centroids.get(a["district"])
            cb = centroids.get(b["district"])
            if ca is None or cb is None:
                continue
            straight_km = ca.distance(cb) * 111.32
            demand = round((float(a["flow"]) + float(b["flow"])) / 2 * (float(a["length_km"]) + float(b["length_km"])) / 200, 1)
            matrix.append(
                {
                    "origin": a["district"],
                    "destination": b["district"],
                    "straight_distance_km": round(straight_km, 1),
                    "network_impedance_km": round(straight_km * 1.34, 1),
                    "traffic_flow_index": int(min(100, demand)),
                }
            )

    summary = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": str(SOURCE),
        "edge_count": int(len(edges)),
        "cartographic_route_count": int(len(cartographic_routes)),
        "node_count": int(len(nodes)),
        "source_record_count": int(len(gdf)),
        "candidate_segment_count": int(candidate_segments),
        "deduplicated_segment_count": int(len(edges)),
        "duplicate_reduction_count": int(candidate_segments - len(edges)),
        "total_length_km": round(float(cartographic_routes["length_km"].sum()), 2),
        "by_network_category": cartographic_routes.groupby("network_category").size().to_dict(),
        "route_matrix_pairs": len(matrix),
        "method": "Endpoint snapping at 4 decimal degrees, geometry-based length recalculation, route-key dissolve by category/system/district/name/surface, light topology-preserving simplification, node degree calculation, district centroid route matrix.",
    }
    matrix_payload = {"summary": summary, "districts": district_summary.to_dict("records"), "routes": matrix}
    MATRIX_OUT.write_text(json.dumps(matrix_payload, indent=2), encoding="utf-8")
    SUMMARY_OUT.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    MATRIX_ARCHIVE_OUT.write_text(json.dumps(matrix_payload, indent=2), encoding="utf-8")
    SUMMARY_ARCHIVE_OUT.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    update_manifest(
        ROOT,
        {
            "network_edges_geojson": str(EDGES_OUT),
            "cartographic_roads_geojson": str(CARTO_OUT),
            "network_nodes_geojson": str(NODES_OUT),
            "traffic_flows_geojson": str(FLOWS_OUT),
            "route_matrix_json": str(MATRIX_OUT),
            "network_analysis_summary": str(SUMMARY_OUT),
        },
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

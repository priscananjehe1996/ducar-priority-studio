"""Build the unified DUCAR SQLite evidence database.

The public app reads this database with SQL in the browser. The full evidence
JSON remains a build artifact, while the database stores normalized tables for
documents, raw table cells, global case rows, spatial layers, file inventory,
story cards, online source checks, programme assets and lightweight map
features for the geospatial interface.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
PUBLIC_DATA = ROOT / "public" / "data"
EVIDENCE_JSON = PUBLIC_DATA / "evidence_synthesis.json"
PRODUCT_JSON = PUBLIC_DATA / "product_insights.json"
SAMPLE_ASSETS = DATA / "sample_assets.json"
OUT_DATA = DATA / "ducar_unified.sqlite"
OUT_PUBLIC = PUBLIC_DATA / "ducar_unified.sqlite"
MANIFEST_PUBLIC = PUBLIC_DATA / "ducar_unified_manifest.json"
MANIFEST_DATA = DATA / "ducar_unified_manifest.json"

PIMS_FLOW_STEPS = [
    (1, "Concept profile", "Admission", "Project profile, logical framework and options are checked before budget competition.", 78, "PIMS"),
    (2, "Feasibility screen", "Appraisal", "Technical, financial, economic, risk and distribution analysis controls shape readiness.", 66, "PIMS"),
    (3, "HDM-4 economics", "Economic case", "Traffic, roughness, treatment effect, user cost and EIRR assumptions convert needs into benefits.", 72, "HDM-4"),
    (4, "RAM planning", "Network plan", "Condition, lifecycle need, GIS traceability and work standards become investment packages.", 84, "RAM"),
    (5, "Budget gate", "Fiscal control", "Reserve, affordability, selected cost and deferred demand decide what enters the workplan.", 69, "PIMS"),
    (6, "Monitoring loop", "Delivery", "PIMS, QA, field condition and budget absorption data feed the next condition cycle.", 76, "PIMS"),
]

PIMS_GATE_CONTROLS = [
    ("Concept", "Need statement, location, beneficiary logic and candidate option set", "Stops unnamed or unsupported assets entering the pipeline", 78),
    ("Feasibility", "Engineering scope, safeguard risk, implementation capacity and cost basis", "Separates maintenance-ready work from design referrals", 66),
    ("Economic appraisal", "NPV, EIRR, sensitivity, traffic growth and user-benefit assumptions", "Connects HDM-4 style benefits to PIMS investment logic", 72),
    ("Risk screen", "Climate, safety, maintainability, procurement and data-quality risk", "Moves weak candidates into clarification before funding", 81),
    ("Final investment decision", "Budget envelope, reserve, workplan packaging and monitoring indicators", "Keeps the selected programme affordable and auditable", 88),
]

HDM4_INDICATORS = [
    ("Fleet loading", "Representative vehicle and ESAL inputs", 84),
    ("Climate stress", "Rainfall, temperature and drainage exposure", 76),
    ("Deterioration readiness", "Roughness, cracking, rutting and pothole models", 81),
    ("Work effects", "Treatment reset, service life and unit-cost assumptions", 79),
    ("Road user effects", "VOC, time, safety and emissions benefit streams", 73),
    ("Economic parameters", "Discount, period, contingency and threshold settings", 88),
]

HDM4_MODEL_INPUTS = [
    ("Representative vehicles", "Fleet class parameters", "Motorcycle to articulated truck classes, GVW, ESAL and fleet shares", "Traffic and axle loading"),
    ("Climate zones", "Screening assumptions", "Rainfall, moisture class and temperature bands for Ugandan climate risk", "Climate and drainage"),
    ("Axle loading", "Vehicle mass and overloading", "Legal limit, observed loading and overload share by vehicle type", "Traffic and axle loading"),
    ("Road deterioration", "Calibration placeholders", "Cracking, ravelling, rutting, roughness, potholing and edge-break factors", "Road condition"),
    ("Work effects", "Treatment response", "IRI reset, service life and planning-cost ranges by treatment", "Maintenance planning"),
    ("Road user effects", "Economic effects", "VOC, time, safety and emissions benefit channels", "PIMS appraisal"),
    ("Unit costs", "Planning cost range", "Construction, periodic and routine costs by surface type", "Budget monitoring"),
    ("Traffic flow and speed", "Capacity assumptions", "Free-flow speed, capacity, peak-hour share and seasonal factors", "Traffic and axle loading"),
    ("Economic parameters", "Appraisal defaults", "Discount rate, analysis period, contingency and EIRR threshold", "PIMS appraisal"),
]


def load_json(path: Path, fallback: Any) -> Any:
    if not path.exists():
        return fallback
    return json.loads(path.read_text(encoding="utf-8"))


def text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def execute_many(conn: sqlite3.Connection, sql: str, rows: list[tuple]) -> int:
    if not rows:
        return 0
    conn.executemany(sql, rows)
    return len(rows)


def unlink_with_retry(path: Path, attempts: int = 8) -> None:
    if not path.exists():
        return
    for attempt in range(attempts):
        try:
            path.unlink()
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.35 * (attempt + 1))


def replace_with_retry(source: Path, target: Path, attempts: int = 18) -> None:
    for attempt in range(attempts):
        try:
            source.replace(target)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(min(2.0, 0.35 * (attempt + 1)))


def sample_items(items: list[Any], limit: int) -> list[Any]:
    if limit <= 0 or len(items) <= limit:
        return items
    step = len(items) / limit
    return [items[min(len(items) - 1, int(index * step))] for index in range(limit)]


def valid_position(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) >= 2
        and isinstance(value[0], (int, float))
        and isinstance(value[1], (int, float))
        and 27 <= float(value[0]) <= 37
        and -4 <= float(value[1]) <= 6
    )


def simplify_line(coords: list[Any], limit: int = 48) -> list[list[float]]:
    valid = [[round(float(item[0]), 6), round(float(item[1]), 6)] for item in coords if valid_position(item)]
    if len(valid) <= limit:
        return valid
    step = (len(valid) - 1) / (limit - 1)
    simplified = [valid[min(len(valid) - 1, round(index * step))] for index in range(limit)]
    return simplified


def longest_part(parts: list[Any]) -> list[Any]:
    valid_parts = [part for part in parts if isinstance(part, list)]
    if not valid_parts:
        return []
    return max(valid_parts, key=len)


def geometry_surface(geometry: dict[str, Any]) -> tuple[str, Any] | None:
    geometry_type = geometry.get("type")
    coords = geometry.get("coordinates")
    if geometry_type == "Point" and valid_position(coords):
        return ("Point", [round(float(coords[0]), 6), round(float(coords[1]), 6)])
    if geometry_type == "MultiPoint":
        points = [point for point in coords or [] if valid_position(point)]
        if points:
            return ("Point", [round(float(points[0][0]), 6), round(float(points[0][1]), 6)])
    if geometry_type == "LineString":
        line = simplify_line(coords or [])
        if len(line) > 1:
            return ("LineString", line)
    if geometry_type == "MultiLineString":
        line = simplify_line(longest_part(coords or []))
        if len(line) > 1:
            return ("LineString", line)
    if geometry_type == "Polygon":
        ring = simplify_line(longest_part(coords or []), 60)
        if len(ring) > 2:
            return ("Polygon", ring)
    if geometry_type == "MultiPolygon":
        polygon = longest_part(coords or [])
        ring = simplify_line(longest_part(polygon), 60)
        if len(ring) > 2:
            return ("Polygon", ring)
    return None


def feature_name(properties: dict[str, Any]) -> str | None:
    for key in ("name", "road_name", "ref", "highway", "district", "route_name"):
        value = properties.get(key)
        if value:
            return str(value)
    return None


def load_map_surface_features() -> list[tuple]:
    specs = [
        ("district", "districts.geojson", 80),
        ("route", "uganda_clean_road_routes_web.geojson", 170),
        ("national", "uganda_national_roads_fy25_26_2026-05-13.geojson", 110),
        ("flow", "uganda_traffic_flows_web.geojson", 95),
        ("node", "uganda_network_nodes_web.geojson", 360),
    ]
    rows = []
    feature_id = 1
    for group, file_name, limit in specs:
        path = PUBLIC_DATA / file_name
        if not path.exists() and group == "national":
            path = PUBLIC_DATA / "uganda_national_roads_fy25_26.geojson"
        payload = load_json(path, {})
        features = payload.get("features", []) if isinstance(payload, dict) else []
        for feature in sample_items(features, limit):
            geometry = feature.get("geometry") or {}
            surface = geometry_surface(geometry)
            if not surface:
                continue
            geometry_type, coords = surface
            properties = feature.get("properties") or {}
            metric = number(properties.get("traffic") or properties.get("flow") or properties.get("length_km") or properties.get("Shape_Leng"))
            rows.append((
                feature_id,
                group,
                path.name,
                feature_name(properties),
                geometry_type,
                json.dumps(coords, ensure_ascii=False),
                metric,
            ))
            feature_id += 1
    return rows


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode = DELETE;
        PRAGMA foreign_keys = ON;

        CREATE TABLE metadata (
          key TEXT PRIMARY KEY,
          value TEXT
        );

        CREATE TABLE raw_json_payloads (
          name TEXT PRIMARY KEY,
          json_text TEXT NOT NULL
        );

        CREATE TABLE evidence_documents (
          doc_id INTEGER PRIMARY KEY,
          name TEXT,
          path TEXT,
          source_area TEXT,
          extension TEXT,
          bytes INTEGER,
          pages INTEGER,
          tables INTEGER,
          words INTEGER,
          characters INTEGER,
          dominant_topic TEXT,
          status TEXT
        );

        CREATE TABLE document_summary_points (
          doc_id INTEGER,
          point_index INTEGER,
          summary_point TEXT,
          FOREIGN KEY (doc_id) REFERENCES evidence_documents(doc_id)
        );

        CREATE TABLE document_topic_counts (
          doc_id INTEGER,
          topic TEXT,
          mentions INTEGER,
          FOREIGN KEY (doc_id) REFERENCES evidence_documents(doc_id)
        );

        CREATE TABLE source_coverage (
          chart_name TEXT,
          label TEXT,
          value REAL
        );

        CREATE TABLE document_topic_summary (
          topic TEXT PRIMARY KEY,
          mentions INTEGER,
          share REAL,
          decision_use TEXT
        );

        CREATE TABLE story_cards (
          title TEXT PRIMARY KEY,
          metric TEXT,
          label TEXT,
          story TEXT,
          evidence TEXT,
          tone TEXT
        );

        CREATE TABLE raw_table_cells (
          table_group TEXT,
          table_name TEXT,
          source TEXT,
          row_index INTEGER,
          column_index INTEGER,
          column_name TEXT,
          value TEXT
        );

        CREATE TABLE table_catalog (
          table_group TEXT,
          table_name TEXT,
          source TEXT,
          row_count INTEGER,
          column_count INTEGER
        );

        CREATE TABLE online_sources (
          source_group TEXT,
          title TEXT,
          agency TEXT,
          url TEXT,
          status TEXT,
          words INTEGER,
          dominant_topic TEXT,
          evidence_score REAL
        );

        CREATE TABLE spatial_layers (
          layer_id INTEGER PRIMARY KEY,
          file_name TEXT,
          layer_name TEXT,
          path TEXT,
          source_area TEXT,
          extension TEXT,
          bytes INTEGER,
          feature_count INTEGER,
          line_length_km REAL,
          polygon_area_km2 REAL,
          column_count INTEGER,
          columns_json TEXT,
          crs TEXT,
          bounds_json TEXT,
          status TEXT,
          decision_use TEXT
        );

        CREATE TABLE spatial_geometry_counts (
          layer_id INTEGER,
          geometry_type TEXT,
          feature_count INTEGER,
          FOREIGN KEY (layer_id) REFERENCES spatial_layers(layer_id)
        );

        CREATE TABLE map_surface_features (
          feature_id INTEGER PRIMARY KEY,
          feature_group TEXT,
          source_file TEXT,
          name TEXT,
          geometry_type TEXT,
          coordinates_json TEXT,
          metric REAL
        );

        CREATE TABLE uganda_network_kpis (
          label TEXT PRIMARY KEY,
          value TEXT,
          note TEXT,
          sort_order INTEGER
        );

        CREATE TABLE uganda_network_categories (
          category TEXT PRIMARY KEY,
          length_km REAL,
          ducar_scope TEXT
        );

        CREATE TABLE uganda_road_condition (
          category TEXT PRIMARY KEY,
          good_km REAL,
          fair_km REAL,
          poor_km REAL,
          total_km REAL,
          poor_share REAL
        );

        CREATE TABLE uganda_crash_trend (
          year INTEGER PRIMARY KEY,
          fatal INTEGER,
          serious INTEGER,
          minor INTEGER,
          total INTEGER
        );

        CREATE TABLE uganda_paved_trend (
          fy TEXT PRIMARY KEY,
          annual_increase_km REAL,
          paved_stock_km REAL,
          percent_paved REAL
        );

        CREATE TABLE pims_framework_steps (
          step_order INTEGER PRIMARY KEY,
          title TEXT,
          phase TEXT,
          description TEXT,
          readiness_score REAL,
          discipline TEXT
        );

        CREATE TABLE pims_gate_controls (
          gate TEXT PRIMARY KEY,
          required_evidence TEXT,
          decision_use TEXT,
          readiness_score REAL
        );

        CREATE TABLE hdm4_indicators (
          indicator TEXT PRIMARY KEY,
          description TEXT,
          readiness_score REAL
        );

        CREATE TABLE hdm4_model_inputs (
          model_input TEXT PRIMARY KEY,
          unit TEXT,
          assumption TEXT,
          evidence_topic TEXT
        );

        CREATE TABLE file_inventory (
          file_id INTEGER PRIMARY KEY,
          name TEXT,
          path TEXT,
          source_area TEXT,
          extension TEXT,
          kind TEXT,
          bytes INTEGER,
          modified TEXT
        );

        CREATE TABLE programme_assets (
          asset_id TEXT PRIMARY KEY,
          asset_type TEXT,
          district TEXT,
          region TEXT,
          functional_class TEXT,
          intervention TEXT,
          surface TEXT,
          condition_score REAL,
          criticality_score REAL,
          traffic_score REAL,
          climate_score REAL,
          safety_score REAL,
          equity_score REAL,
          readiness_score REAL,
          maintainable TEXT,
          quantity REAL,
          unit_rate REAL,
          cost_ugx REAL,
          lat REAL,
          lon REAL
        );

        CREATE INDEX idx_documents_source_area ON evidence_documents(source_area);
        CREATE INDEX idx_documents_topic ON evidence_documents(dominant_topic);
        CREATE INDEX idx_cells_table ON raw_table_cells(table_group, table_name);
        CREATE INDEX idx_spatial_feature_count ON spatial_layers(feature_count DESC);
        CREATE INDEX idx_map_surface_group ON map_surface_features(feature_group);
        CREATE INDEX idx_condition_poor_share ON uganda_road_condition(poor_share DESC);
        CREATE INDEX idx_inventory_kind ON file_inventory(kind);
        CREATE INDEX idx_assets_region ON programme_assets(region);
        """
    )


def insert_table(conn: sqlite3.Connection, table_group: str, key: str, table: dict) -> int:
    if not table:
        return 0
    title = table.get("title") or key
    source = table.get("source") or table_group
    columns = [str(column) for column in table.get("columns", [])]
    rows = table.get("rows", [])
    conn.execute(
        "INSERT INTO table_catalog VALUES (?, ?, ?, ?, ?)",
        (table_group, title, source, int(table.get("row_count", len(rows)) or 0), int(table.get("column_count", len(columns)) or 0)),
    )
    cell_rows = []
    for row_index, row in enumerate(rows):
        for column_index, value in enumerate(row):
            column_name = columns[column_index] if column_index < len(columns) else f"Column {column_index + 1}"
            cell_rows.append((table_group, title, source, row_index, column_index, column_name, text(value)))
    return execute_many(
        conn,
        "INSERT INTO raw_table_cells VALUES (?, ?, ?, ?, ?, ?, ?)",
        cell_rows,
    )


def build_database() -> dict[str, Any]:
    evidence = load_json(EVIDENCE_JSON, {})
    product = load_json(PRODUCT_JSON, {})
    sample_assets = load_json(SAMPLE_ASSETS, [])

    tmp_data = OUT_DATA.with_name(f".{OUT_DATA.name}.{os.getpid()}.tmp")
    unlink_with_retry(tmp_data)
    conn = sqlite3.connect(tmp_data)
    try:
        create_schema(conn)
        conn.executemany(
            "INSERT INTO metadata VALUES (?, ?)",
            [
                ("generated_at_utc", evidence.get("generated_at_utc", "")),
                ("method", json.dumps(evidence.get("method", {}), ensure_ascii=False)),
                ("source", "D:/OneDrive/Procurements/TOR - DUCACR"),
            ],
        )
        conn.executemany(
            "INSERT INTO raw_json_payloads VALUES (?, ?)",
            [
                ("evidence_synthesis", json.dumps(evidence, ensure_ascii=False)),
                ("product_insights", json.dumps(product, ensure_ascii=False)),
            ],
        )

        doc_rows = []
        point_rows = []
        topic_rows = []
        for doc_id, doc in enumerate(evidence.get("documents", []), start=1):
            doc_rows.append((
                doc_id,
                doc.get("name"),
                doc.get("path"),
                doc.get("source_area"),
                doc.get("extension"),
                int(doc.get("bytes", 0) or 0),
                int(doc.get("pages", 0) or 0),
                int(doc.get("tables", 0) or 0),
                int(doc.get("words", 0) or 0),
                int(doc.get("characters", 0) or 0),
                doc.get("dominant_topic"),
                doc.get("status"),
            ))
            for point_index, point in enumerate(doc.get("summary_points", [])):
                point_rows.append((doc_id, point_index, point))
            for topic, count in (doc.get("topic_counts") or {}).items():
                topic_rows.append((doc_id, topic, int(count or 0)))
        execute_many(conn, "INSERT INTO evidence_documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", doc_rows)
        execute_many(conn, "INSERT INTO document_summary_points VALUES (?, ?, ?)", point_rows)
        execute_many(conn, "INSERT INTO document_topic_counts VALUES (?, ?, ?)", topic_rows)

        coverage_rows = []
        for chart_key, chart in (evidence.get("sourceCoverage") or {}).items():
            for row in chart.get("rows", []):
                if len(row) >= 2:
                    coverage_rows.append((chart_key, text(row[0]), number(row[1])))
        execute_many(conn, "INSERT INTO source_coverage VALUES (?, ?, ?)", coverage_rows)

        execute_many(
            conn,
            "INSERT INTO document_topic_summary VALUES (?, ?, ?, ?)",
            [
                (item.get("topic"), int(item.get("mentions", 0) or 0), number(item.get("share")), item.get("decision_use"))
                for item in evidence.get("documentTopicChart", [])
            ],
        )

        execute_many(
            conn,
            "INSERT INTO story_cards VALUES (?, ?, ?, ?, ?, ?)",
            [
                (card.get("title"), text(card.get("metric")), card.get("label"), card.get("story"), card.get("evidence"), card.get("tone"))
                for card in evidence.get("storyCards", [])
            ],
        )

        cell_count = 0
        for key, table in (evidence.get("casePackageTables") or {}).items():
            cell_count += insert_table(conn, "case_package", key, table)
        for key, table in (evidence.get("transportCharts") or {}).items():
            cell_count += insert_table(conn, "transport", key, table)
        for key, table in (evidence.get("itisTables") or {}).items():
            cell_count += insert_table(conn, "itis", key, table)
        for index, table in enumerate(evidence.get("tabularExtracts", [])):
            cell_count += insert_table(conn, "local_extract", f"extract_{index}", table)

        itis_charts = evidence.get("itisCharts") or {}
        itis_tables = itis_charts.get("charts") or {}
        execute_many(
            conn,
            "INSERT INTO uganda_network_kpis VALUES (?, ?, ?, ?)",
            [
                (item.get("label"), item.get("value"), item.get("note"), index)
                for index, item in enumerate(itis_charts.get("kpis", []), start=1)
            ],
        )
        execute_many(
            conn,
            "INSERT INTO uganda_network_categories VALUES (?, ?, ?)",
            [
                (row[0], number(row[1]), row[2] if len(row) > 2 else None)
                for row in (itis_tables.get("network") or {}).get("rows", [])
            ],
        )
        execute_many(
            conn,
            "INSERT INTO uganda_road_condition VALUES (?, ?, ?, ?, ?, ?)",
            [
                (row[0], number(row[1]), number(row[2]), number(row[3]), number(row[4]), number(row[3]) / max(1, number(row[4])))
                for row in (itis_tables.get("condition") or {}).get("rows", [])
            ],
        )
        execute_many(
            conn,
            "INSERT INTO uganda_crash_trend VALUES (?, ?, ?, ?, ?)",
            [
                (int(row[0]), int(row[1] or 0), int(row[2] or 0), int(row[3] or 0), int(row[4] or 0))
                for row in (itis_tables.get("crashes") or {}).get("rows", [])
            ],
        )
        execute_many(
            conn,
            "INSERT INTO uganda_paved_trend VALUES (?, ?, ?, ?)",
            [
                (row[0], number(row[1]), number(row[2]), number(row[3]))
                for row in (itis_tables.get("pavedTrend") or {}).get("rows", [])
            ],
        )
        execute_many(conn, "INSERT INTO pims_framework_steps VALUES (?, ?, ?, ?, ?, ?)", PIMS_FLOW_STEPS)
        execute_many(conn, "INSERT INTO pims_gate_controls VALUES (?, ?, ?, ?)", PIMS_GATE_CONTROLS)
        execute_many(conn, "INSERT INTO hdm4_indicators VALUES (?, ?, ?)", HDM4_INDICATORS)
        execute_many(conn, "INSERT INTO hdm4_model_inputs VALUES (?, ?, ?, ?)", HDM4_MODEL_INPUTS)

        execute_many(
            conn,
            "INSERT INTO online_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    item.get("group"),
                    item.get("title"),
                    item.get("agency"),
                    item.get("url"),
                    item.get("status"),
                    int(item.get("words", 0) or 0),
                    item.get("dominant_topic"),
                    number(item.get("evidence_score")),
                )
                for item in evidence.get("onlineSources", [])
            ],
        )

        spatial_rows = []
        geom_rows = []
        for layer_id, item in enumerate((evidence.get("spatialEvidence") or {}).get("records", []), start=1):
            spatial_rows.append((
                layer_id,
                item.get("name"),
                item.get("layer"),
                item.get("path"),
                item.get("source_area"),
                item.get("extension"),
                int(item.get("bytes", 0) or 0),
                int(item.get("feature_count", 0) or 0),
                number(item.get("line_length_km")),
                number(item.get("polygon_area_km2")),
                int(item.get("column_count", 0) or 0),
                json.dumps(item.get("columns", []), ensure_ascii=False),
                item.get("crs"),
                json.dumps(item.get("bounds", []), ensure_ascii=False),
                item.get("status"),
                item.get("decision_use"),
            ))
            for geometry_type, feature_count in item.get("geometry_types", []):
                geom_rows.append((layer_id, geometry_type, int(feature_count or 0)))
        execute_many(conn, "INSERT INTO spatial_layers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", spatial_rows)
        execute_many(conn, "INSERT INTO spatial_geometry_counts VALUES (?, ?, ?)", geom_rows)

        map_rows = load_map_surface_features()
        execute_many(conn, "INSERT INTO map_surface_features VALUES (?, ?, ?, ?, ?, ?, ?)", map_rows)

        inventory_rows = []
        for file_id, item in enumerate(((evidence.get("fileInventory") or {}).get("fileTable") or {}).get("rows", []), start=1):
            inventory_rows.append((
                file_id,
                item[0] if len(item) > 0 else None,
                item[6] if len(item) > 6 else None,
                item[1] if len(item) > 1 else None,
                item[3] if len(item) > 3 else None,
                item[2] if len(item) > 2 else None,
                int(number(item[4]) * 1024 * 1024) if len(item) > 4 else 0,
                item[5] if len(item) > 5 else None,
            ))
        execute_many(conn, "INSERT INTO file_inventory VALUES (?, ?, ?, ?, ?, ?, ?, ?)", inventory_rows)

        asset_rows = []
        for asset in sample_assets:
            quantity = number(asset.get("quantity"))
            unit_rate = number(asset.get("unitRate"))
            asset_rows.append((
                asset.get("assetId"),
                asset.get("assetType"),
                asset.get("admin"),
                asset.get("region"),
                asset.get("functionalClass"),
                asset.get("intervention"),
                asset.get("surface"),
                number(asset.get("condition")),
                number(asset.get("criticality")),
                number(asset.get("traffic")),
                number(asset.get("climate")),
                number(asset.get("safety")),
                number(asset.get("equity")),
                number(asset.get("readiness")),
                asset.get("maintainable"),
                quantity,
                unit_rate,
                quantity * unit_rate,
                number(asset.get("lat")),
                number(asset.get("lon")),
            ))
        execute_many(conn, "INSERT INTO programme_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", asset_rows)

        conn.commit()
        conn.execute("VACUUM")
    finally:
        conn.close()

    replace_with_retry(tmp_data, OUT_DATA)
    OUT_PUBLIC.write_bytes(OUT_DATA.read_bytes())
    manifest = {
        "database": "data/ducar_unified.sqlite",
        "generated_at_utc": evidence.get("generated_at_utc"),
        "tables": {
            "evidence_documents": len(evidence.get("documents", [])),
            "document_topic_counts": len(topic_rows),
            "raw_table_cells": cell_count,
            "online_sources": len(evidence.get("onlineSources", [])),
            "spatial_layers": len((evidence.get("spatialEvidence") or {}).get("records", [])),
            "map_surface_features": len(map_rows),
            "uganda_network_kpis": len((evidence.get("itisCharts") or {}).get("kpis", [])),
            "uganda_network_categories": len(((evidence.get("itisCharts") or {}).get("charts") or {}).get("network", {}).get("rows", [])),
            "uganda_road_condition": len(((evidence.get("itisCharts") or {}).get("charts") or {}).get("condition", {}).get("rows", [])),
            "pims_framework_steps": len(PIMS_FLOW_STEPS),
            "hdm4_indicators": len(HDM4_INDICATORS),
            "file_inventory": len(inventory_rows),
            "programme_assets": len(asset_rows),
        },
        "size_bytes": OUT_PUBLIC.stat().st_size,
        "sql_examples": {
            "executive": "SELECT title, metric, story FROM story_cards ORDER BY title;",
            "spatial": "SELECT layer_name, feature_count, line_length_km FROM spatial_layers WHERE status = 'read' ORDER BY feature_count DESC LIMIT 8;",
            "map": "SELECT feature_group, geometry_type, coordinates_json FROM map_surface_features ORDER BY feature_group, feature_id;",
            "network": "SELECT category, length_km, ducar_scope FROM uganda_network_categories ORDER BY length_km DESC;",
            "pims": "SELECT title, phase, readiness_score FROM pims_framework_steps ORDER BY step_order;",
            "hdm4": "SELECT indicator, readiness_score FROM hdm4_indicators ORDER BY readiness_score DESC;",
            "raw_tables": "SELECT table_group, table_name, COUNT(*) AS cells FROM raw_table_cells GROUP BY table_group, table_name ORDER BY cells DESC;",
        },
    }
    MANIFEST_PUBLIC.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    MANIFEST_DATA.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    print(json.dumps(build_database(), indent=2))

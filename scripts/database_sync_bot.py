"""DUCAR database sync bot.

The bot rebuilds the unified SQLite database, fingerprints source files, runs
materialized SQL population queries, and writes prediction feature tables used
by the public app. It is safe for GitHub Actions: when the local OneDrive source
folder is unavailable, it syncs from the committed repo data instead.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import build_unified_database


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
PUBLIC_DATA = ROOT / "public" / "data"
OUT_DATA = DATA / "ducar_unified.sqlite"
OUT_PUBLIC = PUBLIC_DATA / "ducar_unified.sqlite"
MANIFEST_DATA = DATA / "ducar_unified_manifest.json"
MANIFEST_PUBLIC = PUBLIC_DATA / "ducar_unified_manifest.json"
REPORT_DATA = DATA / "ducar_sync_report.json"
REPORT_PUBLIC = PUBLIC_DATA / "ducar_sync_report.json"

DEFAULT_EXTERNAL_SOURCE = Path(r"D:\OneDrive\Procurements\TOR - DUCACR")
SOURCE_EXTENSIONS = {
    ".csv",
    ".dbf",
    ".doc",
    ".docx",
    ".geojson",
    ".gpkg",
    ".json",
    ".md",
    ".pdf",
    ".ppt",
    ".pptx",
    ".prj",
    ".shp",
    ".shx",
    ".sqlite",
    ".txt",
    ".xls",
    ".xlsx",
}
EXCLUDED_DIRS = {".git", "__pycache__", "node_modules", "dist", "build", ".vite"}
EXCLUDED_FILE_NAMES = {
    "ducar_unified.sqlite",
    "ducar_unified_manifest.json",
    "ducar_sync_report.json",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_roots() -> list[Path]:
    configured = os.environ.get("DUCAR_SOURCE_ROOT")
    candidates = [
        Path(configured) if configured else None,
        DEFAULT_EXTERNAL_SOURCE,
        ROOT / "data",
        ROOT / "public" / "data",
        ROOT / "public" / "docs",
    ]
    roots: list[Path] = []
    for candidate in candidates:
        if candidate and candidate.exists():
            resolved = candidate.resolve()
            if resolved not in roots:
                roots.append(resolved)
    return roots


def source_area(path: Path) -> str:
    normalized = str(path).replace("\\", "/").lower()
    if "/public/data/" in normalized:
        return "public data artifacts"
    if "/public/docs/" in normalized:
        return "public document artifacts"
    if "/github_app/data/" in normalized:
        return "repo data artifacts"
    if "road transport data" in normalized:
        return "road transport data"
    if "evidence_and_case_studies" in normalized:
        return "global case and evidence package"
    if "gis" in normalized or path.suffix.lower() in {".shp", ".geojson", ".gpkg"}:
        return "geospatial source data"
    if "workbooks" in normalized or path.suffix.lower() in {".xls", ".xlsx", ".csv"}:
        return "local workbook source data"
    return "local source corpus"


def iter_source_files(roots: list[Path]) -> list[Path]:
    files: dict[str, Path] = {}
    for root in roots:
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            if any(part in EXCLUDED_DIRS for part in path.parts):
                continue
            if path.name in EXCLUDED_FILE_NAMES:
                continue
            if path.suffix.lower() not in SOURCE_EXTENSIONS:
                continue
            files[str(path.resolve())] = path.resolve()
    return sorted(files.values(), key=lambda item: str(item).lower())


def read_previous_hashes() -> dict[str, str]:
    if not OUT_DATA.exists():
        return {}
    try:
        with sqlite3.connect(OUT_DATA) as conn:
            exists = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_sync_state'"
            ).fetchone()
            if not exists:
                return {}
            return {row[0]: row[1] for row in conn.execute("SELECT path, sha256 FROM source_sync_state")}
    except sqlite3.Error:
        return {}


def create_bot_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS bot_sync_runs (
          run_id TEXT PRIMARY KEY,
          started_at_utc TEXT,
          completed_at_utc TEXT,
          source_root_count INTEGER,
          source_file_count INTEGER,
          changed_file_count INTEGER,
          database_size_bytes INTEGER,
          status TEXT,
          note TEXT
        );

        CREATE TABLE IF NOT EXISTS source_sync_state (
          path TEXT PRIMARY KEY,
          source_area TEXT,
          extension TEXT,
          bytes INTEGER,
          modified_utc TEXT,
          sha256 TEXT,
          indexed_at_utc TEXT,
          change_state TEXT
        );

        CREATE TABLE IF NOT EXISTS sql_population_log (
          run_id TEXT,
          query_name TEXT,
          sql_text TEXT,
          rows_written INTEGER,
          status TEXT,
          executed_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS network_prediction_context (
          category TEXT PRIMARY KEY,
          total_km REAL,
          poor_km REAL,
          poor_share REAL,
          network_pressure_score REAL
        );

        CREATE TABLE IF NOT EXISTS prediction_feature_matrix (
          asset_id TEXT PRIMARY KEY,
          condition_score REAL,
          criticality_score REAL,
          traffic_score REAL,
          climate_score REAL,
          safety_score REAL,
          equity_score REAL,
          readiness_score REAL,
          cost_ugx REAL,
          evidence_score REAL,
          pims_gate_score REAL,
          hdm4_readiness_score REAL,
          network_pressure_score REAL,
          risk_probability REAL,
          recommended_status TEXT,
          monitoring_tier TEXT,
          updated_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS prediction_calibration_signals (
          signal TEXT PRIMARY KEY,
          value REAL,
          basis TEXT,
          updated_at_utc TEXT
        );
        """
    )


def insert_source_state(conn: sqlite3.Connection, files: list[Path], previous: dict[str, str], indexed_at: str) -> int:
    rows = []
    changed = 0
    for path in files:
        stat = path.stat()
        digest = sha256_file(path)
        key = str(path)
        if key not in previous:
            change_state = "indexed"
            changed += 1
        elif previous[key] != digest:
            change_state = "changed"
            changed += 1
        else:
            change_state = "unchanged"
        rows.append((
            key,
            source_area(path),
            path.suffix.lower(),
            int(stat.st_size),
            datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(timespec="seconds"),
            digest,
            indexed_at,
            change_state,
        ))
    conn.execute("DELETE FROM source_sync_state")
    conn.executemany("INSERT INTO source_sync_state VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
    return changed


def execute_population_query(conn: sqlite3.Connection, run_id: str, name: str, sql: str, target_table: str) -> int:
    conn.executescript(sql)
    rows = conn.execute(f"SELECT COUNT(*) FROM {target_table}").fetchone()[0]
    conn.execute(
        "INSERT INTO sql_population_log VALUES (?, ?, ?, ?, ?, ?)",
        (run_id, name, sql.strip(), int(rows or 0), "ok", utc_now()),
    )
    return int(rows or 0)


def run_materialized_queries(conn: sqlite3.Connection, run_id: str, completed_at: str, changed_files: int) -> dict[str, int]:
    queries = {
        "network_prediction_context": ("network_prediction_context", """
            DELETE FROM network_prediction_context;
            INSERT INTO network_prediction_context
            SELECT
              category,
              total_km,
              poor_km,
              poor_share,
              MIN(1.0, MAX(0.05, poor_share)) AS network_pressure_score
            FROM uganda_road_condition;
        """),
        "prediction_feature_matrix": ("prediction_feature_matrix", f"""
            DELETE FROM prediction_feature_matrix;
            INSERT INTO prediction_feature_matrix
            WITH averages AS (
              SELECT
                (SELECT AVG(readiness_score) FROM pims_gate_controls) AS pims_gate_score,
                (SELECT AVG(readiness_score) FROM hdm4_indicators) AS hdm4_readiness_score
            ),
            contextual_assets AS (
              SELECT
                p.*,
                COALESCE(
                  CASE
                    WHEN LOWER(p.functional_class) LIKE '%community%' THEN (SELECT network_pressure_score FROM network_prediction_context WHERE category = 'Community Access Roads')
                    WHEN LOWER(p.functional_class) LIKE '%district%' THEN (SELECT network_pressure_score FROM network_prediction_context WHERE category = 'District Roads')
                    WHEN LOWER(p.functional_class) LIKE '%urban%' THEN (SELECT network_pressure_score FROM network_prediction_context WHERE category = 'City Roads')
                    ELSE (SELECT AVG(network_pressure_score) FROM network_prediction_context)
                  END,
                  0.5
                ) AS network_pressure_score
              FROM programme_assets p
            )
            SELECT
              asset_id,
              condition_score,
              criticality_score,
              traffic_score,
              climate_score,
              safety_score,
              equity_score,
              readiness_score,
              cost_ugx,
              100.0 AS evidence_score,
              averages.pims_gate_score,
              averages.hdm4_readiness_score,
              contextual_assets.network_pressure_score,
              ROUND(
                MIN(0.99, MAX(0.01,
                  (
                    ((condition_score * 1.35) + (criticality_score * 1.15) + (traffic_score * 0.9) +
                     (climate_score * 1.05) + (safety_score * 1.1) + ((5 - readiness_score) * 0.8)) / 31.75
                  ) * 0.74 + contextual_assets.network_pressure_score * 0.26
                )),
                4
              ) AS risk_probability,
              CASE
                WHEN maintainable = 'No' THEN 'Refer for design'
                WHEN ROUND(MIN(0.99, MAX(0.01,
                  (
                    ((condition_score * 1.35) + (criticality_score * 1.15) + (traffic_score * 0.9) +
                     (climate_score * 1.05) + (safety_score * 1.1) + ((5 - readiness_score) * 0.8)) / 31.75
                  ) * 0.74 + contextual_assets.network_pressure_score * 0.26
                )), 4) >= 0.72 THEN 'Design check'
                ELSE 'Model-ready'
              END AS recommended_status,
              CASE
                WHEN condition_score + climate_score + safety_score >= 12 THEN 'Monthly'
                WHEN condition_score + climate_score + safety_score >= 9 THEN 'Quarterly'
                ELSE 'Semi-annual'
              END AS monitoring_tier,
              '{completed_at}' AS updated_at_utc
            FROM contextual_assets, averages;
        """),
        "prediction_calibration_signals": ("prediction_calibration_signals", f"""
            DELETE FROM prediction_calibration_signals;
            INSERT INTO prediction_calibration_signals
            SELECT 'avg_prediction_risk', AVG(risk_probability), 'prediction_feature_matrix risk_probability', '{completed_at}'
            FROM prediction_feature_matrix;
            INSERT INTO prediction_calibration_signals
            SELECT 'avg_pims_gate_score', AVG(readiness_score), 'pims_gate_controls readiness_score', '{completed_at}'
            FROM pims_gate_controls;
            INSERT INTO prediction_calibration_signals
            SELECT 'avg_hdm4_readiness', AVG(readiness_score), 'hdm4_indicators readiness_score', '{completed_at}'
            FROM hdm4_indicators;
            INSERT INTO prediction_calibration_signals
            SELECT 'network_poor_share', SUM(poor_km) / MAX(1, SUM(total_km)), 'uganda_road_condition poor_km / total_km', '{completed_at}'
            FROM uganda_road_condition;
            INSERT INTO prediction_calibration_signals
            VALUES ('changed_source_files', {changed_files}, 'source_sync_state changed or newly indexed files', '{completed_at}');
            INSERT INTO prediction_calibration_signals
            SELECT 'source_files_indexed', COUNT(*), 'source_sync_state file count', '{completed_at}'
            FROM source_sync_state;
        """),
    }
    result = {}
    conn.execute("DELETE FROM sql_population_log WHERE run_id = ?", (run_id,))
    for name, (target_table, sql) in queries.items():
        result[name] = execute_population_query(conn, run_id, name, sql, target_table)
    return result


def table_counts(conn: sqlite3.Connection) -> dict[str, int]:
    names = [
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    ]
    return {name: int(conn.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]) for name in names}


def update_manifest(extra: dict[str, Any]) -> dict[str, Any]:
    manifest = json.loads(MANIFEST_DATA.read_text(encoding="utf-8"))
    manifest.update(extra)
    manifest["size_bytes"] = OUT_DATA.stat().st_size
    MANIFEST_DATA.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    MANIFEST_PUBLIC.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    started_at = utc_now()
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    previous = read_previous_hashes()
    roots = source_roots()
    files = iter_source_files(roots)

    build_unified_database.build_database()

    with sqlite3.connect(OUT_DATA) as conn:
        create_bot_schema(conn)
        changed_files = insert_source_state(conn, files, previous, started_at)
        completed_at = utc_now()
        materialized = run_materialized_queries(conn, run_id, completed_at, changed_files)
        conn.execute(
            "INSERT INTO bot_sync_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                run_id,
                started_at,
                completed_at,
                len(roots),
                len(files),
                changed_files,
                OUT_DATA.stat().st_size,
                "success",
                "Unified SQLite database rebuilt and SQL prediction tables materialized.",
            ),
        )
        conn.commit()
        conn.execute("VACUUM")
        counts = table_counts(conn)

    shutil.copyfile(OUT_DATA, OUT_PUBLIC)
    manifest = update_manifest({
        "bot": {
            "run_id": run_id,
            "started_at_utc": started_at,
            "completed_at_utc": completed_at,
            "source_roots": [str(root) for root in roots],
            "source_files_indexed": len(files),
            "changed_source_files": changed_files,
            "materialized_queries": materialized,
        },
        "tables": {**json.loads(MANIFEST_DATA.read_text(encoding="utf-8")).get("tables", {}), **counts},
    })

    report = {
        "run_id": run_id,
        "status": "success",
        "source_roots": [str(root) for root in roots],
        "source_files_indexed": len(files),
        "changed_source_files": changed_files,
        "materialized_queries": materialized,
        "database_size_bytes": OUT_PUBLIC.stat().st_size,
        "manifest_tables": manifest.get("tables", {}),
    }
    REPORT_DATA.write_text(json.dumps(report, indent=2), encoding="utf-8")
    REPORT_PUBLIC.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

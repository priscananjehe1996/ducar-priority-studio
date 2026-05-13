from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from uganda_layers_manifest import load_manifest, resolve_manifest_path, update_manifest

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public" / "data"


def load_json(path: Path | None) -> dict[str, Any]:
    if not path or not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def basename(manifest: dict[str, Any], key: str) -> str:
    raw = str(manifest.get(key) or "")
    return raw.replace("\\", "/").split("/")[-1]


def layer_record(
    *,
    layer_id: str,
    label: str,
    file_key: str,
    summary: dict[str, Any],
    manifest: dict[str, Any],
    detail: str,
) -> dict[str, Any]:
    return {
        "id": layer_id,
        "label": label,
        "file": basename(manifest, file_key),
        "generated_at_utc": summary.get("generated_at_utc") or manifest.get("updated_at_utc"),
        "record_count": summary.get("record_count"),
        "total_length_km": summary.get("total_length_km"),
        "ducar_analysis_record_count": summary.get("ducar_analysis_record_count"),
        "ducar_analysis_length_km": summary.get("ducar_analysis_length_km"),
        "reference_exempt_record_count": summary.get("reference_exempt_record_count"),
        "by_source": summary.get("by_source") or {},
        "by_quality_flag": summary.get("by_quality_flag") or {},
        "detail": detail,
    }


def main() -> None:
    manifest = load_manifest(ROOT)
    status_time = datetime.now(timezone.utc).isoformat()
    unified = load_json(resolve_manifest_path(ROOT, manifest.get("unified_roads_summary")))
    national = load_json(resolve_manifest_path(ROOT, manifest.get("national_roads_summary")))
    master = load_json(resolve_manifest_path(ROOT, manifest.get("roads_master_summary")))

    status = {
        "updated_at_utc": status_time,
        "layers": [
            layer_record(
                layer_id="unified-roads",
                label="Unified road intelligence layer",
                file_key="unified_roads_geojson",
                summary=unified,
                manifest=manifest,
                detail="Browser road layer joining DUCAR, national, KCCA/CBD and OSM-derived roads.",
            ),
            layer_record(
                layer_id="national-roads",
                label="National road reference layer",
                file_key="national_roads_geojson",
                summary=national,
                manifest=manifest,
                detail="FY25/26 national road network shown for coordination and DUCAR double-counting checks.",
            ),
            {
                "id": "road-master",
                "label": "Editable all-road master",
                "file": basename(manifest, "roads_master_gpkg"),
                "generated_at_utc": master.get("generated_at_utc") or manifest.get("updated_at_utc"),
                "record_count": master.get("record_count"),
                "total_length_km": master.get("total_length_km"),
                "by_source": master.get("by_source") or {},
                "by_quality_flag": master.get("by_quality_flag") or {},
                "detail": "Local GeoPackage master retained outside GitHub Pages because it is too large for browser delivery.",
            },
        ],
        "assumptions": [
            unified.get("national_exemption_clause"),
            master.get("important_assumption"),
            national.get("assumption"),
        ],
    }
    status["assumptions"] = [item for item in status["assumptions"] if item]

    PUBLIC.mkdir(parents=True, exist_ok=True)
    out = PUBLIC / "uganda_layers_status.json"
    out.write_text(json.dumps(status, indent=2), encoding="utf-8")
    update_manifest(ROOT, {"layers_status_json": str(out)})
    print(json.dumps(status, indent=2))


if __name__ == "__main__":
    main()

"""
Build a compact national road network layer for DUCAR Priority Studio.

Source:
- D:/OneDrive/Procurements/TOR - DUCACR/Roads/networkfy25_26/networkfy25_26.shp

Outputs:
- public/data/uganda_national_roads_fy25_26.geojson
- data/uganda_national_roads_summary.json
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
from shapely.geometry.base import BaseGeometry
from shapely.ops import transform

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parent
TOR = PROJECT.parent

SOURCE = TOR / "Roads" / "networkfy25_26" / "networkfy25_26.shp"
PUBLIC_OUT = ROOT / "public" / "data" / "uganda_national_roads_fy25_26.geojson"
SUMMARY_OUT = ROOT / "data" / "uganda_national_roads_summary.json"


def drop_z(geom: BaseGeometry | None) -> BaseGeometry | None:
    if geom is None or geom.is_empty:
        return geom

    def _drop(x: float, y: float, z: float | None = None) -> tuple[float, float]:
        return (x, y)

    return transform(_drop, geom)


def road_class_label(code: str | None) -> str:
    code = (code or "").strip().upper()
    return {
        "M": "Main National Road",
        "A": "Class A National Road",
        "B": "Class B National Road",
        "C": "Class C National Road",
    }.get(code, "National Road - Verify")


def main() -> None:
    PUBLIC_OUT.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY_OUT.parent.mkdir(parents=True, exist_ok=True)

    roads = gpd.read_file(SOURCE).to_crs(epsg=4326)
    roads["geometry"] = roads.geometry.apply(drop_z)
    roads = roads[roads.geometry.notna() & ~roads.geometry.is_empty].copy()

    roads["national_uid"] = roads["Unique_ID"].map(lambda x: f"UNRA-{int(x):05d}" if str(x).strip() else None)
    roads["road_no"] = roads["Road_No_1"].astype(str).str.strip()
    roads["link_id"] = roads["Link_ID_1"].astype(str).str.strip()
    roads["road_class_code"] = roads["Road_Cla_1"].astype(str).str.strip()
    roads["road_class"] = roads["road_class_code"].map(road_class_label)
    roads["road_name"] = roads["Link_Name"].astype(str).str.strip()
    roads["length_km"] = roads["Length_km_"].astype(float).round(3)
    roads["surface"] = roads["Surface__1"].astype(str).str.strip()
    roads["maintenance_district"] = roads["Maintena_2"].astype(str).str.strip()
    roads["maintenance_region"] = roads["Maintena_3"].astype(str).str.strip()
    roads["chainage_start"] = roads["Chainage_1"].astype(float).round(3)
    roads["chainage_end"] = roads["Chainage_2"].astype(float).round(3)
    roads["completion_year"] = roads["Completi_1"].fillna(0).astype(float).round(0).astype(int)
    roads["rehabilitation_year"] = roads["Rehabili_1"].fillna(0).astype(float).round(0).astype(int)
    roads["last_work_year"] = roads["Year_of_La"].fillna(0).astype(float).round(0).astype(int)
    roads["ndpiv_priority"] = roads.get("NATIONAL_R", "").fillna("").astype(str).str.strip()
    roads["ndpiv_proposal"] = roads.get("NATIONAL_1", "").fillna("").astype(str).str.strip()
    roads["funder"] = roads.get("FUNDER", "").fillna("").astype(str).str.strip()
    roads["source_dataset"] = "National road network FY25/26 shapefile"
    roads["source_path"] = str(SOURCE)
    roads["source_note"] = "National road network added as a separate reference/coordination layer; not merged into DUCAR candidate roads."

    out_cols = [
        "national_uid",
        "road_no",
        "link_id",
        "road_class_code",
        "road_class",
        "road_name",
        "length_km",
        "surface",
        "maintenance_district",
        "maintenance_region",
        "chainage_start",
        "chainage_end",
        "completion_year",
        "rehabilitation_year",
        "last_work_year",
        "ndpiv_priority",
        "ndpiv_proposal",
        "funder",
        "source_dataset",
        "source_path",
        "source_note",
        "geometry",
    ]
    web = roads[out_cols].copy()
    web["geometry"] = web.to_crs(epsg=32636).geometry.simplify(35, preserve_topology=False)
    web = web.to_crs(epsg=4326)
    web.to_file(PUBLIC_OUT, driver="GeoJSON")

    summary = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": str(SOURCE),
        "output": str(PUBLIC_OUT),
        "record_count": int(len(web)),
        "total_length_km": round(float(web["length_km"].sum()), 2),
        "by_class": web.groupby("road_class").size().to_dict(),
        "by_surface": web.groupby("surface").size().to_dict(),
        "by_maintenance_region": web.groupby("maintenance_region").size().to_dict(),
        "assumption": "The national road network is shown as a coordination and exclusion/reference layer. DUCAR allocation should avoid double-counting roads under national responsibility unless an explicit agency agreement exists.",
        "apa_reference": "Uganda national road network FY25/26 shapefile. (2026). Local geospatial dataset: D:/OneDrive/Procurements/TOR - DUCACR/Roads/networkfy25_26/networkfy25_26.shp",
    }
    SUMMARY_OUT.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

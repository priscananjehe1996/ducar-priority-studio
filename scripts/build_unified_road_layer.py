"""
Create one web-ready Uganda road layer from all current spatial road sources.

This does not replace the full local GeoPackage master. It creates the app
layer that keeps growing as mapping pipelines add more source layers.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public" / "data"
DATA = ROOT / "data"
OUT = PUBLIC / "uganda_unified_roads_web.geojson"
SUMMARY = DATA / "uganda_unified_roads_summary.json"


def safe(value, default=None):
    if value is None or pd.isna(value):
        return default
    text = str(value).strip()
    return text if text and text.lower() != "nan" else default


def read_layer(path: Path) -> gpd.GeoDataFrame:
    gdf = gpd.read_file(path).to_crs(epsg=4326)
    return gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()


def district_roads() -> gpd.GeoDataFrame:
    src = PUBLIC / "district_roads_dissolved.geojson"
    gdf = read_layer(src)
    out = gdf.copy()
    out["road_uid"] = [f"DUCAR-DIST-{i + 1:06d}" for i in range(len(out))]
    out["road_source"] = "DUCAR district roads"
    out["road_system"] = "DUCAR"
    out["road_name"] = out.apply(lambda r: safe(r.get("Rdname")) or safe(r.get("DistName")) or "District road", axis=1)
    out["road_ref"] = out.apply(lambda r: safe(r.get("RdCode")) or safe(r.get("DUC_Code")), axis=1)
    out["road_class"] = out.apply(lambda r: safe(r.get("ClassDescr")) or safe(r.get("RdClass")) or "District Road", axis=1)
    out["surface"] = out.apply(lambda r: safe(r.get("RdType")) or safe(r.get("Rd_materia")) or "Unknown", axis=1)
    out["district"] = out.apply(lambda r: safe(r.get("DistName")) or safe(r.get("district")), axis=1)
    out["region"] = out.apply(lambda r: safe(r.get("region")) or "Unassigned", axis=1)
    out["length_km"] = out.to_crs(epsg=32636).geometry.length / 1000
    out["quality_flag"] = out["road_name"].map(lambda x: "Name missing" if not x else "OK")
    out["mapping_status"] = "existing-source"
    out["visual_intelligence_status"] = "candidate-for-field-validation"
    out["source_file"] = str(src)
    return out


def national_roads() -> gpd.GeoDataFrame:
    src = PUBLIC / "uganda_national_roads_fy25_26.geojson"
    gdf = read_layer(src)
    out = gdf.copy()
    out["road_uid"] = out["national_uid"].map(lambda x: safe(x)) if "national_uid" in out else [f"NAT-{i + 1:05d}" for i in range(len(out))]
    out["road_source"] = "National road network FY25/26"
    out["road_system"] = "National"
    out["road_name"] = out.apply(lambda r: safe(r.get("road_name")) or safe(r.get("link_id")) or "National road", axis=1)
    out["road_ref"] = out.apply(lambda r: safe(r.get("road_no")) or safe(r.get("link_id")), axis=1)
    out["road_class"] = out.apply(lambda r: safe(r.get("road_class")) or "National Road", axis=1)
    out["surface"] = out.apply(lambda r: safe(r.get("surface")) or "Unknown", axis=1)
    out["district"] = out.apply(lambda r: safe(r.get("maintenance_district")) or "Unassigned", axis=1)
    out["region"] = out.apply(lambda r: safe(r.get("maintenance_region")) or "Unassigned", axis=1)
    out["length_km"] = out.apply(lambda r: float(r.get("length_km") or 0), axis=1)
    out["quality_flag"] = "OK"
    out["mapping_status"] = "existing-source"
    out["visual_intelligence_status"] = "reference-layer"
    out["source_file"] = str(src)
    return out


def osm_roads() -> gpd.GeoDataFrame:
    src = PUBLIC / "uganda_osm_major_roads_web.geojson"
    gdf = read_layer(src)
    out = gdf.copy()
    out["road_uid"] = out.apply(lambda r: f"OSM-{safe(r.get('osm_id'), 'unknown')}-{r.name}", axis=1)
    out["road_source"] = "OpenStreetMap / Geofabrik"
    out["road_system"] = "Open mapping"
    out["road_name"] = out.apply(lambda r: safe(r.get("road_name")) or safe(r.get("road_ref")) or "Unnamed OSM road", axis=1)
    out["road_ref"] = out.apply(lambda r: safe(r.get("road_ref")) or safe(r.get("osm_id")), axis=1)
    out["road_class"] = out.apply(lambda r: safe(r.get("ducar_class")) or safe(r.get("osm_highway")) or "Verify", axis=1)
    out["surface"] = "Unknown"
    out["district"] = out.apply(lambda r: safe(r.get("district")) or "Unassigned", axis=1)
    out["region"] = out.apply(lambda r: safe(r.get("region")) or "Unassigned", axis=1)
    out["length_km"] = out.apply(lambda r: float(r.get("length_km") or 0), axis=1)
    out["quality_flag"] = out.apply(lambda r: safe(r.get("data_quality_flag")) or "Verify", axis=1)
    out["mapping_status"] = "open-source-ingested"
    out["visual_intelligence_status"] = "candidate-for-name-surface-class-validation"
    out["source_file"] = str(src)
    return out


def kcca_roads() -> gpd.GeoDataFrame:
    src = PUBLIC / "kcca_roads.geojson"
    gdf = read_layer(src)
    out = gdf.copy()
    out["road_uid"] = [f"KCCA-{i + 1:04d}" for i in range(len(out))]
    out["road_source"] = "KCCA roads"
    out["road_system"] = "Urban"
    out["road_name"] = out.apply(lambda r: safe(r.get("Link_Name")) or safe(r.get("Road_No_1")) or "KCCA road", axis=1)
    out["road_ref"] = out.apply(lambda r: safe(r.get("Road_No_1")), axis=1)
    out["road_class"] = out.apply(lambda r: safe(r.get("Road_Cla_1")) or "Urban Road", axis=1)
    out["surface"] = out.apply(lambda r: safe(r.get("Surface__1")) or "Unknown", axis=1)
    out["district"] = "Kampala"
    out["region"] = "Central"
    out["length_km"] = out.apply(lambda r: float(r.get("Length_km_") or 0), axis=1)
    out["quality_flag"] = "OK"
    out["mapping_status"] = "existing-source"
    out["visual_intelligence_status"] = "urban-reference-layer"
    out["source_file"] = str(src)
    return out


def main() -> None:
    layers = [district_roads(), national_roads(), osm_roads(), kcca_roads()]
    cols = [
        "road_uid",
        "road_source",
        "road_system",
        "road_name",
        "road_ref",
        "road_class",
        "surface",
        "district",
        "region",
        "length_km",
        "quality_flag",
        "mapping_status",
        "visual_intelligence_status",
        "source_file",
        "geometry",
    ]
    merged = gpd.GeoDataFrame(pd.concat([layer[cols] for layer in layers], ignore_index=True), geometry="geometry", crs="EPSG:4326")
    merged["length_km"] = merged["length_km"].fillna(0).astype(float).round(3)
    merged.to_file(OUT, driver="GeoJSON")

    summary = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "output": str(OUT),
        "record_count": int(len(merged)),
        "total_length_km": round(float(merged["length_km"].sum()), 2),
        "by_road_system": merged.groupby("road_system").size().to_dict(),
        "by_source": merged.groupby("road_source").size().to_dict(),
        "by_quality_flag": merged.groupby("quality_flag").size().to_dict(),
        "growth_logic": "Re-run source mapping scripts, then this merge script. New road features inherit source/provenance and are appended into one app road layer.",
    }
    SUMMARY.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

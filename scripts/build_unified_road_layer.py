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

from uganda_layers_manifest import load_manifest, update_manifest

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public" / "data"
DATA = ROOT / "data"
CBD_SELECTED_DIR = ROOT.parents[1] / "Selected Roads in CBD"
CBD_SELECTED_OUT = PUBLIC / "selected_cbd_roads.geojson"


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
    out["ducar_analysis_scope"] = "Included"
    out["exemption_clause"] = "Non-national road retained for DUCAR analysis subject to ownership and field validation."
    out["source_file"] = str(src)
    return out


def national_roads(manifest: dict | None = None) -> gpd.GeoDataFrame:
    manifest = manifest or {}
    src = Path(manifest.get("national_roads_geojson") or (PUBLIC / "uganda_national_roads_fy25_26.geojson"))
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
    out["visual_intelligence_status"] = "reference-layer-national-exemption"
    out["ducar_analysis_scope"] = "Reference only - excluded"
    out["exemption_clause"] = "National road network is mapped for coordination, connectivity and double-counting checks, but excluded from DUCAR prioritisation and budget allocation unless formally delegated."
    out["source_file"] = str(src)
    return out


def osm_roads(manifest: dict | None = None) -> gpd.GeoDataFrame:
    manifest = manifest or {}
    src = Path(manifest.get("osm_major_roads_geojson") or (PUBLIC / "uganda_osm_major_roads_web.geojson"))
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
    out["ducar_analysis_scope"] = out["road_class"].map(
        lambda x: "Reference only - excluded" if x == "National Road" else "Included pending validation"
    )
    out["exemption_clause"] = out["ducar_analysis_scope"].map(
        lambda x: "OSM road class indicates likely national road; keep as reference until authority ownership is confirmed."
        if x.startswith("Reference")
        else "Open-mapped non-national candidate retained for DUCAR analysis after validation."
    )
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
    out["ducar_analysis_scope"] = "Included pending urban mandate confirmation"
    out["exemption_clause"] = "Urban road retained for DUCAR/KCCA coordination analysis, subject to mandate confirmation."
    out["source_file"] = str(src)
    return out


def selected_cbd_roads() -> gpd.GeoDataFrame:
    src = CBD_SELECTED_DIR / "KCCA.shp"
    if not src.exists():
        return gpd.GeoDataFrame(columns=["geometry"], geometry="geometry", crs="EPSG:4326")
    gdf = read_layer(src)
    out = gdf.copy()
    out["road_uid"] = [f"CBD-SEL-{i + 1:04d}" for i in range(len(out))]
    out["road_source"] = "Selected Roads in CBD"
    out["road_system"] = "CBD Selected"
    out["road_name"] = out.apply(lambda r: safe(r.get("Road_Name")) or "Selected CBD road", axis=1)
    out["road_ref"] = out["road_uid"]
    out["road_class"] = "Urban CBD Priority Link"
    out["surface"] = "Urban paved - verify"
    out["district"] = "Kampala"
    out["region"] = "Central"
    out["length_km"] = out.apply(lambda r: float(r.get("Length_km") or 0), axis=1)
    out["quality_flag"] = out["road_name"].map(lambda x: "Name missing" if not x else "CBD source - verify surface and class")
    out["mapping_status"] = "selected-cbd-source"
    out["visual_intelligence_status"] = "complete-cbd-mapping-layer-ready-for-roadside-validation"
    out["ducar_analysis_scope"] = "Included pending urban mandate confirmation"
    out["exemption_clause"] = "Selected CBD road retained for DUCAR/KCCA coordination analysis and budget rationalisation, subject to mandate confirmation and field validation."
    out["source_file"] = str(src)
    out["source_shape_leng"] = out.apply(lambda r: safe(r.get("Shape_Leng")), axis=1)
    out["source_start_x"] = out.apply(lambda r: safe(r.get("Start_X")), axis=1)
    out["source_start_y"] = out.apply(lambda r: safe(r.get("Start_Y")), axis=1)
    out["source_end_x"] = out.apply(lambda r: safe(r.get("End_X")), axis=1)
    out["source_end_y"] = out.apply(lambda r: safe(r.get("End_Y")), axis=1)
    CBD_SELECTED_OUT.write_text(out.to_json(drop_id=True), encoding="utf-8")
    return out


def main() -> None:
    manifest = load_manifest(ROOT)
    date_tag = datetime.now(timezone.utc).date().isoformat()
    out_path = PUBLIC / f"uganda_unified_roads_web_{date_tag}.geojson"
    summary_path = DATA / f"uganda_unified_roads_summary_{date_tag}.json"

    layers = [district_roads(), national_roads(manifest), osm_roads(manifest), kcca_roads(), selected_cbd_roads()]
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
        "ducar_analysis_scope",
        "exemption_clause",
        "source_file",
        "source_shape_leng",
        "source_start_x",
        "source_start_y",
        "source_end_x",
        "source_end_y",
        "geometry",
    ]
    for layer in layers:
        for col in cols:
            if col not in layer.columns:
                layer[col] = None
    merged = gpd.GeoDataFrame(pd.concat([layer[cols] for layer in layers], ignore_index=True), geometry="geometry", crs="EPSG:4326")
    merged["length_km"] = merged["length_km"].fillna(0).astype(float).round(3)
    ducar_scope = merged[~merged["ducar_analysis_scope"].str.startswith("Reference", na=False)]
    exempt_scope = merged[merged["ducar_analysis_scope"].str.startswith("Reference", na=False)]
    out_path.write_text(merged.to_json(drop_id=True), encoding="utf-8")

    summary = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "output": str(out_path),
        "record_count": int(len(merged)),
        "total_length_km": round(float(merged["length_km"].sum()), 2),
        "ducar_analysis_record_count": int(len(ducar_scope)),
        "ducar_analysis_length_km": round(float(ducar_scope["length_km"].sum()), 2),
        "reference_exempt_record_count": int(len(exempt_scope)),
        "reference_exempt_length_km": round(float(exempt_scope["length_km"].sum()), 2),
        "by_road_system": merged.groupby("road_system").size().to_dict(),
        "by_ducar_analysis_scope": merged.groupby("ducar_analysis_scope").size().to_dict(),
        "by_source": merged.groupby("road_source").size().to_dict(),
        "by_quality_flag": merged.groupby("quality_flag").size().to_dict(),
        "growth_logic": "Re-run source mapping scripts, then this merge script. New road features inherit source/provenance and are appended into one app road layer.",
        "national_exemption_clause": "National roads remain visible in the unified map for reference, connectivity, and double-counting checks, but all DUCAR analysis focuses on non-national roads unless a formal delegation exists.",
    }
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    update_manifest(
        ROOT,
        {
            "unified_roads_geojson": str(out_path),
            "unified_roads_summary": str(summary_path),
        },
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

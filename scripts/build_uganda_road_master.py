"""
Build an enriched Uganda road master layer for the DUCAR Priority Studio.

Inputs:
- Existing DUCAR district road shapefile.
- Uganda district boundaries.
- OpenStreetMap roads from the Geofabrik Uganda free shapefile extract.

Outputs:
- data/uganda_roads_master.gpkg: full editable GIS layer.
- public/data/uganda_osm_major_roads_web.geojson: simplified line layer for major/named roads.
- public/data/uganda_roads_district_summary.geojson: all-road district summary layer.
- data/uganda_roads_master_summary.json: counts, assumptions, references.

The script keeps source/provenance fields and assigns DUCAR classes through a
transparent rule table. It does not overwrite source shapefiles.
"""

from __future__ import annotations

import json
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import geopandas as gpd
import pandas as pd
import requests
from shapely.geometry.base import BaseGeometry
from shapely.ops import transform

from uganda_layers_manifest import update_manifest

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parent
TOR = PROJECT.parent

DATA_DIR = ROOT / "data"
PUBLIC_DATA_DIR = ROOT / "public" / "data"
CACHE_DIR = ROOT / "data_sources"
REPORT_DIR = PROJECT / "gis"

DISTRICT_ROADS = TOR / "district roads" / "dcroads2025.shp"
DISTRICTS = TOR / "Districts" / "districts.shp"
GEOFABRIK_UGANDA_ZIP = "https://download.geofabrik.de/africa/uganda-latest-free.shp.zip"
GEOFABRIK_LOCAL_ZIP = CACHE_DIR / "uganda-latest-free.shp.zip"
GEOFABRIK_EXTRACT_DIR = CACHE_DIR / "geofabrik_uganda"
WRITE_FULL_GEOJSON = False

REFERENCES_APA = [
    "Geofabrik GmbH. (2026). Uganda latest free OpenStreetMap shapefile extract. https://download.geofabrik.de/africa/uganda-latest-free.shp.zip",
    "OpenStreetMap contributors. (2026). OpenStreetMap highway tagging. https://wiki.openstreetmap.org/wiki/Key:highway",
    "OpenStreetMap Wiki contributors. (2026). Highways. https://wiki.openstreetmap.org/wiki/Highways",
    "Uganda road asset management manuals repository. (n.d.). Manuals and road asset management source documents. Local source: D:/OneDrive/Uganda National Road Network Repository/0. Manuals",
]

OSM_TO_DUCAR = {
    "motorway": ("National Road", "NR", "OSM motorway: strategic controlled-access or highest mobility road; outside DUCAR unless delegated."),
    "trunk": ("National Road", "NR", "OSM trunk: major interregional road; treated as national network for screening."),
    "primary": ("National Road", "NR", "OSM primary: major national/regional road; treated as national unless local inventory confirms DUCAR responsibility."),
    "secondary": ("District Road", "DR", "OSM secondary: likely inter-district connector; DUCAR district candidate where not in UNRA network."),
    "tertiary": ("District Road", "DR", "OSM tertiary: district/sub-county connector."),
    "unclassified": ("Community Access Road", "CAR", "OSM unclassified: lower-order public road, mapped as community access candidate pending field confirmation."),
    "residential": ("Urban Road", "UR", "OSM residential: urban/local settlement road."),
    "living_street": ("Urban Road", "UR", "OSM living street: urban local access road."),
    "service": ("Community Access Road", "CAR", "OSM service: local access/service road; requires ownership screening."),
    "track": ("Community Access Road", "CAR", "OSM track: rural/agricultural access candidate; requires maintainability confirmation."),
    "road": ("Unclassified - Verify", "VERIFY", "OSM highway=road is an unknown temporary class; field/manual classification required."),
}


def ensure_dirs() -> None:
    for folder in (DATA_DIR, PUBLIC_DATA_DIR, CACHE_DIR, GEOFABRIK_EXTRACT_DIR, REPORT_DIR):
        folder.mkdir(parents=True, exist_ok=True)


def drop_z(geom: BaseGeometry | None) -> BaseGeometry | None:
    if geom is None or geom.is_empty:
        return geom

    def _drop(x: float, y: float, z: float | None = None) -> tuple[float, float]:
        return (x, y)

    return transform(_drop, geom)


def clean_text(value: Any) -> str | None:
    if value is None or pd.isna(value):
        return None
    text = str(value).strip()
    text = re.sub(r"\s+", " ", text)
    return text or None


def download_geofabrik(force: bool = False) -> Path:
    if GEOFABRIK_LOCAL_ZIP.exists() and not force:
        print(f"Using cached Geofabrik extract: {GEOFABRIK_LOCAL_ZIP}", flush=True)
        return GEOFABRIK_LOCAL_ZIP

    print(f"Downloading {GEOFABRIK_UGANDA_ZIP}", flush=True)
    tmp = GEOFABRIK_LOCAL_ZIP.with_suffix(".download")
    with requests.get(GEOFABRIK_UGANDA_ZIP, stream=True, timeout=90) as response:
        response.raise_for_status()
        with tmp.open("wb") as fh:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    fh.write(chunk)
    tmp.replace(GEOFABRIK_LOCAL_ZIP)
    return GEOFABRIK_LOCAL_ZIP


def extract_geofabrik(zip_path: Path) -> Path:
    marker = GEOFABRIK_EXTRACT_DIR / ".extract_complete"
    if marker.exists():
        print(f"Using extracted Geofabrik folder: {GEOFABRIK_EXTRACT_DIR}", flush=True)
        return GEOFABRIK_EXTRACT_DIR
    if GEOFABRIK_EXTRACT_DIR.exists():
        shutil.rmtree(GEOFABRIK_EXTRACT_DIR)
    GEOFABRIK_EXTRACT_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(GEOFABRIK_EXTRACT_DIR)
    marker.write_text(datetime.now(timezone.utc).isoformat(), encoding="utf-8")
    return GEOFABRIK_EXTRACT_DIR


def read_districts() -> gpd.GeoDataFrame:
    print("Reading district boundaries...", flush=True)
    districts = gpd.read_file(DISTRICTS).to_crs(epsg=4326)
    districts = districts.rename(columns={"admin2Name": "district", "admin1Name": "region"})
    districts["district_key"] = districts["district"].str.upper().str.strip()
    return districts[["district", "region", "district_key", "geometry"]]


def read_existing_ducar(districts: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    print("Reading existing DUCAR district roads...", flush=True)
    roads = gpd.read_file(DISTRICT_ROADS).to_crs(epsg=4326)
    roads["geometry"] = roads.geometry.apply(drop_z)
    roads["source_dataset"] = "Existing DUCAR district roads shapefile"
    roads["source_update"] = "dcroads2025.shp"
    roads["osm_id"] = None
    roads["osm_highway"] = None
    roads["road_name"] = roads.get("Rdname", pd.Series(index=roads.index)).map(clean_text)
    roads["road_ref"] = roads.get("RdCode", pd.Series(index=roads.index)).map(clean_text)
    roads["surface"] = roads.get("RdType", pd.Series(index=roads.index)).map(clean_text)
    roads["length_km"] = roads.to_crs(epsg=32636).length / 1000
    roads["district"] = roads.get("DistName", pd.Series(index=roads.index)).map(clean_text)
    roads["district_key"] = roads["district"].str.upper().str.strip()
    roads = roads.merge(districts[["district_key", "region"]], on="district_key", how="left")
    roads["ducar_class"] = roads.get("ClassDescr", pd.Series(index=roads.index)).map(clean_text)
    roads["ducar_code"] = roads.get("RdClass", pd.Series(index=roads.index)).map(clean_text)
    roads["classification_confidence"] = "High"
    roads["classification_basis"] = "Existing DUCAR shapefile class fields retained."
    roads["data_quality_flag"] = roads["road_name"].isna().map(lambda x: "Name missing" if x else "OK")
    roads["asset_owner_screen"] = "DUCAR candidate"
    return roads[
        [
            "source_dataset",
            "source_update",
            "osm_id",
            "osm_highway",
            "road_name",
            "road_ref",
            "surface",
            "length_km",
            "district",
            "region",
            "ducar_class",
            "ducar_code",
            "classification_confidence",
            "classification_basis",
            "data_quality_flag",
            "asset_owner_screen",
            "geometry",
        ]
    ]


def read_osm_roads(districts: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    zip_path = download_geofabrik()
    extract_dir = extract_geofabrik(zip_path)
    roads_path = next(extract_dir.rglob("gis_osm_roads_free_1.shp"))
    print(f"Reading OSM roads: {roads_path}", flush=True)
    osm = gpd.read_file(roads_path).to_crs(epsg=4326)
    osm["geometry"] = osm.geometry.apply(drop_z)
    osm = osm[~osm.geometry.is_empty & osm.geometry.notna()].copy()

    osm["source_dataset"] = "OpenStreetMap via Geofabrik Uganda free shapefile extract"
    osm["source_update"] = datetime.fromtimestamp(zip_path.stat().st_mtime, tz=timezone.utc).date().isoformat()
    osm["osm_id"] = osm.get("osm_id", pd.Series(index=osm.index)).map(clean_text)
    osm["osm_highway"] = osm.get("fclass", pd.Series(index=osm.index)).map(clean_text)
    osm["road_name"] = osm.get("name", pd.Series(index=osm.index)).map(clean_text)
    osm["road_ref"] = osm.get("ref", pd.Series(index=osm.index)).map(clean_text)
    osm["surface"] = None
    osm["length_km"] = osm.to_crs(epsg=32636).length / 1000

    osm_centroids = osm.copy()
    osm_centroids["geometry"] = osm_centroids.geometry.representative_point()
    joined = gpd.sjoin(osm_centroids, districts, how="left", predicate="within")
    osm["district"] = joined["district"].values
    osm["region"] = joined["region"].values

    class_rows = osm["osm_highway"].map(lambda x: OSM_TO_DUCAR.get(x or "", ("Unclassified - Verify", "VERIFY", "No direct DUCAR mapping; manual review required.")))
    osm["ducar_class"] = class_rows.map(lambda x: x[0])
    osm["ducar_code"] = class_rows.map(lambda x: x[1])
    osm["classification_basis"] = class_rows.map(lambda x: x[2])
    osm["classification_confidence"] = osm["osm_highway"].map(lambda x: "Medium" if x in OSM_TO_DUCAR and x != "road" else "Low")
    osm.loc[osm["road_name"].isna(), "classification_confidence"] = "Low"
    osm["data_quality_flag"] = "OK"
    osm.loc[osm["road_name"].isna(), "data_quality_flag"] = "Name missing in OSM"
    osm.loc[osm["district"].isna(), "data_quality_flag"] = "District join missing"
    osm["asset_owner_screen"] = osm["ducar_class"].map(lambda x: "Non-DUCAR screen" if x == "National Road" else "DUCAR candidate")

    return osm[
        [
            "source_dataset",
            "source_update",
            "osm_id",
            "osm_highway",
            "road_name",
            "road_ref",
            "surface",
            "length_km",
            "district",
            "region",
            "ducar_class",
            "ducar_code",
            "classification_confidence",
            "classification_basis",
            "data_quality_flag",
            "asset_owner_screen",
            "geometry",
        ]
    ]


def build_web_layer(master: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    print("Building simplified major/named road web layer...", flush=True)
    web = master[master["source_dataset"].str.contains("OpenStreetMap", na=False)].copy()
    major = {"motorway", "trunk", "primary", "secondary", "tertiary"}
    web = web[
        web["osm_highway"].isin(major)
        | web["road_ref"].notna()
        | (web["road_name"].notna() & ~web["osm_highway"].isin({"service", "track"}))
    ].copy()
    web = web[
        [
            "road_uid",
            "osm_id",
            "osm_highway",
            "road_name",
            "road_ref",
            "length_km",
            "district",
            "region",
            "ducar_class",
            "ducar_code",
            "classification_confidence",
            "data_quality_flag",
            "geometry",
        ]
    ]
    web["geometry"] = web.to_crs(epsg=32636).geometry.simplify(80, preserve_topology=False)
    web = web.to_crs(epsg=4326)
    web = web[web.geometry.notna() & ~web.geometry.is_empty]
    return web


def build_district_summary(master: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    print("Building district all-road summary layer...", flush=True)
    districts = read_districts()
    road_stats = (
        master.dropna(subset=["district"])
        .groupby("district")
        .agg(
            road_records=("road_uid", "count"),
            total_km=("length_km", "sum"),
            osm_km=("length_km", lambda s: float(s[master.loc[s.index, "source_dataset"].str.contains("OpenStreetMap", na=False)].sum())),
            ducar_km=("length_km", lambda s: float(s[master.loc[s.index, "source_dataset"].str.contains("Existing DUCAR", na=False)].sum())),
            national_count=("ducar_class", lambda s: int((s == "National Road").sum())),
            district_count=("ducar_class", lambda s: int((s == "District Road").sum())),
            urban_count=("ducar_class", lambda s: int((s == "Urban Road").sum())),
            car_count=("ducar_class", lambda s: int((s == "Community Access Road").sum())),
            verify_count=("ducar_class", lambda s: int((s == "Unclassified - Verify").sum())),
            missing_name_count=("data_quality_flag", lambda s: int(s.astype(str).str.contains("Name missing", na=False).sum())),
        )
        .reset_index()
    )
    out = districts.merge(road_stats, on="district", how="left")
    numeric = [
        "road_records",
        "total_km",
        "osm_km",
        "ducar_km",
        "national_count",
        "district_count",
        "urban_count",
        "car_count",
        "verify_count",
        "missing_name_count",
    ]
    for col in numeric:
        out[col] = out[col].fillna(0)
    out["total_km"] = out["total_km"].round(1)
    out["osm_km"] = out["osm_km"].round(1)
    out["ducar_km"] = out["ducar_km"].round(1)
    out["geometry"] = out.geometry.simplify(0.005, preserve_topology=True)
    return out


def write_outputs(master: gpd.GeoDataFrame) -> dict[str, Any]:
    gpkg = DATA_DIR / "uganda_roads_master.gpkg"
    geojson = DATA_DIR / "uganda_roads_master.geojson"
    date_tag = datetime.now(timezone.utc).date().isoformat()
    web_geojson = PUBLIC_DATA_DIR / f"uganda_osm_major_roads_web_{date_tag}.geojson"
    district_summary_geojson = PUBLIC_DATA_DIR / f"uganda_roads_district_summary_{date_tag}.geojson"
    summary_path = DATA_DIR / f"uganda_roads_master_summary_{date_tag}.json"
    rules_path = DATA_DIR / f"DUCAR_OSM_Road_Classification_Rules_{date_tag}.csv"

    print(f"Writing full editable master GeoPackage: {gpkg}", flush=True)
    try:
        master.to_file(
            gpkg,
            layer="uganda_roads_master",
            driver="GPKG",
            layer_options={"OVERWRITE": "YES"},
        )
    except (PermissionError, OSError):
        date_tag = datetime.now(timezone.utc).date().isoformat()
        fallback_dir = Path.home() / ".codex" / "automations" / "refresh-uganda-road-master-mapping"
        fallback_dir.mkdir(parents=True, exist_ok=True)
        fallback = fallback_dir / f"uganda_roads_master_{date_tag}.gpkg"
        if fallback.exists():
            fallback.unlink()
        print(
            f"WARNING: Unable to overwrite {gpkg} (file may be open/locked). Writing fallback GeoPackage: {fallback}",
            flush=True,
        )
        master.to_file(
            fallback,
            layer="uganda_roads_master",
            driver="GPKG",
            layer_options={"OVERWRITE": "YES"},
        )
        gpkg = fallback
    if WRITE_FULL_GEOJSON:
        print(f"Writing full GeoJSON copy: {geojson}", flush=True)
        geojson.write_text(master.to_json(drop_id=True), encoding="utf-8")
    else:
        geojson = None
    print(f"Writing browser line layer: {web_geojson}", flush=True)
    web_geojson.write_text(build_web_layer(master).to_json(drop_id=True), encoding="utf-8")
    print(f"Writing browser district summary layer: {district_summary_geojson}", flush=True)
    district_summary_geojson.write_text(build_district_summary(master).to_json(drop_id=True), encoding="utf-8")

    rules = pd.DataFrame(
        [
            {"osm_highway": k, "ducar_class": v[0], "ducar_code": v[1], "assumption": v[2]}
            for k, v in OSM_TO_DUCAR.items()
        ]
    )
    rules.to_csv(rules_path, index=False)

    summary = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_files": {
            "existing_ducar_shapefile": str(DISTRICT_ROADS),
            "district_boundaries": str(DISTRICTS),
            "geofabrik_url": GEOFABRIK_UGANDA_ZIP,
            "geofabrik_local_zip": str(GEOFABRIK_LOCAL_ZIP),
        },
        "outputs": {
            "master_gpkg": str(gpkg),
            "master_geojson": str(geojson) if geojson else "Skipped by default; GeoPackage is the authoritative editable master.",
            "web_major_roads_geojson": str(web_geojson),
            "web_district_summary_geojson": str(district_summary_geojson),
            "classification_rules_csv": str(rules_path),
        },
        "record_count": int(len(master)),
        "total_length_km": round(float(master["length_km"].sum()), 2),
        "by_source": master.groupby("source_dataset").size().to_dict(),
        "by_ducar_class": master.groupby("ducar_class").size().to_dict(),
        "by_quality_flag": master.groupby("data_quality_flag").size().to_dict(),
        "references_apa": REFERENCES_APA,
        "important_assumption": "OSM classifications are planning-screen assignments only. They must be validated against statutory road ownership, gazetted road lists, field survey, and the Uganda road asset management manuals before final budgeting or legal reporting.",
    }
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    update_manifest(
        ROOT,
        {
            "osm_major_roads_geojson": str(web_geojson),
            "roads_district_summary_geojson": str(district_summary_geojson),
            "roads_master_gpkg": str(gpkg),
            "roads_master_summary": str(summary_path),
        },
    )
    return summary


def main() -> None:
    ensure_dirs()
    districts = read_districts()
    existing = read_existing_ducar(districts)
    osm = read_osm_roads(districts)
    master = pd.concat([existing, osm], ignore_index=True)
    master = gpd.GeoDataFrame(master, geometry="geometry", crs="EPSG:4326")
    master["road_uid"] = [
        f"UGA-{idx + 1:07d}" for idx in range(len(master))
    ]
    cols = ["road_uid"] + [c for c in master.columns if c != "road_uid"]
    master = master[cols]
    summary = write_outputs(master)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

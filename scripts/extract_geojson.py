"""
Extract district roads, district boundaries, and KCCA roads from shapefiles
to compact GeoJSON for the DUCAR Priority Studio web app.

Strategy for manageable file sizes:
- Simplify heavily (tolerance 0.002 for roads, 0.005 for districts)
- Drop Z coordinates
- Keep only essential properties
- Produce per-district road count/km summary in the district boundaries
"""

import geopandas as gpd
import json
import os
import numpy as np
from shapely.geometry import LineString, MultiLineString
from shapely.ops import transform

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(OUT_DIR, exist_ok=True)

def drop_z(geom):
    """Remove Z dimension from geometry."""
    if geom is None or geom.is_empty:
        return geom
    def _drop(x, y, z=None):
        return (x, y)
    return transform(_drop, geom)

# -------------------------------------------------------------------
# 1. District Boundaries
# -------------------------------------------------------------------
print("=== Loading district boundaries ===")
districts = gpd.read_file(r"D:\OneDrive\Procurements\TOR - DUCACR\Districts\districts.shp")
print(f"  Records: {len(districts)}, CRS: {districts.crs}")
districts = districts.to_crs(epsg=4326)
districts["geometry"] = districts.geometry.simplify(0.005, preserve_topology=True)
districts["geometry"] = districts.geometry.apply(drop_z)

# Rename columns
districts = districts.rename(columns={
    "admin2Name": "district",
    "admin1Name": "region",
    "Shape_Area": "area",
})
districts_out = districts[["district", "region", "area", "geometry"]].copy()

# -------------------------------------------------------------------
# 2. District Roads - simplify aggressively
# -------------------------------------------------------------------
print("=== Loading district roads (2025) ===")
roads = gpd.read_file(r"D:\OneDrive\Procurements\TOR - DUCACR\district roads\dcroads2025.shp")
print(f"  Records: {len(roads)}, CRS: {roads.crs}")
roads = roads.to_crs(epsg=4326)

# Compute road length in km before simplification
roads["length_km"] = roads.geometry.to_crs(epsg=32636).length / 1000

# Spatial join to tag each road with district
districts_for_join = districts[["district", "region", "geometry"]].copy()
roads_joined = gpd.sjoin(roads, districts_for_join, how="left", predicate="intersects")
if "index_right" in roads_joined.columns:
    roads_joined = roads_joined.drop(columns=["index_right"])

# Compute per-district statistics and merge into districts_out
district_stats = roads_joined.groupby("district").agg(
    road_count=("length_km", "count"),
    total_km=("length_km", "sum"),
).reset_index()
districts_out = districts_out.merge(district_stats, on="district", how="left")
districts_out["road_count"] = districts_out["road_count"].fillna(0).astype(int)
districts_out["total_km"] = districts_out["total_km"].fillna(0).round(1)

# Write districts with stats
out_path = os.path.join(OUT_DIR, "districts.geojson")
districts_out.to_file(out_path, driver="GeoJSON")
print(f"  -> Wrote {out_path} ({os.path.getsize(out_path) / 1e6:.1f} MB)")

# Simplify roads heavily and drop Z, keep minimal columns
roads_joined["geometry"] = roads_joined.geometry.simplify(0.002, preserve_topology=True)
roads_joined["geometry"] = roads_joined.geometry.apply(drop_z)

# Keep only roads with valid geometries
roads_joined = roads_joined[~roads_joined.geometry.is_empty]

# Keep minimal columns
road_cols = ["DistName", "Rdname", "RdClass", "ClassDescr", "RdType", "length_km", "district", "region", "geometry"]
road_keep = [c for c in road_cols if c in roads_joined.columns]
roads_out = roads_joined[road_keep].copy()

out_path = os.path.join(OUT_DIR, "district_roads.geojson")
roads_out.to_file(out_path, driver="GeoJSON")
sz = os.path.getsize(out_path) / 1e6
print(f"  -> Wrote {out_path} ({sz:.1f} MB)")

# If still too large, create a further-simplified version
if sz > 5:
    print("  File too large, creating ultra-simplified version...")
    roads_out["geometry"] = roads_out.geometry.simplify(0.005, preserve_topology=True)
    roads_out = roads_out[~roads_out.geometry.is_empty]
    out_path2 = os.path.join(OUT_DIR, "district_roads_lite.geojson")
    roads_out.to_file(out_path2, driver="GeoJSON")
    print(f"  -> Wrote {out_path2} ({os.path.getsize(out_path2) / 1e6:.1f} MB)")

# -------------------------------------------------------------------
# 3. KCCA Roads
# -------------------------------------------------------------------
print("=== Loading KCCA roads ===")
kcca = gpd.read_file(r"D:\OneDrive\KCCA\kcca_nrn\kccanrn.shp")
print(f"  Records: {len(kcca)}, CRS: {kcca.crs}")
kcca = kcca.to_crs(epsg=4326)
kcca["geometry"] = kcca.geometry.simplify(0.0003, preserve_topology=True)
kcca["geometry"] = kcca.geometry.apply(drop_z)

# Keep useful columns
kcca_keep = ["Road_No_1", "Link_Name", "Road_Cla_1", "Surface__1", "Length_km_", "geometry"]
kcca_keep = [c for c in kcca_keep if c in kcca.columns]
kcca_out = kcca[kcca_keep].copy()

out_path = os.path.join(OUT_DIR, "kcca_roads.geojson")
kcca_out.to_file(out_path, driver="GeoJSON")
print(f"  -> Wrote {out_path} ({os.path.getsize(out_path) / 1e6:.1f} MB)")

# -------------------------------------------------------------------
# 4. Summary stats for manifest
# -------------------------------------------------------------------
manifest = {
    "districts": {
        "records": len(districts_out),
        "total_roads": int(districts_out["road_count"].sum()),
        "total_km": round(float(districts_out["total_km"].sum()), 1),
    },
    "district_roads": {
        "records": len(roads_out),
    },
    "kcca_roads": {
        "records": len(kcca_out),
    },
}
manifest_path = os.path.join(OUT_DIR, "geospatial_manifest.json")
with open(manifest_path, "w") as f:
    json.dump(manifest, f, indent=2)
print(f"\n=== Manifest ===")
print(json.dumps(manifest, indent=2))
print("\nDone!")

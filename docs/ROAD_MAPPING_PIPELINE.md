# Uganda Road Mapping Pipeline

## Purpose

This pipeline builds an enriched Uganda road master layer for DUCAR planning. It appends OpenStreetMap roads to the existing DUCAR district road shapefile, assigns planning-screen classifications, joins district and regional attributes, and creates browser-ready layers for the Priority Studio map.

## Generated Outputs

- `data/uganda_roads_master.gpkg`: authoritative editable all-road GIS master layer kept locally because it is too large for GitHub Pages.
- `data/uganda_roads_master_summary.json`: build summary, counts, assumptions, and APA-style references.
- `public/data/uganda_osm_major_roads_web.geojson`: simplified web layer for major and named OSM roads.
- `public/data/uganda_roads_district_summary.geojson`: district-level all-road statistics derived from the full master layer.
- `public/data/uganda_national_roads_fy25_26.geojson`: national road network FY25/26 reference layer from the provided local shapefile.
- `public/data/uganda_unified_roads_web.geojson`: one growing web road layer merging DUCAR, National, KCCA/Urban, and OSM/Open mapping road features.
- `public/data/uganda_layers_status.json`: compact browser status feed with record counts, kilometres, generation dates, and refresh assumptions.
- `../gis/DUCAR_OSM_Road_Classification_Rules.csv`: transparent OSM-to-DUCAR classification rule table.

## Classification Logic

The tool uses OSM `highway=*` tags as a planning-screen input, then maps them into DUCAR-style classes:

- `motorway`, `trunk`, `primary` -> National Road screening class.
- `secondary`, `tertiary` -> District Road screening class.
- `residential`, `living_street` -> Urban Road screening class.
- `unclassified`, `service`, `track` -> Community Access Road screening class.
- `road` or unknown values -> Unclassified - Verify.

These are assumptions for technical screening, not statutory road ownership determinations. Final classifications must be validated against gazetted road lists, field survey, responsible authority records, and the Uganda road asset management manuals.

## National Road Exemption Clause

The national road network remains visible in the GIS because it is essential for connectivity, corridor logic, handover checks, and avoiding double-counting. However, it is marked as `Reference only - excluded` in the unified road layer. DUCAR prioritisation, traffic/economic analysis, budget rationalisation, and allocation decisions focus on non-national roads that form part of the DUCAR network, unless a formal delegation or inter-agency financing arrangement explicitly brings a national road segment into scope.

## Why the Web App Does Not Load Every Geometry

The full national all-road layer contains hundreds of thousands of features and is too large for browser delivery through GitHub Pages. The app therefore loads:

- A major/named roads line layer for visual inspection.
- A separate national road network reference layer for agency coordination and DUCAR double-counting checks.
- A single unified road intelligence layer with source, system, class, surface, district, region, length, quality flag, and visual-intelligence status fields.
- A district summary layer that represents the full all-road inventory by district.
- The full editable national master as a local GeoPackage for QGIS/ArcGIS and advanced analysis.

## Refresh Command

Run from `github_app`:

```powershell
python scripts\build_uganda_road_master.py
python scripts\build_national_roads_layer.py
python scripts\build_unified_road_layer.py
python scripts\build_layer_status.py
```

## APA-Style References

Geofabrik GmbH. (2026). *Uganda latest free OpenStreetMap shapefile extract*. https://download.geofabrik.de/africa/uganda-latest-free.shp.zip

OpenStreetMap contributors. (2026). *OpenStreetMap highway tagging*. https://wiki.openstreetmap.org/wiki/Key:highway

OpenStreetMap Foundation. (2026). *Copyright and license*. https://www.openstreetmap.org/copyright

World Bank. (2023). *HDM-4 road user costs model*. https://datacatalog.worldbank.org/search/dataset/0065667/hdm-4-road-user-costs-model-hdm-4-ruc-version-5-0

WorldClim. (2026). *Global climate and weather data*. https://www.worldclim.org/data/index.html

Uganda road asset management manuals repository. (n.d.). *Manuals and road asset management source documents*. Local source: `D:/OneDrive/Uganda National Road Network Repository/0. Manuals`.

Uganda national road network FY25/26 shapefile. (2026). *Local geospatial dataset*. Local source: `D:/OneDrive/Procurements/TOR - DUCACR/Roads/networkfy25_26/networkfy25_26.shp`.

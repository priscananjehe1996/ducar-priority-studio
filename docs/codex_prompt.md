# Codex handoff: reconcile Priority Studio's road classification with the corrected DUCAR authoritative dataset

## Context

MoWT's authoritative DUCAR network dataset (`DUCAR_Final_Deliverables_2026`, maintained outside this repo) has just been corrected. This repo's own road classification pipeline (`docs/ROAD_MAPPING_PIPELINE.md`, `docs/DUCAR_OSM_Road_Classification_Rules.csv`) does not yet reflect that correction, and needs a second classification pass added so Priority Studio's screening numbers stop diverging from the authoritative ones.

## What changed in the authoritative dataset

A field-surveyed Community Access Roads shapefile (MoWT's ground-truth survey of village/rural access roads) was spatially overlaid against the full national network: each candidate way tagged as an Urban-tier class (Urban Road, KCCA, City Roads, Municipal Roads, or Town Council Roads) was buffered 25m and checked for >=50% length-overlap against the field-surveyed community access geometry. Any way meeting that threshold was reclassified from its Urban-tier label to Community Access Road. National Road and District Road were untouched.

Result: 12,537 ways (7,540.16 km) moved from Urban-tier classes into Community Access Road. Corrected national totals, by class:

| Class | Length (km) |
|---|---|
| National Road | 22,203.49 |
| District Road | 19,094.56 |
| Community Access Road | 168,151.72 |
| Urban Road (residual, unmatched to any gazetted boundary) | 26,357.43 |
| KCCA | 1,551.91 |
| City Roads | 1,793.71 |
| Municipal Roads | 4,254.98 |
| Town Council Roads | 4,871.27 |

## The gap in this repo

`docs/DUCAR_OSM_Road_Classification_Rules.csv` classifies purely from raw OSM `highway=*` tags:
- `residential`, `living_street` -> Urban Road
- - `unclassified`, `service`, `track` -> Community Access Road
 
  - This is a reasonable first-pass screen, but it has no spatial-correction step: it cannot know that a `residential`-tagged way actually sits on a field-surveyed community access road. Any Priority Studio analysis built purely on this OSM-tag pass will systematically over-count Urban Road (and KCCA/City/Municipal/Town Council, wherever this pipeline screens those separately) and under-count Community Access Road - the same bias the authoritative dataset had before its correction.
 
  - ## Requested work
 
  - 1. Add a second classification pass after the existing OSM-tag screen: ingest a field-surveyed community access roads shapefile as a new pipeline input (ask the repo owner for the current copy - do not fabricate one), buffer it 25m, and reclassify any way the OSM-tag pass labeled Urban Road (or KCCA/City/Municipal/Town Council, if this pipeline screens those separately elsewhere) to Community Access Road wherever length-overlap is >=50%. Mirror the authoritative methodology described above rather than inventing a new threshold.
    2. 2. Update `docs/ROAD_MAPPING_PIPELINE.md` and `docs/DUCAR_OSM_Road_Classification_Rules.csv` to document this second pass explicitly, so the classification logic is traceable end to end.
       3. 3. Wherever Priority Studio's UI or exports surface Urban Road / Community Access Road counts, lengths, or scores, either apply the corrected pass or add a short, explicit note that these are OSM-tag-screening-only figures and will differ from MoWT's authoritative DUCAR totals until the second pass is applied. Never silently present screening-only figures as authoritative.
          4. 4. Leave National Road and District Road classification untouched - the correction does not affect those classes.
             5. 5. Do not add source file paths, individual names, or inspector names anywhere in UI text, saved records, or exports (standing platform-wide confidentiality rule).
               
                6. ## Not in scope for this handoff
               
                7. - Standing up a live database/Supabase backend for this repo - that is a separate, already-tracked workstream.
                   - - Touching the authoritative `DUCAR_Final_Deliverables_2026` files themselves - those are already corrected and live; this handoff is only about reconciling this repo's own screening pipeline with them.
                     - 

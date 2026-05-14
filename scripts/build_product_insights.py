"""Build the compact product insight store.

This keeps the bulky evidence extraction JSON as a back-end artifact and ships
only materialized query outputs needed by the public product interface.
"""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DATA = ROOT / "public" / "data"
DATA_DIR = ROOT / "data"
SOURCE = PUBLIC_DATA / "evidence_synthesis.json"
OUT_PUBLIC = PUBLIC_DATA / "product_insights.json"
OUT_DATA = DATA_DIR / "product_insights.json"


def top_chart(chart: dict, limit: int = 8) -> dict:
    return {
        "title": chart.get("title", ""),
        "columns": chart.get("columns", []),
        "rows": (chart.get("rows") or [])[:limit],
    }


def main() -> None:
    evidence = json.loads(SOURCE.read_text(encoding="utf-8"))
    spatial = evidence.get("spatialEvidence") or {}
    inventory = evidence.get("fileInventory") or {}
    payload = {
        "generated_at_utc": evidence.get("generated_at_utc"),
        "source": "materialized from evidence_synthesis.json",
        "summary": evidence.get("summary", {}),
        "sourceCoverage": {
            "sourceAreaChart": top_chart((evidence.get("sourceCoverage") or {}).get("sourceAreaChart") or {}, 8),
        },
        "documentTopicChart": (evidence.get("documentTopicChart") or [])[:8],
        "spatialEvidence": {
            "summary": spatial.get("summary", {}),
            "featureChart": top_chart(spatial.get("featureChart") or {}, 8),
            "geometryChart": top_chart(spatial.get("geometryChart") or {}, 6),
        },
        "fileInventory": {
            "summary": inventory.get("summary", {}),
        },
        "storyCards": [
            card for card in evidence.get("storyCards", [])
            if card.get("title") in {
                "Local evidence corpus",
                "Decision-topic spine",
                "Global case transfer",
                "Spatial evidence atlas",
            }
        ],
    }
    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUT_PUBLIC.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    OUT_DATA.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps({
        "documents": payload["summary"].get("core_documents_read", 0),
        "spatial_layers": payload["summary"].get("spatial_layers_read", 0),
        "inventory_files": payload["summary"].get("local_inventory_files", 0),
    }, indent=2))


if __name__ == "__main__":
    main()

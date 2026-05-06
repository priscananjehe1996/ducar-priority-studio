"""Build a compact catalogue of the local UNRA manuals repository.

The source folder contains manuals plus attachments, images, databases and
legacy project files. The app uses all file records for statistics, while the
`logic_records` subset flags document-like files that can inform decision rules.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANUALS_ROOT = Path(r"D:\OneDrive\Uganda National Road Network Repository\0. Manuals")
PUBLIC_OUT = ROOT / "public" / "data" / "manuals_catalog.json"
DATA_OUT = ROOT / "data" / "manuals_catalog.json"

DOCUMENT_EXTENSIONS = {
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".mdb",
    ".accdb",
}

TOPIC_RULES = [
    ("Asset management", ["asset", "rams", "rms", "pms", "management", "policy", "strategy", "dtims"]),
    ("Road condition", ["condition", "visual", "inspection", "iri", "roughness", "rutting", "romdas", "pavement"]),
    ("Traffic and axle loading", ["traffic", "axle", "load", "vehicle", "aadt", "weigh"]),
    ("GIS and referencing", ["gis", "location", "referencing", "network", "dictionary", "format"]),
    ("Bridge and structures", ["bridge", "bms", "culvert", "structure"]),
    ("Quality management", ["qmp", "quality", "template", "procedure", "specification"]),
    ("Construction and supervision", ["construction", "supervision", "boq", "contract", "variation", "payment"]),
    ("Environment and safeguards", ["environment", "social", "safety", "resettlement", "waste", "latrine"]),
    ("Training and systems", ["training", "user manual", "software", "capture", "database", "administration"]),
]


def classify_topic(relative_path: str) -> str:
    text = relative_path.lower().replace("_", " ")
    for topic, needles in TOPIC_RULES:
        if any(needle in text for needle in needles):
            return topic
    return "Other repository evidence"


def evidence_role(path: Path, relative_path: str) -> str:
    ext = path.suffix.lower()
    text = relative_path.lower()
    if ext not in DOCUMENT_EXTENSIONS:
        return "Attachment / media / executable"
    if any(token in text for token in ["manual", "guide", "guideline", "policy", "strategy", "procedure", "qmp", "dictionary", "specification"]):
        return "Primary manual / rule source"
    if ext in {".xls", ".xlsx", ".mdb", ".accdb"}:
        return "Template / database / tabular source"
    if any(token in text for token in ["training", "presentation", "ppt"]):
        return "Training and implementation source"
    return "Supporting document"


def main() -> None:
    files = []
    by_folder = Counter()
    by_extension = Counter()
    by_topic = Counter()
    by_role = Counter()
    total_bytes = 0
    logic_records = []

    for path in sorted(MANUALS_ROOT.rglob("*")):
        if not path.is_file():
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        relative = str(path.relative_to(MANUALS_ROOT)).replace("\\", "/")
        folder = relative.split("/")[0] if "/" in relative else "Root"
        ext = path.suffix.lower() or "[none]"
        topic = classify_topic(relative)
        role = evidence_role(path, relative)
        record = {
            "relative_path": relative,
            "name": path.name,
            "folder": folder,
            "extension": ext,
            "size_bytes": stat.st_size,
            "topic": topic,
            "evidence_role": role,
        }
        files.append(record)
        by_folder[folder] += 1
        by_extension[ext] += 1
        by_topic[topic] += 1
        by_role[role] += 1
        total_bytes += stat.st_size
        if role != "Attachment / media / executable":
            logic_records.append(record)

    topic_cards = []
    for topic, count in by_topic.most_common():
        doc_count = sum(1 for item in logic_records if item["topic"] == topic)
        topic_cards.append(
            {
                "topic": topic,
                "all_files": count,
                "logic_records": doc_count,
                "decision_use": {
                    "Asset management": "Policy, strategy, lifecycle planning and RAMS governance weighting.",
                    "Road condition": "Condition survey completeness, monitoring tier and deterioration-trigger checks.",
                    "Traffic and axle loading": "Traffic evidence, axle-load risk and road-user effects assumptions.",
                    "GIS and referencing": "Route naming, linear referencing, network matrix and spatial QA checks.",
                    "Bridge and structures": "Structure criticality, BMS evidence and bridge/culvert inspection gates.",
                    "Quality management": "QMP, validation, data acceptance and auditability scoring.",
                    "Construction and supervision": "Readiness, work standards, BOQ, supervision and contract controls.",
                    "Environment and safeguards": "Climate, safety, environmental and social risk screening.",
                    "Training and systems": "Implementation capacity, user readiness and system administration.",
                }.get(topic, "Supporting evidence and implementation reference."),
            }
        )

    payload = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_root": str(MANUALS_ROOT),
        "summary": {
            "all_files": len(files),
            "logic_records": len(logic_records),
            "total_bytes": total_bytes,
            "folders": len(by_folder),
            "extensions": len(by_extension),
            "topics": len(by_topic),
        },
        "by_folder": dict(by_folder.most_common()),
        "by_extension": dict(by_extension.most_common()),
        "by_topic": dict(by_topic.most_common()),
        "by_evidence_role": dict(by_role.most_common()),
        "topic_cards": topic_cards,
        "logic_records": logic_records[:750],
        "files": files,
    }
    PUBLIC_OUT.parent.mkdir(parents=True, exist_ok=True)
    DATA_OUT.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    DATA_OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps(payload["summary"], indent=2))


if __name__ == "__main__":
    main()

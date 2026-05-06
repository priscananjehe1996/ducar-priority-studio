from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def manifest_path(root: Path) -> Path:
    return root / "public" / "data" / "uganda_layers_manifest.json"


def load_manifest(root: Path) -> dict[str, Any]:
    path = manifest_path(root)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def write_manifest(root: Path, manifest: dict[str, Any]) -> Path:
    path = manifest_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    manifest = dict(manifest)
    manifest["updated_at_utc"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return path


def update_manifest(root: Path, updates: dict[str, Any]) -> Path:
    manifest = load_manifest(root)
    manifest.update(updates)
    return write_manifest(root, manifest)


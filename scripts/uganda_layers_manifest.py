from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LOCAL_DATA_PREFIX = "local-data/"
LOCAL_ARTIFACT_PREFIX = "local-artifact/"


def manifest_path(root: Path) -> Path:
    return root / "public" / "data" / "uganda_layers_manifest.json"


def normalise_manifest_value(root: Path, value: Any) -> Any:
    if not isinstance(value, str) or not value.strip():
        return value

    text = value.replace("\\", "/")
    if text.startswith(("http://", "https://", "data/", LOCAL_DATA_PREFIX, LOCAL_ARTIFACT_PREFIX)):
        return text
    if text.startswith("public/"):
        return text.removeprefix("public/")

    path = Path(value)
    if not path.is_absolute():
        return text

    public_root = root / "public"
    data_root = root / "data"
    try:
        return path.relative_to(public_root).as_posix()
    except ValueError:
        pass
    try:
        return f"{LOCAL_DATA_PREFIX}{path.relative_to(data_root).as_posix()}"
    except ValueError:
        pass
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return f"{LOCAL_ARTIFACT_PREFIX}{path.name}"


def resolve_manifest_path(root: Path, value: Any, fallback: Path | None = None) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        return fallback

    text = value.replace("\\", "/")
    if text.startswith("data/"):
        return root / "public" / text
    if text.startswith(LOCAL_DATA_PREFIX):
        return root / "data" / text.removeprefix(LOCAL_DATA_PREFIX)
    if text.startswith(LOCAL_ARTIFACT_PREFIX):
        return fallback

    path = Path(value)
    if path.is_absolute():
        return path
    return root / text


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
    manifest = {key: normalise_manifest_value(root, value) for key, value in dict(manifest).items()}
    manifest["updated_at_utc"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return path


def update_manifest(root: Path, updates: dict[str, Any]) -> Path:
    manifest = load_manifest(root)
    manifest.update(updates)
    return write_manifest(root, manifest)

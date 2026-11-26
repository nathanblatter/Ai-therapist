"""Regenerate analysis/expected_schema.json from the export registry.

The export's column registry (DATASET_FILES in
src/server/services/datasetExport.service.ts) is the single source of truth
for the CSV bundle. This tool copies file names, column order and column types
out of it so the analysis loader can refuse an export that has drifted.

Running this is a DELIBERATE act: it changes what the analysis accepts. After
running it, bump SCHEMA_VERSION handling in schema.py if a column the analysis
uses changed meaning, and re-run `make all`.

    python -m phase2.sync_schema            # from analysis/
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTRY = REPO_ROOT / "src" / "server" / "services" / "datasetExport.service.ts"
TARGET = REPO_ROOT / "analysis" / "expected_schema.json"


def extract() -> dict[str, list[dict[str, str]]]:
    src = REGISTRY.read_text()
    body = src[src.index("export const DATASET_FILES") : src.index("export const TRANSCRIPT_FILES")]
    files: dict[str, list[dict[str, str]]] = {}
    current: str | None = None
    for m in re.finditer(r"file: '([^']+)'|name: '([^']+)',\s*type: '([^']+)'", body):
        if m.group(1):
            current = m.group(1)
            files[current] = []
        else:
            assert current is not None
            files[current].append({"name": m.group(2), "type": m.group(3)})
    return files


def main() -> None:
    previous = json.loads(TARGET.read_text()) if TARGET.exists() else {"schema_version": 0}
    files = extract()
    changed = previous.get("files") != files
    out = {
        "schema_version": previous["schema_version"] + (1 if changed else 0),
        "source": "src/server/services/datasetExport.service.ts (DATASET_FILES)",
        "files": files,
    }
    TARGET.write_text(json.dumps(out, indent=2) + "\n")
    print(f"{'updated' if changed else 'unchanged'}: {TARGET} (schema_version {out['schema_version']})")
    for name, cols in files.items():
        print(f"  {name}: {len(cols)} columns")


if __name__ == "__main__":
    main()

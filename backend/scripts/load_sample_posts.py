from __future__ import annotations

from pathlib import Path
import sys


BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent
SAMPLE_PATH = REPO_DIR / "docs" / "data" / "1365.json"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.collector.normalize import load_json_items, normalize_record
from app.collector.repository import upsert_records
from app.core.database import init_db


def main() -> None:
    init_db()
    items = load_json_items(SAMPLE_PATH)
    records = []
    for item in items:
        source_post_id = str(item.get("progrmRegistNo") or "").strip()
        title = str(item.get("progrmSj") or "").strip()
        if not source_post_id or not title:
            continue
        records.append(normalize_record(item))
    count = upsert_records(records)
    print(f"Upserted {count} sample volunteer posts into volunteer_db")


if __name__ == "__main__":
    main()

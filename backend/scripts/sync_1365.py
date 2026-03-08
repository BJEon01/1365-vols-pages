from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sys


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.collector.service import CollectorSettings, sync_live_posts


TRUE_VALUES = {"1", "true", "yes", "on"}
DEFAULT_OUTPUT_JSON = BACKEND_DIR.parent / "docs" / "data" / "volunteer_posts.json"


def main() -> None:
    settings = CollectorSettings.from_env()
    write_db = os.getenv("ENABLE_DB_SYNC", "true").lower() in TRUE_VALUES
    output_json_path = Path(os.getenv("EXPORT_JSON_PATH", str(DEFAULT_OUTPUT_JSON)))

    if write_db:
        from app.core.database import init_db

        init_db()

    summary = asyncio.run(
        sync_live_posts(
            settings,
            write_db=write_db,
            output_json_path=output_json_path,
        )
    )
    print("1365 live sync completed")
    print(f"  db sync enabled: {write_db}")
    print(f"  exported json: {output_json_path}")
    print(f"  fetched: {summary.fetched_count}")
    print(f"  normalized: {summary.normalized_count}")
    print(f"  upserted: {summary.upserted_count}")
    print(f"  detail checked: {summary.detail_checked_count}")
    print(f"  detail recruit updates: {summary.detail_recruit_updates}")
    print(f"  detail applied updates: {summary.detail_applied_updates}")


if __name__ == "__main__":
    main()

from __future__ import annotations

import asyncio
from pathlib import Path
import sys

from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

load_dotenv(BACKEND_DIR / ".env")

from app.ai.enrichment import AiEnrichmentSettings, enrich_json_file


def main() -> None:
    settings = AiEnrichmentSettings.from_env()
    summary = asyncio.run(enrich_json_file(settings))

    print("AI field enrichment completed")
    print(f"  input json: {settings.input_json_path}")
    print(f"  output json: {summary.output_path}")
    print(f"  total items: {summary.total_items}")
    print(f"  target items: {summary.target_items}")
    print(f"  enriched items: {summary.enriched_items}")
    print(f"  skipped items: {summary.skipped_items}")
    print(f"  failed items: {summary.failed_items}")
    if summary.error_samples:
        print("  error samples:")
        for sample in summary.error_samples:
            print(f"    - {sample}")


if __name__ == "__main__":
    main()

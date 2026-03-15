from __future__ import annotations

from pathlib import Path
import sys

from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

load_dotenv(BACKEND_DIR / ".env")

from app.ai import SimilarPostsSettings, generate_similar_posts


def main() -> None:
    settings = SimilarPostsSettings.from_env()
    summary = generate_similar_posts(settings)

    print("Similar post generation completed")
    print(f"  input json: {settings.input_json_path}")
    print(f"  output json: {summary.output_path}")
    print(f"  total items: {summary.total_items}")
    print(f"  processed items: {summary.processed_items}")


if __name__ == "__main__":
    main()

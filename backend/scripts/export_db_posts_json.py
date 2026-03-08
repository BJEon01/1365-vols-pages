from __future__ import annotations

from pathlib import Path
import sys

from sqlalchemy import select


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.collector.service import export_records_to_json
from app.core.database import SessionLocal
from app.models import VolunteerPost


OUTPUT_PATH = BACKEND_DIR.parent / "docs" / "data" / "volunteer_posts.json"


def main() -> None:
    with SessionLocal() as session:
        posts = session.scalars(select(VolunteerPost).order_by(VolunteerPost.id.asc())).all()

    records = [
        {column.name: getattr(post, column.name) for column in VolunteerPost.__table__.columns}
        for post in posts
    ]
    export_records_to_json(records, OUTPUT_PATH)
    print(f"Exported {len(records)} posts to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()

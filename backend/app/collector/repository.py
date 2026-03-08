from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy.dialects.postgresql import insert

from app.models import VolunteerPost


UPSERT_CONFLICT_KEYS = ("source_provider", "source_post_id")


def upsert_records(records: Sequence[dict[str, object]]) -> int:
    if not records:
        return 0

    from app.core.database import SessionLocal

    stmt = insert(VolunteerPost).values(list(records))
    update_columns = {
        key: getattr(stmt.excluded, key)
        for key in records[0].keys()
        if key not in UPSERT_CONFLICT_KEYS
    }

    with SessionLocal.begin() as session:
        session.execute(
            stmt.on_conflict_do_update(
                index_elements=list(UPSERT_CONFLICT_KEYS),
                set_=update_columns,
            )
        )
    return len(records)

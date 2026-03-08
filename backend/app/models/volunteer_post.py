from datetime import date, datetime, time

from sqlalchemy import JSON, BigInteger, Boolean, Date, DateTime, Index, Integer, String, Text, Time
from sqlalchemy import UniqueConstraint, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class VolunteerPost(Base):
    __tablename__ = "volunteer_posts"
    __table_args__ = (
        UniqueConstraint(
            "source_provider",
            "source_post_id",
            name="uq_volunteer_posts_source_provider_source_post_id",
        ),
        Index("ix_volunteer_posts_province_city_district", "province", "city_district"),
        Index("ix_volunteer_posts_volunteer_date_start_end", "volunteer_date_start", "volunteer_date_end"),
        Index("ix_volunteer_posts_recruit_end_date", "recruit_end_date"),
        Index("ix_volunteer_posts_status", "status"),
        Index("ix_volunteer_posts_activity_type", "activity_type"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    source_provider: Mapped[str] = mapped_column(String(32), nullable=False, default="1365")
    source_post_id: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    organization_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    province: Mapped[str | None] = mapped_column(String(64), nullable=True)
    city_district: Mapped[str | None] = mapped_column(String(100), nullable=True)
    place_text: Mapped[str | None] = mapped_column(String(255), nullable=True)
    recruit_start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    recruit_end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    volunteer_date_start: Mapped[date | None] = mapped_column(Date, nullable=True)
    volunteer_date_end: Mapped[date | None] = mapped_column(Date, nullable=True)
    time_text: Mapped[str | None] = mapped_column(String(100), nullable=True)
    start_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    end_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    activity_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    target_text: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str | None] = mapped_column(String(50), nullable=True)
    recruit_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    applied_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_remote: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default=text("false"),
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_url: Mapped[str] = mapped_column(String(500), nullable=False)
    raw_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    collected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

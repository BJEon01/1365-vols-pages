from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel, ConfigDict


SortOption = Literal[
    "recruit_end_date_asc",
    "recruit_end_date_desc",
    "volunteer_date_start_asc",
    "volunteer_date_start_desc",
    "collected_at_desc",
]


class PostSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_provider: str
    source_post_id: str
    title: str
    organization_name: str | None = None
    province: str | None = None
    city_district: str | None = None
    place_text: str | None = None
    recruit_end_date: date | None = None
    volunteer_date_start: date | None = None
    volunteer_date_end: date | None = None
    start_time: time | None = None
    end_time: time | None = None
    activity_type: str | None = None
    status: str | None = None
    recruit_count: int | None = None
    applied_count: int | None = None
    is_remote: bool
    source_url: str
    collected_at: datetime
    updated_at: datetime


class PostDetail(PostSummary):
    recruit_start_date: date | None = None
    recruit_end_date: date | None = None
    time_text: str | None = None
    target_text: str | None = None
    description: str | None = None
    raw_payload: dict | None = None
    created_at: datetime


class PostListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[PostSummary]

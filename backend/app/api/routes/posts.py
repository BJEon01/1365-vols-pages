from datetime import date
import re
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import VolunteerPost
from app.schemas.post import PostDetail, PostListResponse, SortOption
from app.services.location_terms import city_district_candidates, province_patterns


router = APIRouter(prefix="/api/posts", tags=["posts"])


def _split_keyword_terms(keyword: str) -> list[str]:
    return [term.strip() for term in re.split(r"[\s,]+", keyword) if term.strip()]


def _split_location_terms(value: str) -> list[str]:
    return [term.strip() for term in re.split(r"[\s,]+", value) if term.strip()]


def _apply_filters(
    stmt,
    *,
    keyword: str | None,
    province: str | None,
    city_district: str | None,
    activity_type: str | None,
    status: str | None,
    min_recruit_count: int | None,
    date_from: date | None,
    date_to: date | None,
):
    if keyword:
        terms = _split_keyword_terms(keyword)
        for term in terms:
            stmt = stmt.where(
                or_(
                    VolunteerPost.title.ilike(f"%{term}%"),
                    VolunteerPost.organization_name.ilike(f"%{term}%"),
                    VolunteerPost.place_text.ilike(f"%{term}%"),
                    VolunteerPost.description.ilike(f"%{term}%"),
                    VolunteerPost.target_text.ilike(f"%{term}%"),
                )
            )
    if province:
        province_candidates: list[str] = []
        for term in _split_location_terms(province):
            province_candidates.extend(province_patterns(term))
        province_candidates = list(dict.fromkeys(province_candidates))
        stmt = stmt.where(
            or_(
                *[
                    VolunteerPost.province.ilike(f"%{pattern}%")
                    for pattern in province_candidates
                ]
            )
        )
    if city_district:
        district_candidates: list[str] = []
        for term in _split_location_terms(city_district):
            district_candidates.extend(city_district_candidates(term))
        district_candidates = list(dict.fromkeys(district_candidates))
        stmt = stmt.where(
            or_(
                *[
                    VolunteerPost.city_district.ilike(f"%{candidate}%")
                    for candidate in district_candidates
                ]
            )
        )
    stmt = stmt.where(VolunteerPost.recruit_count.is_not(None))
    stmt = stmt.where(VolunteerPost.applied_count.is_not(None))
    if activity_type:
        stmt = stmt.where(VolunteerPost.activity_type == activity_type)
    if status:
        stmt = stmt.where(VolunteerPost.status == status)
    if min_recruit_count is not None:
        stmt = stmt.where(VolunteerPost.recruit_count.is_not(None))
        stmt = stmt.where(VolunteerPost.recruit_count >= min_recruit_count)
    if date_from:
        stmt = stmt.where(
            or_(
                VolunteerPost.volunteer_date_end.is_(None),
                VolunteerPost.volunteer_date_end >= date_from,
            )
        )
    if date_to:
        stmt = stmt.where(
            or_(
                VolunteerPost.volunteer_date_start.is_(None),
                VolunteerPost.volunteer_date_start <= date_to,
            )
        )
    return stmt


def _apply_sort(stmt, sort: SortOption):
    sort_map = {
        "recruit_end_date_asc": (
            VolunteerPost.recruit_end_date.asc().nulls_last(),
            VolunteerPost.id.desc(),
        ),
        "recruit_end_date_desc": (
            VolunteerPost.recruit_end_date.desc().nulls_last(),
            VolunteerPost.id.desc(),
        ),
        "volunteer_date_start_asc": (
            VolunteerPost.volunteer_date_start.asc().nulls_last(),
            VolunteerPost.id.desc(),
        ),
        "volunteer_date_start_desc": (
            VolunteerPost.volunteer_date_start.desc().nulls_last(),
            VolunteerPost.id.desc(),
        ),
        "collected_at_desc": (
            VolunteerPost.collected_at.desc(),
            VolunteerPost.id.desc(),
        ),
    }
    return stmt.order_by(*sort_map[sort])


@router.get("", response_model=PostListResponse)
def list_posts(
    db: Session = Depends(get_db),
    keyword: str | None = Query(default=None),
    province: str | None = Query(default=None),
    city_district: str | None = Query(default=None),
    activity_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    min_recruit_count: int | None = Query(default=None, ge=0),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    sort: Annotated[SortOption, Query()] = "recruit_end_date_asc",
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PostListResponse:
    base_stmt = select(VolunteerPost)
    base_stmt = _apply_filters(
        base_stmt,
        keyword=keyword,
        province=province,
        city_district=city_district,
        activity_type=activity_type,
        status=status,
        min_recruit_count=min_recruit_count,
        date_from=date_from,
        date_to=date_to,
    )

    total = db.scalar(select(func.count()).select_from(base_stmt.order_by(None).subquery())) or 0
    items = db.scalars(_apply_sort(base_stmt, sort).limit(limit).offset(offset)).all()

    return PostListResponse(total=total, limit=limit, offset=offset, items=items)


@router.get("/{post_id}", response_model=PostDetail)
def get_post(post_id: int, db: Session = Depends(get_db)) -> PostDetail:
    post = db.scalar(select(VolunteerPost).where(VolunteerPost.id == post_id))
    if post is None:
        raise HTTPException(status_code=404, detail="Post not found")
    return PostDetail.model_validate(post)

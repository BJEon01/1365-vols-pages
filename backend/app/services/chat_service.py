from datetime import date, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models import VolunteerPost
from app.schemas.chat import ChatRecommendItem, ChatRecommendResponse, ParsedConditions
from app.schemas.post import PostSummary
from app.services.location_terms import city_district_candidates, province_patterns
from app.services.parser_service import parse_message


TEXT_COLUMNS = (
    VolunteerPost.title,
    VolunteerPost.organization_name,
    VolunteerPost.place_text,
    VolunteerPost.description,
    VolunteerPost.target_text,
)


def _apply_sql_filters(stmt, parsed: ParsedConditions, *, include_keywords: bool):
    stmt = stmt.where(VolunteerPost.recruit_count.is_not(None))
    stmt = stmt.where(VolunteerPost.applied_count.is_not(None))
    if parsed.recruiting_only:
        stmt = stmt.where(VolunteerPost.status == "recruiting")
    if parsed.province:
        stmt = stmt.where(
            or_(*[VolunteerPost.province.ilike(f"%{pattern}%") for pattern in province_patterns(parsed.province)])
        )
    if parsed.city_district:
        stmt = stmt.where(
            or_(
                *[
                    VolunteerPost.city_district.ilike(f"%{candidate}%")
                    for candidate in city_district_candidates(parsed.city_district)
                ]
            )
        )
    if parsed.min_recruit_count is not None:
        stmt = stmt.where(VolunteerPost.recruit_count >= parsed.min_recruit_count)
    if include_keywords and parsed.keywords:
        stmt = stmt.where(
            or_(
                *[
                    column.ilike(f"%{keyword}%")
                    for keyword in parsed.keywords
                    for column in TEXT_COLUMNS
                ]
            )
        )
    return stmt


def _candidate_posts(db: Session, parsed: ParsedConditions, *, include_keywords: bool) -> list[VolunteerPost]:
    stmt = select(VolunteerPost)
    stmt = _apply_sql_filters(stmt, parsed, include_keywords=include_keywords)
    stmt = stmt.order_by(
        VolunteerPost.recruit_end_date.asc().nulls_last(),
        VolunteerPost.id.desc(),
    )
    return list(db.scalars(stmt.limit(80)).all())


def _date_matches_day_type(start: date | None, end: date | None, day_type: str | None) -> bool:
    if not day_type:
        return True
    if start is None and end is None:
        return False
    start_date = start or end
    end_date = end or start
    if start_date is None or end_date is None:
        return False
    span_days = (end_date - start_date).days
    if span_days >= 7:
        return True
    current = start_date
    while current <= end_date:
        is_weekend = current.weekday() >= 5
        if day_type == "weekend" and is_weekend:
            return True
        if day_type == "weekday" and not is_weekend:
            return True
        current += timedelta(days=1)
    return False


def _time_matches_slot(post: VolunteerPost, time_slot: str | None) -> bool:
    if not time_slot:
        return True
    if post.start_time is None and post.end_time is None:
        return False

    start_minutes = (post.start_time.hour * 60 + post.start_time.minute) if post.start_time else None
    end_minutes = (post.end_time.hour * 60 + post.end_time.minute) if post.end_time else None
    if start_minutes is None:
        start_minutes = end_minutes
    if end_minutes is None:
        end_minutes = start_minutes
    if start_minutes is None or end_minutes is None:
        return False

    slot_ranges = {
        "morning": (6 * 60, 12 * 60),
        "afternoon": (12 * 60, 18 * 60),
        "evening": (18 * 60, 24 * 60),
    }
    slot_start, slot_end = slot_ranges[time_slot]
    return start_minutes < slot_end and end_minutes >= slot_start


def _searchable_text(post: VolunteerPost) -> str:
    return " ".join(
        [
            post.title or "",
            post.organization_name or "",
            post.place_text or "",
            post.description or "",
            post.target_text or "",
        ]
    )


def _score_post(post: VolunteerPost, parsed: ParsedConditions) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    searchable_text = _searchable_text(post)

    if parsed.province and post.province and parsed.province in post.province:
        score += 3
        reasons.append(f"{post.province} 지역 조건과 일치합니다.")
    if parsed.city_district and post.city_district and parsed.city_district.replace("구", "") in post.city_district:
        score += 3
        reasons.append(f"{post.city_district} 조건과 맞는 공고입니다.")
    if parsed.day_type and _date_matches_day_type(post.volunteer_date_start, post.volunteer_date_end, parsed.day_type):
        score += 2
        reasons.append("요청한 요일 조건과 맞는 일정입니다.")
    if parsed.time_slot and _time_matches_slot(post, parsed.time_slot):
        score += 2
        reasons.append("원하는 시간대와 겹칩니다.")
    keyword_hits = [keyword for keyword in parsed.keywords if keyword in searchable_text]
    if keyword_hits:
        score += len(keyword_hits) * 2
        reasons.append(f"{', '.join(keyword_hits)} 키워드와 관련된 공고입니다.")
    if parsed.min_recruit_count is not None and (post.recruit_count or 0) >= parsed.min_recruit_count:
        score += 1
        reasons.append(f"모집 인원이 {parsed.min_recruit_count}명 이상입니다.")
    if post.status == "recruiting":
        score += 1
    if not reasons:
        reasons.append("입력한 조건과 관련도가 높은 공고입니다.")
    return score, reasons


def _build_summary(parsed: ParsedConditions, result_count: int) -> str:
    parts: list[str] = []
    if parsed.province:
        parts.append(parsed.province)
    if parsed.city_district:
        parts.append(parsed.city_district)
    if parsed.day_type == "weekend":
        parts.append("주말")
    elif parsed.day_type == "weekday":
        parts.append("평일")
    if parsed.time_slot == "morning":
        parts.append("오전")
    elif parsed.time_slot == "afternoon":
        parts.append("오후")
    elif parsed.time_slot == "evening":
        parts.append("저녁")
    if parsed.keywords:
        parts.append(", ".join(parsed.keywords))
    if parsed.min_recruit_count is not None:
        parts.append(f"모집 {parsed.min_recruit_count}명 이상")
    if not parts:
        parts.append("최근 모집중 공고")
    return f"{' / '.join(parts)} 기준으로 {result_count}개를 추천했습니다."


def recommend_posts(db: Session, message: str) -> ChatRecommendResponse:
    parsed = parse_message(message)
    candidates = _candidate_posts(db, parsed, include_keywords=True)
    if not candidates and parsed.keywords:
        candidates = _candidate_posts(db, parsed, include_keywords=False)

    scored_candidates: list[tuple[int, VolunteerPost, list[str]]] = []
    for post in candidates:
        score, reasons = _score_post(post, parsed)
        scored_candidates.append((score, post, reasons))

    scored_candidates.sort(
        key=lambda item: (
            -item[0],
            item[1].recruit_end_date or date.max,
            -(item[1].recruit_count or 0),
            -item[1].id,
        )
    )

    results = [
        ChatRecommendItem(
            post=PostSummary.model_validate(post),
            reason=" ".join(reasons[:2]),
        )
        for _, post, reasons in scored_candidates[:5]
    ]

    summary = (
        _build_summary(parsed, len(results))
        if results
        else "입력한 조건으로 추천할 공고를 찾지 못했습니다."
    )
    return ChatRecommendResponse(
        summary=summary,
        parsed_conditions=parsed,
        results=results,
    )

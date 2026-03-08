import re

from app.schemas.chat import ParsedConditions
from app.services.location_terms import detect_city_district_in_text, detect_province_in_text, province_for_city_district


DAY_TYPE_PATTERNS = {
    "weekend": ("주말", "토요일", "일요일", "토일"),
    "weekday": ("평일", "월요일", "화요일", "수요일", "목요일", "금요일"),
}

TIME_SLOT_PATTERNS = {
    "morning": ("오전", "아침", "이른아침"),
    "afternoon": ("오후", "낮"),
    "evening": ("저녁", "야간", "밤"),
}

KEYWORD_GROUPS = {
    "교육": ("교육", "학습", "멘토", "멘토링", "공부방", "학습지도"),
    "아동": ("아동", "어린이", "아이", "유아", "청소년"),
    "환경": ("환경", "정화", "플로깅", "줍깅", "하천", "공원"),
    "행사": ("행사", "축제", "부스", "안내", "박람회", "운영요원"),
    "노인": ("어르신", "노인", "실버"),
    "돌봄": ("돌봄", "보육", "복지"),
    "급식": ("급식", "배식", "도시락"),
    "의료": ("의료", "병원", "간호", "보건"),
    "문화": ("문화", "공연", "전시", "예술"),
    "체육": ("체육", "스포츠", "운동"),
}


def _extract_day_type(message: str) -> str | None:
    for canonical, patterns in DAY_TYPE_PATTERNS.items():
        if any(pattern in message for pattern in patterns):
            return canonical
    return None


def _extract_time_slot(message: str) -> str | None:
    for canonical, patterns in TIME_SLOT_PATTERNS.items():
        if any(pattern in message for pattern in patterns):
            return canonical
    return None


def _extract_keywords(message: str) -> list[str]:
    keywords: list[str] = []
    for canonical, patterns in KEYWORD_GROUPS.items():
        if any(pattern in message for pattern in patterns):
            keywords.append(canonical)
    return keywords


def _extract_min_recruit_count(message: str) -> int | None:
    match = re.search(r"(\d+)\s*명\s*(이상|넘는|넘게|정도)", message)
    if not match:
        return None
    return int(match.group(1))


def parse_message(message: str) -> ParsedConditions:
    normalized = message.strip()
    city_district = detect_city_district_in_text(normalized)
    province = detect_province_in_text(normalized) or province_for_city_district(city_district)
    return ParsedConditions(
        province=province,
        city_district=city_district,
        day_type=_extract_day_type(normalized),
        time_slot=_extract_time_slot(normalized),
        keywords=_extract_keywords(normalized),
        min_recruit_count=_extract_min_recruit_count(normalized),
        recruiting_only=True,
    )

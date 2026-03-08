from __future__ import annotations

from datetime import date, time
import json
from pathlib import Path
import re
from typing import Mapping


SEOUL_DISTRICTS = [
    "강남구",
    "강동구",
    "강북구",
    "강서구",
    "관악구",
    "광진구",
    "구로구",
    "금천구",
    "노원구",
    "도봉구",
    "동대문구",
    "동작구",
    "마포구",
    "서대문구",
    "서초구",
    "성동구",
    "성북구",
    "송파구",
    "양천구",
    "영등포구",
    "용산구",
    "은평구",
    "종로구",
    "중구",
    "중랑구",
]

PROVINCE_PATTERNS = [
    ("서울", "서울특별시"),
    ("부산", "부산광역시"),
    ("대구", "대구광역시"),
    ("인천", "인천광역시"),
    ("광주", "광주광역시"),
    ("대전", "대전광역시"),
    ("울산", "울산광역시"),
    ("세종", "세종특별자치시"),
    ("경기", "경기도"),
    ("강원", "강원특별자치도"),
    ("충북", "충청북도"),
    ("충남", "충청남도"),
    ("전북", "전북특별자치도"),
    ("전남", "전라남도"),
    ("경북", "경상북도"),
    ("경남", "경상남도"),
    ("제주", "제주특별자치도"),
]

REMOTE_PATTERN = re.compile(r"비대면|온라인|원격|재택")


def parse_date(value: object) -> date | None:
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) < 8:
        return None
    try:
        return date(int(digits[:4]), int(digits[4:6]), int(digits[6:8]))
    except ValueError:
        return None


def parse_time_value(hour: object, minute: object) -> time | None:
    hour_digits = re.sub(r"\D", "", str(hour or ""))
    minute_digits = re.sub(r"\D", "", str(minute or ""))
    if not hour_digits:
        return None
    try:
        parsed_hour = int(hour_digits)
        parsed_minute = int(minute_digits or "0")
    except ValueError:
        return None
    if parsed_hour > 23 or parsed_minute > 59:
        return None
    return time(hour=parsed_hour, minute=parsed_minute)


def parse_int(value: object) -> int | None:
    digits = re.sub(r"\D", "", str(value or ""))
    return int(digits) if digits else None


def build_time_text(item: Mapping[str, object]) -> str | None:
    start = parse_time_value(item.get("actBeginTm"), item.get("actBeginMnt"))
    end = parse_time_value(item.get("actEndTm"), item.get("actEndMnt"))
    if start is None or end is None:
        return None
    return f"{start.strftime('%H:%M')} ~ {end.strftime('%H:%M')}"


def detect_district(text: str) -> str | None:
    return next((district for district in SEOUL_DISTRICTS if district in text), None)


def detect_province(text: str, district: str | None) -> str | None:
    if district:
        return "서울특별시"
    for token, province in PROVINCE_PATTERNS:
        if token in text:
            return province
    return None


def detect_status(recruit_end_date: date | None, recruit_count: int | None, applied_count: int | None) -> str:
    today = date.today()
    if recruit_end_date and recruit_end_date < today:
        return "closed"
    if recruit_count is not None and applied_count is not None and applied_count >= recruit_count:
        return "filled"
    return "recruiting"


def build_source_url(source_post_id: str) -> str:
    return (
        "https://www.1365.go.kr/vols/P9210/partcptn/timeCptn.do"
        f"?type=show&progrmRegistNo={source_post_id}"
    )


def normalize_record(item: Mapping[str, object]) -> dict[str, object]:
    source_post_id = str(item.get("progrmRegistNo") or "").strip()
    title = str(item.get("progrmSj") or "").strip()
    organization_name = str(item.get("nanmmbyNm") or item.get("mnnstNm") or "").strip() or None
    place_text = str(item.get("actPlace") or "").strip() or None
    combined_text = " ".join(filter(None, [title, organization_name or "", place_text or ""]))
    district = detect_district(combined_text)
    province = detect_province(combined_text, district)
    recruit_start_date = parse_date(item.get("noticeBgnde"))
    recruit_end_date = parse_date(item.get("noticeEndde"))
    volunteer_date_start = parse_date(item.get("progrmBgnde"))
    volunteer_date_end = parse_date(item.get("progrmEndde"))
    start_time = parse_time_value(item.get("actBeginTm"), item.get("actBeginMnt"))
    end_time = parse_time_value(item.get("actEndTm"), item.get("actEndMnt"))
    recruit_count = parse_int(item.get("rcritNmpr"))
    applied_count = parse_int(item.get("aplyNmpr"))
    is_remote = bool(REMOTE_PATTERN.search(combined_text))

    return {
        "source_provider": "1365",
        "source_post_id": source_post_id,
        "title": title,
        "organization_name": organization_name,
        "province": province,
        "city_district": district,
        "place_text": place_text,
        "recruit_start_date": recruit_start_date,
        "recruit_end_date": recruit_end_date,
        "volunteer_date_start": volunteer_date_start,
        "volunteer_date_end": volunteer_date_end,
        "time_text": build_time_text(item),
        "start_time": start_time,
        "end_time": end_time,
        "activity_type": None,
        "target_text": None,
        "status": detect_status(recruit_end_date, recruit_count, applied_count),
        "recruit_count": recruit_count,
        "applied_count": applied_count,
        "is_remote": is_remote,
        "description": None,
        "source_url": build_source_url(source_post_id),
        "raw_payload": dict(item),
    }


def load_json_items(path: Path) -> list[dict[str, object]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("items", [])
    if not isinstance(items, list):
        raise ValueError(f"{path} does not contain an items list")
    return [item for item in items if isinstance(item, dict)]

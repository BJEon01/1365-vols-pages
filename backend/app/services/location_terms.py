PROVINCE_ALIASES = {
    "서울특별시": {"서울", "서울시", "서울특별시"},
    "부산광역시": {"부산", "부산시", "부산광역시"},
    "대구광역시": {"대구", "대구시", "대구광역시"},
    "인천광역시": {"인천", "인천시", "인천광역시"},
    "광주광역시": {"광주", "광주시", "광주광역시"},
    "대전광역시": {"대전", "대전시", "대전광역시"},
    "울산광역시": {"울산", "울산시", "울산광역시"},
    "세종특별자치시": {"세종", "세종시", "세종특별자치시"},
    "경기도": {"경기", "경기도"},
    "강원특별자치도": {"강원", "강원도", "강원특별자치도"},
    "충청북도": {"충북", "충청북도"},
    "충청남도": {"충남", "충청남도"},
    "전북특별자치도": {"전북", "전라북도", "전북특별자치도"},
    "전라남도": {"전남", "전라남도"},
    "경상북도": {"경북", "경상북도"},
    "경상남도": {"경남", "경상남도"},
    "제주특별자치도": {"제주", "제주도", "제주특별자치도"},
}

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

DISTRICT_ALIASES = {
    district: {district, district.removesuffix("구"), district.removesuffix("군"), district.removesuffix("시")}
    for district in SEOUL_DISTRICTS
}


def canonicalize_province(value: str) -> str:
    normalized = value.strip()
    for canonical, aliases in PROVINCE_ALIASES.items():
        if normalized in aliases:
            return canonical
    return normalized


def province_patterns(value: str) -> list[str]:
    normalized = value.strip()
    if not normalized:
        return []
    canonical = canonicalize_province(normalized)
    return [pattern for pattern in {normalized, canonical} if pattern]


def city_district_candidates(value: str) -> list[str]:
    normalized = value.strip()
    if not normalized:
        return []
    if normalized.endswith(("구", "군", "시", "읍", "면")):
        return [normalized]
    return [
        normalized,
        f"{normalized}구",
        f"{normalized}군",
        f"{normalized}시",
        f"{normalized}읍",
        f"{normalized}면",
    ]


def detect_province_in_text(text: str) -> str | None:
    normalized = text.strip()
    matches: list[tuple[int, str]] = []
    for canonical, aliases in PROVINCE_ALIASES.items():
        for alias in aliases:
            if len(alias) < 2:
                continue
            if alias in normalized:
                matches.append((len(alias), canonical))
    if not matches:
        return None
    matches.sort(reverse=True)
    return matches[0][1]


def detect_city_district_in_text(text: str) -> str | None:
    normalized = text.strip()
    matches: list[tuple[int, str]] = []
    for canonical, aliases in DISTRICT_ALIASES.items():
        for alias in aliases:
            if len(alias) < 2:
                continue
            if alias in normalized:
                matches.append((len(alias), canonical))
    if not matches:
        return None
    matches.sort(reverse=True)
    return matches[0][1]


def province_for_city_district(city_district: str | None) -> str | None:
    if city_district in SEOUL_DISTRICTS:
        return "서울특별시"
    return None

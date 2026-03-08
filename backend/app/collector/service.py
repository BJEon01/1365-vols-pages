from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
import json
import os
from pathlib import Path
import re
from typing import Any
from xml.etree import ElementTree

import httpx

from app.collector.normalize import SEOUL_DISTRICTS, normalize_record
from app.collector.repository import upsert_records


TRUE_VALUES = {"1", "true", "yes", "on"}
UNLIMITED_VALUES = {"0", "all", "none", "unlimited", "full"}
LIST_ENDPOINT = "http://openapi.1365.go.kr/openapi/service/rest/VolunteerPartcptnService/getVltrSearchWordList"
DETAIL_ENDPOINT = "https://www.1365.go.kr/vols/P9210/partcptn/timeCptn.do"
SEOUL_SIDO_CODE = "6110000"
DEFAULT_DETAIL_CACHE_PATH = Path(__file__).resolve().parents[2] / "data" / "detail_cache.json"

RECRUIT_LABELS = (
    "\uBAA8\uC9D1\\s*\uC778\uC6D0",
    "\uCD1D\\s*\uBAA8\uC9D1\\s*\uC778\uC6D0",
)
APPLIED_LABELS = (
    "\uC2E0\uCCAD\\s*\uC778\uC6D0",
    "\uC2E0\uCCAD\\s*\uD604\uD669",
    "\uC2E0\uCCAD\\s*\uC815\uBCF4",
    "\uD604\uC7AC\\s*\uC2E0\uCCAD",
)


@dataclass(slots=True, frozen=True)
class CollectorSettings:
    service_key: str
    page_size: int = 100
    max_pages: int = 50
    max_items: int | None = None
    keyword: str = ""
    sido_code: str | None = None
    gugun_code: str | None = None
    shard_seoul_districts: bool = True
    progrm_status_code: str | None = None
    recruiting_only: bool = True
    enrich_detail_counts: bool = True
    detail_concurrency: int = 12
    max_detail: int | None = 300
    detail_cache_path: Path | None = DEFAULT_DETAIL_CACHE_PATH
    detail_cache_ttl_hours: float = 72.0
    request_timeout_seconds: float = 20.0

    @classmethod
    def from_env(cls) -> "CollectorSettings":
        service_key = os.getenv("H1365_SERVICE_KEY", "").strip()
        if not service_key:
            raise ValueError("H1365_SERVICE_KEY is required for live collection")

        max_detail_raw = os.getenv("H1365_MAX_DETAIL", "").strip()
        max_items_raw = os.getenv("H1365_MAX_ITEMS", "").strip()
        detail_cache_path_raw = os.getenv("H1365_DETAIL_CACHE_PATH", "").strip()
        max_detail: int | None
        if max_detail_raw.lower() in UNLIMITED_VALUES:
            max_detail = None
        else:
            max_detail = int(max_detail_raw) if max_detail_raw else 300
        max_items = int(max_items_raw) if max_items_raw else None
        return cls(
            service_key=service_key,
            page_size=int(os.getenv("H1365_PAGE_SIZE", "100")),
            max_pages=int(os.getenv("H1365_MAX_PAGES", "50")),
            max_items=max_items,
            keyword=os.getenv("H1365_KEYWORD", "").strip(),
            sido_code=os.getenv("H1365_SIDO_CODE", "").strip() or None,
            gugun_code=os.getenv("H1365_GUGUN_CODE", "").strip() or None,
            shard_seoul_districts=os.getenv("H1365_SHARD_SEOUL_DISTRICTS", "true").lower() in TRUE_VALUES,
            progrm_status_code=os.getenv("H1365_PROGRM_STATUS_CODE", "").strip() or None,
            recruiting_only=os.getenv("H1365_RECRUITING_ONLY", "true").lower() in TRUE_VALUES,
            enrich_detail_counts=os.getenv("H1365_ENRICH_DETAIL_COUNTS", "true").lower() in TRUE_VALUES,
            detail_concurrency=int(os.getenv("H1365_DETAIL_CONCURRENCY", "12")),
            max_detail=max_detail,
            detail_cache_path=(
                Path(detail_cache_path_raw)
                if detail_cache_path_raw
                else DEFAULT_DETAIL_CACHE_PATH
            ),
            detail_cache_ttl_hours=float(os.getenv("H1365_DETAIL_CACHE_TTL_HOURS", "72")),
            request_timeout_seconds=float(os.getenv("H1365_REQUEST_TIMEOUT_SECONDS", "20")),
        )


@dataclass(slots=True, frozen=True)
class SyncSummary:
    fetched_count: int
    normalized_count: int
    upserted_count: int
    detail_checked_count: int
    detail_recruit_updates: int
    detail_applied_updates: int


def _serialize_value(value: object) -> object:
    if isinstance(value, (date, datetime, time)):
        return value.isoformat()
    if isinstance(value, list):
        return [_serialize_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _serialize_value(item) for key, item in value.items()}
    return value


def export_records_to_json(records: list[dict[str, object]], output_path: str | os.PathLike[str]) -> Path:
    export_path = Path(output_path)
    export_path.parent.mkdir(parents=True, exist_ok=True)
    exported_at = datetime.now(timezone.utc).isoformat()

    items: list[dict[str, object]] = []
    for record in records:
        serialized = {key: _serialize_value(value) for key, value in record.items()}
        serialized.setdefault("id", str(serialized.get("source_post_id") or ""))
        serialized.setdefault("collected_at", exported_at)
        serialized.setdefault("created_at", exported_at)
        serialized.setdefault("updated_at", exported_at)
        items.append(serialized)

    payload = {
        "updatedAt": exported_at,
        "count": len(items),
        "items": items,
    }
    export_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return export_path


def _load_detail_cache(cache_path: Path | None) -> dict[str, dict[str, str]]:
    if cache_path is None or not cache_path.exists():
        return {}
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}

    loaded: dict[str, dict[str, str]] = {}
    for key, value in payload.items():
        if not isinstance(value, dict):
            continue
        loaded[str(key)] = {
            "recruit": str(value.get("recruit") or "").strip(),
            "applied": str(value.get("applied") or "").strip(),
            "fetchedAt": str(value.get("fetchedAt") or "").strip(),
        }
    return loaded


def _write_detail_cache(cache_path: Path | None, cache: dict[str, dict[str, str]]) -> None:
    if cache_path is None:
        return
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def _cache_is_fresh(entry: dict[str, str], ttl_hours: float) -> bool:
    fetched_at_raw = entry.get("fetchedAt") or ""
    if not fetched_at_raw:
        return False
    try:
        fetched_at = datetime.fromisoformat(fetched_at_raw)
    except ValueError:
        return False
    if fetched_at.tzinfo is None:
        fetched_at = fetched_at.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - fetched_at <= timedelta(hours=ttl_hours)


def _to_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _parse_api_date(value: object) -> date | None:
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) < 8:
        return None
    try:
        return date(int(digits[:4]), int(digits[4:6]), int(digits[6:8]))
    except ValueError:
        return None


def _is_currently_recruiting(item: dict[str, object]) -> bool:
    today_value = date.today()
    start = _parse_api_date(item.get("noticeBgnde"))
    end = _parse_api_date(item.get("noticeEndde"))
    if start and today_value < start:
        return False
    if end and today_value > end:
        return False
    return True


def _pick_number(text: str) -> str:
    match = re.search(r"([0-9][0-9,]*)\s*\uBA85", text)
    return match.group(1).replace(",", "") if match else ""


def _extract_count_by_labels(html: str, labels: tuple[str, ...]) -> str:
    for label in labels:
        patterns = (
            rf"<dt[^>]*>\s*(?:{label})\s*</dt>[\s\S]{{0,200}}?(<dd[^>]*>[\s\S]*?</dd>)",
            rf"<th[^>]*>\s*(?:{label})[\s\S]{{0,120}}?<td[^>]*>([\s\S]{{0,100}}?)</td>",
            rf"(?:{label})[\s\S]{{0,300}}?([0-9][0-9,]*)\s*\uBA85",
        )
        for pattern in patterns:
            match = re.search(pattern, html, flags=re.IGNORECASE)
            if not match:
                continue
            candidate = re.sub(r"<[^>]+>", " ", match.group(1))
            number = _pick_number(candidate)
            if number:
                return number
    return ""


def _extract_detail_counts(html: str) -> tuple[str, str]:
    recruit = _extract_count_by_labels(html, RECRUIT_LABELS)
    applied = _extract_count_by_labels(html, APPLIED_LABELS)
    if not applied:
        match = re.search(
            r"\uC2E0\uCCAD[^0-9]{0,10}?([0-9][0-9,]*)\s*\uBA85\s*/\s*([0-9][0-9,]*)\s*\uBA85",
            html,
        )
        if match:
            applied = match.group(1).replace(",", "")
    return recruit, applied


def _parse_body(text: str, content_type: str) -> tuple[list[dict[str, object]], int]:
    stripped = text.strip()
    if "json" in content_type.lower() or stripped.startswith("{"):
        payload = json.loads(stripped)
        header = payload.get("response", {}).get("header", {})
        result_code = header.get("resultCode")
        if result_code not in (None, "00"):
            raise ValueError(f"1365 API error {result_code}: {header.get('resultMsg')}")
        body = payload.get("response", {}).get("body", {})
        items_value = (body.get("items") or {}).get("item")
        items = _to_list(items_value)
        return [item for item in items if isinstance(item, dict)], int(body.get("totalCount") or 0)

    root = ElementTree.fromstring(stripped)
    header = root.find("header")
    if header is not None:
        result_code = header.findtext("resultCode")
        if result_code not in (None, "00"):
            raise ValueError(f"1365 API error {result_code}: {header.findtext('resultMsg')}")

    body = root.find("body")
    if body is None:
        return [], 0
    total_count = int(body.findtext("totalCount") or 0)
    items_parent = body.find("items")
    if items_parent is None:
        return [], total_count

    items: list[dict[str, object]] = []
    for item in items_parent.findall("item"):
        items.append({child.tag: (child.text or "").strip() for child in item})
    return items, total_count


class Volunteer1365Client:
    def __init__(self, settings: CollectorSettings):
        self.settings = settings
        self._client = httpx.AsyncClient(
            timeout=settings.request_timeout_seconds,
            follow_redirects=True,
            headers={
                "Accept-Language": "ko,en;q=0.8",
                "User-Agent": "Mozilla/5.0",
            },
            limits=httpx.Limits(max_keepalive_connections=20, max_connections=50),
        )

    async def __aenter__(self) -> "Volunteer1365Client":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self._client.aclose()

    async def fetch_list_page(self, page_no: int, *, extra_keyword: str = "") -> tuple[list[dict[str, object]], int]:
        params = {
            "serviceKey": self.settings.service_key,
            "numOfRows": str(self.settings.page_size),
            "pageNo": str(page_no),
            "_type": "json",
        }
        keyword = " ".join(part for part in (self.settings.keyword, extra_keyword) if part).strip()
        if keyword:
            params["keyword"] = keyword
        if self.settings.sido_code:
            params["sidoCd"] = self.settings.sido_code
        if self.settings.gugun_code:
            params["gugunCd"] = self.settings.gugun_code
        if self.settings.progrm_status_code:
            params["progrmSttusSe"] = self.settings.progrm_status_code

        response = await self._client.get(LIST_ENDPOINT, params=params)
        response.raise_for_status()
        return _parse_body(response.text, response.headers.get("content-type", ""))

    async def fetch_detail_counts(self, source_post_id: str) -> tuple[str, str]:
        response = await self._client.get(
            DETAIL_ENDPOINT,
            params={
                "type": "show",
                "progrmRegistNo": source_post_id,
            },
        )
        response.raise_for_status()
        return _extract_detail_counts(response.text)


async def _collect_raw_items_for_keyword(
    client: Volunteer1365Client,
    settings: CollectorSettings,
    *,
    extra_keyword: str = "",
) -> list[dict[str, object]]:
    seen_ids: set[str] = set()
    collected: list[dict[str, object]] = []
    for page_no in range(1, settings.max_pages + 1):
        items, _ = await client.fetch_list_page(page_no, extra_keyword=extra_keyword)
        if not items:
            break
        for item in items:
            source_post_id = str(item.get("progrmRegistNo") or "").strip()
            title = str(item.get("progrmSj") or "").strip()
            if not source_post_id or not title:
                continue
            if settings.recruiting_only and not _is_currently_recruiting(item):
                continue
            if source_post_id in seen_ids:
                continue
            seen_ids.add(source_post_id)
            item.setdefault("aplyNmpr", "")
            collected.append(item)
            if settings.max_items is not None and len(collected) >= settings.max_items:
                return collected
    return collected


async def _collect_raw_items(client: Volunteer1365Client, settings: CollectorSettings) -> list[dict[str, object]]:
    if settings.sido_code == SEOUL_SIDO_CODE and settings.shard_seoul_districts:
        seen_ids: set[str] = set()
        merged: list[dict[str, object]] = []
        for extra_keyword in ("", *SEOUL_DISTRICTS):
            shard_items = await _collect_raw_items_for_keyword(client, settings, extra_keyword=extra_keyword)
            for item in shard_items:
                source_post_id = str(item.get("progrmRegistNo") or "").strip()
                if not source_post_id or source_post_id in seen_ids:
                    continue
                seen_ids.add(source_post_id)
                merged.append(item)
                if settings.max_items is not None and len(merged) >= settings.max_items:
                    return merged
        return merged
    return await _collect_raw_items_for_keyword(client, settings)


async def _enrich_detail_counts(
    client: Volunteer1365Client,
    items: list[dict[str, object]],
    *,
    concurrency: int,
    max_detail: int | None,
    cache_path: Path | None,
    cache_ttl_hours: float,
) -> tuple[int, int, int]:
    detail_targets = items[:max_detail] if max_detail is not None else items
    semaphore = asyncio.Semaphore(max(1, concurrency))
    recruit_updates = 0
    applied_updates = 0
    detail_cache = _load_detail_cache(cache_path)

    async def enrich(item: dict[str, object]) -> None:
        nonlocal recruit_updates, applied_updates
        source_post_id = str(item.get("progrmRegistNo") or "").strip()
        if not source_post_id:
            return

        cache_entry = detail_cache.get(source_post_id)
        if cache_entry:
            cached_recruit = cache_entry.get("recruit") or ""
            cached_applied = cache_entry.get("applied") or ""
            if cached_recruit and not str(item.get("rcritNmpr") or "").strip():
                item["rcritNmpr"] = cached_recruit
            if cached_applied and not str(item.get("aplyNmpr") or "").strip():
                item["aplyNmpr"] = cached_applied
            if cached_recruit and cached_applied and _cache_is_fresh(cache_entry, cache_ttl_hours):
                return

        try:
            async with semaphore:
                recruit_value, applied_value = await client.fetch_detail_counts(source_post_id)
        except Exception:
            return

        if recruit_value and not str(item.get("rcritNmpr") or "").strip():
            item["rcritNmpr"] = recruit_value
            recruit_updates += 1
        if applied_value:
            item["aplyNmpr"] = applied_value
            applied_updates += 1

        detail_cache[source_post_id] = {
            "recruit": str(item.get("rcritNmpr") or "").strip(),
            "applied": str(item.get("aplyNmpr") or "").strip(),
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        }

    await asyncio.gather(*(enrich(item) for item in detail_targets))
    _write_detail_cache(cache_path, detail_cache)
    return len(detail_targets), recruit_updates, applied_updates


async def sync_live_posts(
    settings: CollectorSettings,
    *,
    write_db: bool = True,
    output_json_path: str | os.PathLike[str] | None = None,
) -> SyncSummary:
    async with Volunteer1365Client(settings) as client:
        raw_items = await _collect_raw_items(client, settings)
        detail_checked_count = 0
        detail_recruit_updates = 0
        detail_applied_updates = 0

        if settings.enrich_detail_counts and raw_items:
            detail_checked_count, detail_recruit_updates, detail_applied_updates = await _enrich_detail_counts(
                client,
                raw_items,
                concurrency=settings.detail_concurrency,
                max_detail=settings.max_detail,
                cache_path=settings.detail_cache_path,
                cache_ttl_hours=settings.detail_cache_ttl_hours,
            )

    normalized_records = [normalize_record(item) for item in raw_items]
    upserted_count = upsert_records(normalized_records) if write_db else 0
    if output_json_path:
        export_records_to_json(normalized_records, output_json_path)
    return SyncSummary(
        fetched_count=len(raw_items),
        normalized_count=len(normalized_records),
        upserted_count=upserted_count,
        detail_checked_count=detail_checked_count,
        detail_recruit_updates=detail_recruit_updates,
        detail_applied_updates=detail_applied_updates,
    )

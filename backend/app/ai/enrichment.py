from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field
from tqdm import tqdm


DEFAULT_JSON_PATH = Path(__file__).resolve().parents[3] / "docs" / "data" / "volunteer_posts.json"
TRUE_VALUES = {"1", "true", "yes", "on"}
OUTDOOR_HINTS = (
    "야외",
    "공원",
    "하천",
    "거리",
    "광장",
    "행사장",
    "운동장",
    "플로깅",
    "환경정화",
    "캠페인",
    "축제",
    "현장",
    "산책",
)
INDOOR_HINTS = (
    "실내",
    "복지관",
    "도서관",
    "센터",
    "학교",
    "교실",
    "강의실",
    "매장",
    "지점",
    "사무",
    "온라인",
    "비대면",
    "병원",
    "학습관",
    "박물관",
)


class SummaryTagsResult(BaseModel):
    summary: str = Field(description="공고의 핵심을 보여주는 한국어 한줄 요약")
    tags: list[str] = Field(description="공고 성격을 설명하는 짧은 한국어 태그 목록")


@dataclass(slots=True, frozen=True)
class AiEnrichmentSettings:
    input_json_path: Path = DEFAULT_JSON_PATH
    output_json_path: Path = DEFAULT_JSON_PATH
    model: str = "gpt-4o-mini"
    batch_limit: int | None = None
    concurrency: int = 5
    force_regenerate: bool = False
    save_every: int = 10
    tag_limit: int = 6
    max_description_chars: int = 1200
    temperature: float = 0.1

    @classmethod
    def from_env(cls) -> "AiEnrichmentSettings":
        if not os.getenv("OPENAI_API_KEY", "").strip():
            raise ValueError("OPENAI_API_KEY is required for AI enrichment")

        batch_limit_raw = os.getenv("AI_BATCH_LIMIT", "").strip()
        return cls(
            input_json_path=Path(os.getenv("AI_INPUT_JSON_PATH", str(DEFAULT_JSON_PATH))),
            output_json_path=Path(os.getenv("AI_OUTPUT_JSON_PATH", str(DEFAULT_JSON_PATH))),
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip(),
            batch_limit=int(batch_limit_raw) if batch_limit_raw else None,
            concurrency=max(1, int(os.getenv("AI_CONCURRENCY", "5"))),
            force_regenerate=os.getenv("AI_FORCE_REGENERATE", "false").lower() in TRUE_VALUES,
            save_every=max(1, int(os.getenv("AI_SAVE_EVERY", "10"))),
            tag_limit=max(1, int(os.getenv("AI_TAG_LIMIT", "6"))),
            max_description_chars=max(200, int(os.getenv("AI_MAX_DESCRIPTION_CHARS", "1200"))),
            temperature=float(os.getenv("AI_TEMPERATURE", "0.1")),
        )


@dataclass(slots=True, frozen=True)
class AiEnrichmentRunSummary:
    total_items: int
    target_items: int
    enriched_items: int
    skipped_items: int
    failed_items: int
    output_path: Path
    error_samples: list[str]


def _read_payload(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    items = payload.get("items")
    if not isinstance(items, list):
        raise ValueError(f"{path} does not contain an items list")
    return payload


def _write_payload(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _needs_enrichment(item: dict[str, Any], *, force_regenerate: bool) -> bool:
    if force_regenerate:
        return True
    summary = str(item.get("summary") or "").strip()
    tags = item.get("tags")
    has_tags = isinstance(tags, list) and any(str(tag or "").strip() for tag in tags)
    return not summary or not has_tags


def _clip_text(value: object, *, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "..."


def _build_input_text(item: dict[str, Any], *, max_description_chars: int) -> str:
    description = _clip_text(item.get("description"), limit=max_description_chars)
    lines = [
        f"제목: {item.get('title') or '-'}",
        f"기관명: {item.get('organization_name') or '-'}",
        f"지역/장소: {' / '.join(part for part in [item.get('province'), item.get('city_district'), item.get('place_text')] if part) or '-'}",
        f"봉사기간: {item.get('volunteer_date_start') or '-'} ~ {item.get('volunteer_date_end') or '-'}",
        f"봉사시간: {item.get('time_text') or '-'}",
        f"활동유형: {item.get('activity_type') or '-'}",
        f"대상: {item.get('target_text') or '-'}",
        f"설명: {description or '-'}",
    ]
    return "\n".join(lines)


def _normalize_summary(value: object) -> str:
    lines = [re.sub(r"\s+", " ", line).strip().strip("\"' ") for line in str(value or "").splitlines()]
    lines = [line for line in lines if line]
    return "\n".join(lines[:3])


def _infer_space_tag(item: dict[str, Any]) -> str:
    haystack = " ".join(
        str(part or "")
        for part in (
            item.get("title"),
            item.get("organization_name"),
            item.get("place_text"),
            item.get("description"),
        )
    )
    if any(token in haystack for token in OUTDOOR_HINTS):
        return "실외"
    if any(token in haystack for token in INDOOR_HINTS):
        return "실내"
    if item.get("is_remote"):
        return "실내"
    return "실내"


def _normalize_tags(tags: list[object], *, limit: int) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_tag in tags:
        tag = re.sub(r"\s+", " ", str(raw_tag or "")).strip().strip("#")
        if not tag or tag in seen:
            continue
        seen.add(tag)
        normalized.append(tag)
        if len(normalized) >= limit:
            break
    return normalized


def _ensure_space_tag(item: dict[str, Any], tags: list[str], *, limit: int) -> list[str]:
    if "실내" in tags or "실외" in tags:
        return tags[:limit]
    ensured = list(tags)
    ensured.append(_infer_space_tag(item))
    deduped: list[str] = []
    seen: set[str] = set()
    for tag in ensured:
        if tag in seen:
            continue
        seen.add(tag)
        deduped.append(tag)
        if len(deduped) >= limit:
            break
    return deduped


async def _generate_summary_tags(
    llm: ChatOpenAI,
    item: dict[str, Any],
    *,
    tag_limit: int,
    max_description_chars: int,
) -> SummaryTagsResult:
    structured_llm = llm.with_structured_output(SummaryTagsResult)
    messages = [
        SystemMessage(
            content=(
                "너는 한국 자원봉사 공고를 정리하는 도우미다. "
                "반드시 한국어로만 답한다. "
                "출력은 summary와 tags만 생성한다. "
                "summary 작성 규칙: "
                "1~3줄로 작성한다. "
                "핵심 활동이 바로 보이게 쓴다. "
                "각 줄은 짧고 읽기 쉽게 쓴다. "
                "과장, 홍보 문구, 감탄 표현은 쓰지 않는다. "
                "제목 문구를 그대로 복붙하지 않는다. "
                "제목의 연속된 표현을 길게 반복하지 않는다. "
                "제목은 참고만 하고, 활동 내용을 일반화해서 다시 표현한다. "
                "본문이 비어 있어도 제목을 그대로 옮기지 말고 활동 중심으로 바꿔 쓴다. "
                "기관명과 지명은 꼭 필요할 때만 넣는다. "
                "무슨 활동의 봉사인지 바로 알 수 있게 쓴다. "
                "tags 작성 규칙: "
                f"중복 없이 {tag_limit}개 이하로 작성한다. "
                "짧은 한국어 명사 또는 명사구만 사용한다. "
                "가능하면 아래 유형의 태그를 우선 사용한다: "
                "활동분야(교육, 환경, 행사운영, 돌봄, 안내, 정리정돈, IT, 행정보조), "
                "대상(아동, 청소년, 노인, 장애인, 외국인, 지역주민), "
                "형태(대면, 비대면, 실내, 야외, 단기, 정기), "
                "역할(학습보조, 멘토링, 캠페인, 배부, 안내보조, 말벗). "
                "태그에 기관명 전체 문구나 날짜를 넣지 않는다. "
                "태그에는 반드시 실내 또는 실외 중 하나를 포함한다."
            )
        ),
        HumanMessage(
            content=(
                "아래 자원봉사 공고를 읽고 summary와 tags를 생성해줘.\n\n"
                f"{_build_input_text(item, max_description_chars=max_description_chars)}"
            )
        ),
    ]
    return await structured_llm.ainvoke(messages)


async def enrich_json_file(settings: AiEnrichmentSettings) -> AiEnrichmentRunSummary:
    payload = _read_payload(settings.input_json_path)
    items = payload["items"]
    for item in items:
        item.setdefault("summary", None)
        item.setdefault("tags", [])
        item.setdefault("similar_post_ids", [])

    targets = [item for item in items if _needs_enrichment(item, force_regenerate=settings.force_regenerate)]
    if settings.batch_limit is not None:
        targets = targets[: settings.batch_limit]

    llm = ChatOpenAI(model=settings.model, temperature=settings.temperature)
    semaphore = asyncio.Semaphore(settings.concurrency)

    enriched_items = 0
    failed_items = 0
    completed_items = 0
    error_samples: list[str] = []

    async def enrich_one(item: dict[str, Any]) -> tuple[dict[str, Any], SummaryTagsResult | None, Exception | None]:
        try:
            async with semaphore:
                result = await _generate_summary_tags(
                    llm,
                    item,
                    tag_limit=settings.tag_limit,
                    max_description_chars=settings.max_description_chars,
                )
            return item, result, None
        except Exception as exc:
            return item, None, exc

    progress = tqdm(total=len(targets), desc="AI enrich", unit="post")
    tasks = [asyncio.create_task(enrich_one(item)) for item in targets]
    for future in asyncio.as_completed(tasks):
        item, result, error = await future
        completed_items += 1

        if error is None and result is not None:
            item["summary"] = _normalize_summary(result.summary) or None
            item["tags"] = _ensure_space_tag(
                item,
                _normalize_tags(result.tags, limit=settings.tag_limit),
                limit=settings.tag_limit,
            )
            enriched_items += 1
        else:
            failed_items += 1
            if len(error_samples) < 3:
                item_id = str(item.get("id") or item.get("source_post_id") or "").strip()
                error_samples.append(f"{item_id or 'unknown'}: {error}")

        progress.update(1)
        progress.set_postfix_str(f"ok={enriched_items} fail={failed_items}")
        if completed_items % settings.save_every == 0:
            _write_payload(settings.output_json_path, payload)

    progress.close()

    _write_payload(settings.output_json_path, payload)
    return AiEnrichmentRunSummary(
        total_items=len(items),
        target_items=len(targets),
        enriched_items=enriched_items,
        skipped_items=len(items) - len(targets),
        failed_items=failed_items,
        output_path=settings.output_json_path,
        error_samples=error_samples,
    )

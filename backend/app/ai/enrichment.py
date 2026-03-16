from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_ollama import ChatOllama
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field
from tqdm import tqdm


DEFAULT_JSON_PATH = Path(__file__).resolve().parents[3] / "docs" / "data" / "volunteer_posts.json"
TRUE_VALUES = {"1", "true", "yes", "on"}
class SummaryTagsResult(BaseModel):
    summary: str = Field(description="공고의 핵심을 보여주는 한국어 한줄 요약")
    tags: list[str] = Field(description="공고 성격을 설명하는 짧은 한국어 태그 목록")


@dataclass(slots=True, frozen=True)
class AiEnrichmentSettings:
    input_json_path: Path = DEFAULT_JSON_PATH
    output_json_path: Path = DEFAULT_JSON_PATH
    provider: str = "openai"
    model: str = "gpt-4o-mini"
    batch_limit: int | None = None
    concurrency: int = 5
    force_regenerate: bool = False
    save_every: int = 10
    tag_limit: int = 6
    max_description_chars: int = 1200
    temperature: float = 0.1
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_timeout_seconds: float = 120.0
    output_only_targets: bool = False

    @classmethod
    def from_env(cls) -> "AiEnrichmentSettings":
        provider = os.getenv("AI_PROVIDER", "openai").strip().lower() or "openai"
        if provider not in {"openai", "ollama"}:
            raise ValueError("AI_PROVIDER must be either 'openai' or 'ollama'")
        if provider == "openai" and not os.getenv("OPENAI_API_KEY", "").strip():
            raise ValueError("OPENAI_API_KEY is required when AI_PROVIDER=openai")

        batch_limit_raw = os.getenv("AI_BATCH_LIMIT", "").strip()
        return cls(
            input_json_path=Path(os.getenv("AI_INPUT_JSON_PATH", str(DEFAULT_JSON_PATH))),
            output_json_path=Path(os.getenv("AI_OUTPUT_JSON_PATH", str(DEFAULT_JSON_PATH))),
            provider=provider,
            model=(
                os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()
                if provider == "openai"
                else os.getenv("OLLAMA_MODEL", "gemma3:4b-it-qat").strip()
            ),
            batch_limit=int(batch_limit_raw) if batch_limit_raw else None,
            concurrency=max(1, int(os.getenv("AI_CONCURRENCY", "5"))),
            force_regenerate=os.getenv("AI_FORCE_REGENERATE", "false").lower() in TRUE_VALUES,
            save_every=max(1, int(os.getenv("AI_SAVE_EVERY", "10"))),
            tag_limit=max(1, int(os.getenv("AI_TAG_LIMIT", "6"))),
            max_description_chars=max(200, int(os.getenv("AI_MAX_DESCRIPTION_CHARS", "1200"))),
            temperature=float(os.getenv("AI_TEMPERATURE", "0.1")),
            ollama_base_url=os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").strip().rstrip("/"),
            ollama_timeout_seconds=float(os.getenv("OLLAMA_TIMEOUT_SECONDS", "120")),
            output_only_targets=os.getenv("AI_OUTPUT_ONLY_TARGETS", "false").lower() in TRUE_VALUES,
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


def _build_output_payload(
    payload: dict[str, Any],
    *,
    items: list[dict[str, Any]],
    targets_only: bool,
) -> dict[str, Any]:
    output_payload = dict(payload)
    output_payload["items"] = items
    output_payload["count"] = len(items)
    if targets_only:
        output_payload["sourceCount"] = len(payload.get("items") or [])
    return output_payload


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


def _build_messages(item: dict[str, Any], *, tag_limit: int, max_description_chars: int) -> tuple[str, str]:
    system_prompt = (
        "너는 한국 자원봉사 공고를 짧고 읽기 쉽게 정리하는 도우미다. "
        "반드시 한국어로만 답한다. "
        "출력은 summary와 tags만 생성한다. "
        "반드시 JSON 객체만 출력하고, 그 외의 설명, 문장, 코드블록, 머리말, 따옴표 바깥 텍스트는 절대 출력하지 않는다. "
        "공통 규칙: "
        "공고에 없는 정보는 추정하지 않는다. "
        "불명확한 정보는 생략하거나 더 일반적인 표현으로 바꾼다. "
        "본문 문장을 단순히 줄여 옮기지 말고, 사용자가 봉사 내용을 빠르게 이해할 수 있게 다시 서술한다. "
        "홍보성 표현, 감탄 표현, 과장된 표현은 쓰지 않는다. "
        "기관명, 부서명, 담당자명, 전화번호, 접수방법, 세부 행정 안내는 핵심 이해에 꼭 필요할 때만 아주 짧게 반영한다. "
        "날짜, 시간, 접수 안내, 인증 절차 자체를 요약의 중심으로 쓰지 않는다. "
        "summary 작성 규칙: "
        "summary는 1~3줄로 작성한다. "
        "각 줄은 짧고 자연스러운 한국어 문장으로 쓴다. "
        "첫 줄만 읽어도 무슨 봉사인지 알 수 있어야 한다. "
        "가장 중요한 활동 내용을 첫 줄에 둔다. "
        "가능하면 활동 내용, 대상, 방식/장소 순으로 정리한다. "
        "참여 절차나 시간 인정 조건보다 활동의 성격과 현장 역할을 먼저 설명한다. "
        "운영 안내 문구를 나열하지 말고 활동 중심으로 재구성한다. "
        "제목 문구를 그대로 복붙하지 않는다. "
        "제목의 연속된 표현을 길게 반복하지 않는다. "
        "제목은 참고만 하고, 활동 내용을 일반화해서 다시 표현한다. "
        "본문이 비어 있거나 매우 짧아도 제목을 그대로 옮기지 말고 확인 가능한 활동 중심 표현으로 바꿔 쓴다. "
        "기관명과 지명은 봉사의 성격을 이해하는 데 꼭 필요할 때만 넣는다. "
        "summary는 안내문처럼 딱딱하게 나열하지 말고, 공고 핵심을 압축한 짧은 소개문처럼 쓴다. "
        "좋은 summary의 방향: "
        "무엇을 하는 봉사인지가 먼저 보이게 쓴다. "
        "사용자가 목록에서 읽었을 때 바로 활동 장면이 떠오르게 쓴다. "
        "예: '지역 아동 학습을 돕는 교육 봉사입니다.', '행사 현장에서 안내와 진행을 지원하는 봉사입니다.', '폭설 시 지역 내 제설 작업에 참여하는 현장 봉사입니다.' "
        "반대로 '담당자 연락 후 방문', '안내에 따라 진행', '확인 후 인정' 같은 운영 문구는 필요할 때만 짧게 쓴다. "
        "tags 작성 규칙: "
        f"중복 없이 {tag_limit}개 이하로 작성한다. "
        "태그는 짧은 한국어 명사 또는 명사구만 사용한다. "
        "태그는 공고의 핵심 활동을 빠르게 분류할 수 있게 뽑는다. "
        "같은 의미의 유사 태그는 하나만 넣는다. "
        "가능하면 3~5개 정도로 작성하되, 근거가 부족하면 더 적게 작성할 수 있다. "
        "태그는 가능하면 다음 우선순위에 따라 고른다: 활동분야, 대상, 형태, 역할. "
        "가능하면 아래 유형의 태그를 우선 사용한다: "
        "활동분야(교육, 환경, 행사운영, 돌봄, 안내, 정리정돈, IT, 행정보조, 제설, 배부), "
        "대상(아동, 청소년, 노인, 장애인, 외국인, 지역주민), "
        "형태(대면, 비대면, 실내, 실외, 단기, 정기), "
        "역할(학습보조, 멘토링, 캠페인, 안내보조, 말벗, 현장지원). "
        "태그에 기관명 전체 문구, 날짜, 시간, 전화번호, 모집 표현은 넣지 않는다. "
        "실내/실외 정보는 공고에서 확인 가능할 때만 넣는다. "
        "근거가 부족한 태그는 넣지 않는다. "
        "너무 추상적인 태그(봉사, 활동, 참여, 모집, 나눔)는 넣지 않는다."
    )
    user_prompt = (
        "아래 자원봉사 공고를 읽고 summary와 tags를 생성해줘.\n"
        "반드시 아래 JSON 형식으로만 응답해줘.\n"
        "코드블록 없이 JSON 객체만 출력해줘.\n"
        '{"summary":"...", "tags":["...", "..."]}\n\n'
        f"{_build_input_text(item, max_description_chars=max_description_chars)}"
    )
    return system_prompt, user_prompt


def _parse_json_text(content: str) -> dict[str, Any]:
    text = str(content or "").strip()
    if not text:
        raise ValueError("model returned empty content")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            raise ValueError("model did not return valid JSON") from None
        return json.loads(match.group(0))


def _message_content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
                continue
            if isinstance(part, dict):
                text = str(part.get("text") or "").strip()
                if text:
                    parts.append(text)
        return "\n".join(part for part in parts if part).strip()
    return str(content or "").strip()


async def _generate_summary_tags_openai(
    llm: ChatOpenAI,
    item: dict[str, Any],
    *,
    tag_limit: int,
    max_description_chars: int,
) -> SummaryTagsResult:
    structured_llm = llm.with_structured_output(SummaryTagsResult)
    system_prompt, user_prompt = _build_messages(
        item,
        tag_limit=tag_limit,
        max_description_chars=max_description_chars,
    )
    messages = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=user_prompt),
    ]
    return await structured_llm.ainvoke(messages)


async def _generate_summary_tags_ollama(
    llm: ChatOllama,
    item: dict[str, Any],
    *,
    tag_limit: int,
    max_description_chars: int,
) -> SummaryTagsResult:
    system_prompt, user_prompt = _build_messages(
        item,
        tag_limit=tag_limit,
        max_description_chars=max_description_chars,
    )
    response = await llm.ainvoke(
        [
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt),
        ]
    )
    content = _message_content_to_text(response.content)
    parsed = _parse_json_text(content)
    return SummaryTagsResult.model_validate(parsed)


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

    llm = None
    if settings.provider == "openai":
        llm = ChatOpenAI(model=settings.model, temperature=settings.temperature)
    elif settings.provider == "ollama":
        llm = ChatOllama(
            model=settings.model,
            base_url=settings.ollama_base_url,
            temperature=settings.temperature,
            format="json",
            timeout=settings.ollama_timeout_seconds,
        )
    semaphore = asyncio.Semaphore(settings.concurrency)

    enriched_items = 0
    failed_items = 0
    completed_items = 0
    error_samples: list[str] = []

    async def enrich_one(item: dict[str, Any]) -> tuple[dict[str, Any], SummaryTagsResult | None, Exception | None]:
        try:
            async with semaphore:
                if settings.provider == "ollama":
                    result = await _generate_summary_tags_ollama(
                        llm,
                        item,
                        tag_limit=settings.tag_limit,
                        max_description_chars=settings.max_description_chars,
                    )
                else:
                    result = await _generate_summary_tags_openai(
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
            item["tags"] = _normalize_tags(result.tags, limit=settings.tag_limit)
            enriched_items += 1
        else:
            failed_items += 1
            if len(error_samples) < 3:
                item_id = str(item.get("id") or item.get("source_post_id") or "").strip()
                error_samples.append(f"{item_id or 'unknown'}: {error}")

        progress.update(1)
        progress.set_postfix_str(f"ok={enriched_items} fail={failed_items}")
        if completed_items % settings.save_every == 0:
            _write_payload(
                settings.output_json_path,
                _build_output_payload(
                    payload,
                    items=targets if settings.output_only_targets else items,
                    targets_only=settings.output_only_targets,
                ),
            )

    progress.close()

    _write_payload(
        settings.output_json_path,
        _build_output_payload(
            payload,
            items=targets if settings.output_only_targets else items,
            targets_only=settings.output_only_targets,
        ),
    )
    return AiEnrichmentRunSummary(
        total_items=len(items),
        target_items=len(targets),
        enriched_items=enriched_items,
        skipped_items=len(items) - len(targets),
        failed_items=failed_items,
        output_path=settings.output_json_path,
        error_samples=error_samples,
    )

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from langchain_core.documents import Document
from langchain_community.vectorstores import FAISS
from langchain_huggingface import HuggingFaceEmbeddings
from tqdm import tqdm


DEFAULT_JSON_PATH = Path(__file__).resolve().parents[3] / "docs" / "data" / "volunteer_posts.json"


@dataclass(slots=True, frozen=True)
class SimilarPostsSettings:
    input_json_path: Path = DEFAULT_JSON_PATH
    output_json_path: Path = DEFAULT_JSON_PATH
    model_name: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    top_k: int = 20
    batch_size: int = 64
    max_description_chars: int = 1600

    @classmethod
    def from_env(cls) -> "SimilarPostsSettings":
        return cls(
            input_json_path=Path(os.getenv("SIMILAR_INPUT_JSON_PATH", str(DEFAULT_JSON_PATH))),
            output_json_path=Path(os.getenv("SIMILAR_OUTPUT_JSON_PATH", str(DEFAULT_JSON_PATH))),
            model_name=os.getenv(
                "SIMILAR_MODEL_NAME",
                "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
            ).strip(),
            top_k=max(1, int(os.getenv("SIMILAR_TOP_K", "20"))),
            batch_size=max(1, int(os.getenv("SIMILAR_BATCH_SIZE", "64"))),
            max_description_chars=max(200, int(os.getenv("SIMILAR_MAX_DESCRIPTION_CHARS", "1600"))),
        )


@dataclass(slots=True, frozen=True)
class SimilarPostsRunSummary:
    total_items: int
    processed_items: int
    output_path: Path


def _read_payload(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    items = payload.get("items")
    if not isinstance(items, list):
        raise ValueError(f"{path} does not contain an items list")
    return payload


def _write_payload(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _clean_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _clip_text(value: object, *, limit: int) -> str:
    text = _clean_text(value)
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "..."


def _build_similarity_text(item: dict[str, Any], *, max_description_chars: int) -> str:
    text_parts = [
        _clean_text(item.get("title")),
        _clean_text(item.get("summary")),
        " ".join(str(tag or "").strip() for tag in item.get("tags") or [] if str(tag or "").strip()),
        _clean_text(item.get("activity_type")),
        _clean_text(item.get("target_text")),
        _clean_text(item.get("province")),
        _clean_text(item.get("city_district")),
        _clean_text(item.get("place_text")),
        _clip_text(item.get("description"), limit=max_description_chars),
    ]
    return "\n".join(part for part in text_parts if part)


def generate_similar_posts(settings: SimilarPostsSettings) -> SimilarPostsRunSummary:
    payload = _read_payload(settings.input_json_path)
    items = payload["items"]
    if not items:
        _write_payload(settings.output_json_path, payload)
        return SimilarPostsRunSummary(total_items=0, processed_items=0, output_path=settings.output_json_path)

    texts = [_build_similarity_text(item, max_description_chars=settings.max_description_chars) for item in items]
    embeddings = HuggingFaceEmbeddings(
        model_name=settings.model_name,
        encode_kwargs={
            "batch_size": settings.batch_size,
            "normalize_embeddings": True,
            "show_progress_bar": True,
        },
    )
    documents = [
        Document(page_content=text, metadata={"index": index})
        for index, text in enumerate(texts)
    ]
    vector_store = FAISS.from_documents(documents, embeddings)
    retriever = vector_store.as_retriever(
        search_kwargs={"k": min(len(items), settings.top_k + 1)}
    )

    for index, item in enumerate(tqdm(items, desc="Similar posts", unit="post")):
        results = retriever.invoke(texts[index])
        similar_post_ids: list[str] = []
        for result in results:
            similar_index = int(result.metadata.get("index", -1))
            if similar_index < 0 or similar_index == index:
                continue
            similar_post_id = str(items[similar_index].get("id") or items[similar_index].get("source_post_id") or "").strip()
            if not similar_post_id or similar_post_id in similar_post_ids:
                continue
            similar_post_ids.append(similar_post_id)
            if len(similar_post_ids) >= settings.top_k:
                break
        item["similar_post_ids"] = similar_post_ids

    _write_payload(settings.output_json_path, payload)
    return SimilarPostsRunSummary(
        total_items=len(items),
        processed_items=len(items),
        output_path=settings.output_json_path,
    )

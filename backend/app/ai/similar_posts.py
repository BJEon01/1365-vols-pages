from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from sentence_transformers import SentenceTransformer
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


def _normalize_embeddings(embeddings: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1.0, norms)
    return embeddings / norms


def _top_similar_indices(similarities: np.ndarray, current_index: int, top_k: int) -> list[int]:
    similarities[current_index] = -1.0
    top_indices = np.argpartition(similarities, -top_k)[-top_k:]
    top_indices = top_indices[np.argsort(similarities[top_indices])[::-1]]
    return [int(index) for index in top_indices if similarities[index] > 0]


def generate_similar_posts(settings: SimilarPostsSettings) -> SimilarPostsRunSummary:
    payload = _read_payload(settings.input_json_path)
    items = payload["items"]
    if not items:
        _write_payload(settings.output_json_path, payload)
        return SimilarPostsRunSummary(total_items=0, processed_items=0, output_path=settings.output_json_path)

    texts = [_build_similarity_text(item, max_description_chars=settings.max_description_chars) for item in items]
    model = SentenceTransformer(settings.model_name)
    embeddings = model.encode(
        texts,
        batch_size=settings.batch_size,
        show_progress_bar=True,
        convert_to_numpy=True,
        normalize_embeddings=False,
    )
    normalized = _normalize_embeddings(np.asarray(embeddings, dtype=np.float32))
    similarity_matrix = normalized @ normalized.T

    for index, item in enumerate(tqdm(items, desc="Similar posts", unit="post")):
        similar_indices = _top_similar_indices(similarity_matrix[index].copy(), index, settings.top_k)
        item["similar_post_ids"] = [str(items[similar_index].get("id") or items[similar_index].get("source_post_id")) for similar_index in similar_indices]

    _write_payload(settings.output_json_path, payload)
    return SimilarPostsRunSummary(
        total_items=len(items),
        processed_items=len(items),
        output_path=settings.output_json_path,
    )

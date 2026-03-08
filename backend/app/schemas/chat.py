from pydantic import BaseModel, Field

from app.schemas.post import PostSummary


class ChatRecommendRequest(BaseModel):
    message: str = Field(min_length=1, max_length=300)


class ParsedConditions(BaseModel):
    province: str | None = None
    city_district: str | None = None
    day_type: str | None = None
    time_slot: str | None = None
    keywords: list[str] = Field(default_factory=list)
    min_recruit_count: int | None = None
    recruiting_only: bool = True


class ChatRecommendItem(BaseModel):
    post: PostSummary
    reason: str


class ChatRecommendResponse(BaseModel):
    summary: str
    parsed_conditions: ParsedConditions
    results: list[ChatRecommendItem]

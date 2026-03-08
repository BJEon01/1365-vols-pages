from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.schemas.chat import ChatRecommendRequest, ChatRecommendResponse
from app.services.chat_service import recommend_posts


router = APIRouter(prefix="/api/chat", tags=["chat"])


@router.post("/recommend", response_model=ChatRecommendResponse)
def recommend(
    payload: ChatRecommendRequest,
    db: Session = Depends(get_db),
) -> ChatRecommendResponse:
    return recommend_posts(db, payload.message)

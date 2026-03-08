from functools import lru_cache
import os
from pathlib import Path

from pydantic import BaseModel, Field
from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parents[2]
load_dotenv(BACKEND_DIR / ".env")


TRUE_VALUES = {"1", "true", "yes", "on"}


def parse_csv(value: str | None) -> list[str]:
    if not value:
        return [
            "http://127.0.0.1:5500",
            "http://localhost:5500",
            "http://127.0.0.1:8000",
            "http://localhost:8000",
            "https://bjeon01.github.io",
        ]
    return [item.strip() for item in value.split(",") if item.strip()]


class Settings(BaseModel):
    app_name: str = Field(default="1365 Volunteer Explorer")
    database_url: str = Field(
        default="postgresql+psycopg://postgres@localhost:5432/volunteer_db"
    )
    sql_echo: bool = Field(default=False)
    cors_allow_origins: list[str] = Field(default_factory=list)


@lru_cache
def get_settings() -> Settings:
    return Settings(
        app_name=os.getenv("APP_NAME", "1365 Volunteer Explorer"),
        database_url=os.getenv(
            "DATABASE_URL",
            "postgresql+psycopg://postgres@localhost:5432/volunteer_db",
        ),
        sql_echo=os.getenv("SQL_ECHO", "false").lower() in TRUE_VALUES,
        cors_allow_origins=parse_csv(os.getenv("CORS_ALLOW_ORIGINS")),
    )

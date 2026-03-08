from __future__ import annotations

from pathlib import Path
import sys

from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.main import app


def main() -> None:
    client = TestClient(app)

    health = client.get("/health")
    assert health.status_code == 200, health.text
    assert health.json() == {"status": "ok"}

    cors = client.get("/health", headers={"Origin": "http://127.0.0.1:5500"})
    assert cors.status_code == 200, cors.text
    assert cors.headers.get("access-control-allow-origin") == "http://127.0.0.1:5500"

    listing = client.get("/api/posts")
    assert listing.status_code == 200, listing.text
    listing_json = listing.json()
    assert listing_json["total"] > 0
    assert listing_json["limit"] == 20
    assert listing_json["offset"] == 0
    assert len(listing_json["items"]) == 20
    assert all(item["recruit_count"] is not None for item in listing_json["items"])
    assert all(item["applied_count"] is not None for item in listing_json["items"])

    seoul = client.get("/api/posts", params={"province": "서울특별시", "limit": 5})
    assert seoul.status_code == 200, seoul.text
    seoul_json = seoul.json()
    assert seoul_json["total"] > 0
    assert len(seoul_json["items"]) <= 5
    assert all(item["province"] == "서울특별시" for item in seoul_json["items"])

    seoul_alias = client.get("/api/posts", params={"province": "서울", "limit": 5})
    assert seoul_alias.status_code == 200, seoul_alias.text
    seoul_alias_json = seoul_alias.json()
    assert seoul_alias_json["total"] == seoul_json["total"]

    gyeonggi = client.get("/api/posts", params={"province": "경기", "limit": 5})
    assert gyeonggi.status_code == 200, gyeonggi.text
    gyeonggi_json = gyeonggi.json()
    assert gyeonggi_json["total"] > 0

    province_combined = client.get("/api/posts", params={"province": "서울 경기", "limit": 5})
    assert province_combined.status_code == 200, province_combined.text
    province_combined_json = province_combined.json()
    assert province_combined_json["total"] == seoul_json["total"] + gyeonggi_json["total"]

    seoul_partial = client.get("/api/posts", params={"province": "서", "limit": 5})
    assert seoul_partial.status_code == 200, seoul_partial.text
    seoul_partial_json = seoul_partial.json()
    assert seoul_partial_json["total"] > 0
    assert all("서" in (item["province"] or "") for item in seoul_partial_json["items"])

    gangnam = client.get("/api/posts", params={"city_district": "강남구", "limit": 5})
    assert gangnam.status_code == 200, gangnam.text
    gangnam_json = gangnam.json()
    assert gangnam_json["total"] > 0
    assert all(item["city_district"] == "강남구" for item in gangnam_json["items"])

    gangnam_alias = client.get("/api/posts", params={"city_district": "강남", "limit": 5})
    assert gangnam_alias.status_code == 200, gangnam_alias.text
    gangnam_alias_json = gangnam_alias.json()
    assert gangnam_alias_json["total"] == gangnam_json["total"]

    mapo = client.get("/api/posts", params={"city_district": "마포", "limit": 5})
    assert mapo.status_code == 200, mapo.text
    mapo_json = mapo.json()
    assert mapo_json["total"] > 0

    district_combined = client.get("/api/posts", params={"city_district": "강남 마포", "limit": 5})
    assert district_combined.status_code == 200, district_combined.text
    district_combined_json = district_combined.json()
    assert district_combined_json["total"] == gangnam_json["total"] + mapo_json["total"]

    district_partial = client.get("/api/posts", params={"city_district": "강", "limit": 5})
    assert district_partial.status_code == 200, district_partial.text
    district_partial_json = district_partial.json()
    assert district_partial_json["total"] > 0
    assert all("강" in (item["city_district"] or "") for item in district_partial_json["items"])

    keyword = client.get("/api/posts", params={"keyword": "환경", "limit": 5})
    assert keyword.status_code == 200, keyword.text
    keyword_json = keyword.json()
    assert keyword_json["total"] > 0
    assert len(keyword_json["items"]) <= 5

    keyword_with_comma = client.get("/api/posts", params={"keyword": "환경, 교육", "limit": 5})
    assert keyword_with_comma.status_code == 200, keyword_with_comma.text
    keyword_with_comma_json = keyword_with_comma.json()
    assert keyword_with_comma_json["total"] > 0
    assert len(keyword_with_comma_json["items"]) <= 5

    recruiting = client.get("/api/posts", params={"status": "recruiting", "limit": 5})
    assert recruiting.status_code == 200, recruiting.text
    recruiting_json = recruiting.json()
    assert recruiting_json["total"] > 0
    assert all(item["status"] == "recruiting" for item in recruiting_json["items"])

    large_recruit = client.get("/api/posts", params={"min_recruit_count": 100, "limit": 5})
    assert large_recruit.status_code == 200, large_recruit.text
    large_recruit_json = large_recruit.json()
    assert large_recruit_json["total"] > 0
    assert all((item["recruit_count"] or 0) >= 100 for item in large_recruit_json["items"])

    first_post_id = listing_json["items"][0]["id"]
    detail = client.get(f"/api/posts/{first_post_id}")
    assert detail.status_code == 200, detail.text
    detail_json = detail.json()
    assert detail_json["id"] == first_post_id
    assert detail_json["title"]
    assert detail_json["source_url"]

    chat = client.post("/api/chat/recommend", json={"message": "서울에서 봉사 추천해줘"})
    assert chat.status_code == 200, chat.text
    chat_json = chat.json()
    assert chat_json["parsed_conditions"]["province"] == "서울특별시"
    assert len(chat_json["results"]) > 0
    assert len(chat_json["results"]) <= 5
    assert all(item["reason"] for item in chat_json["results"])

    missing = client.get("/api/posts/999999999")
    assert missing.status_code == 404, missing.text

    print("API smoke tests passed")
    print(
        {
            "total_posts": listing_json["total"],
            "sample_post_id": first_post_id,
            "seoul_total": seoul_json["total"],
            "seoul_alias_total": seoul_alias_json["total"],
            "gyeonggi_total": gyeonggi_json["total"],
            "province_combined_total": province_combined_json["total"],
            "seoul_partial_total": seoul_partial_json["total"],
            "gangnam_total": gangnam_json["total"],
            "gangnam_alias_total": gangnam_alias_json["total"],
            "mapo_total": mapo_json["total"],
            "district_combined_total": district_combined_json["total"],
            "district_partial_total": district_partial_json["total"],
            "keyword_total": keyword_json["total"],
            "keyword_with_comma_total": keyword_with_comma_json["total"],
            "recruiting_total": recruiting_json["total"],
            "large_recruit_total": large_recruit_json["total"],
            "chat_result_total": len(chat_json["results"]),
        }
    )


if __name__ == "__main__":
    main()

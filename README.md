# 1365 Volunteer Explorer

FastAPI + PostgreSQL 기반 1365 봉사 공고 탐색 프로젝트입니다.

현재 구조:
- `docs/`: GitHub Pages용 정적 프론트
- `backend/`: FastAPI, PostgreSQL 모델, Python 수집기
- `.github/workflows/fetch.yml`: GitHub Actions live sync

로컬 실행:
```powershell
cd backend
conda activate 1365-backend
uvicorn app.main:app --reload
```

GitHub Actions Secrets:
- `DATABASE_URL`
- `H1365_SERVICE_KEY`

수집 실행:
```powershell
cd backend
conda activate 1365-backend
python scripts/sync_1365.py
```

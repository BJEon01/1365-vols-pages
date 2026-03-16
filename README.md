# 🌱 1365-volunteer-matcher

🔗 **Live Demo**: https://bjeon01.github.io/1365-vols-pages/

서울 지역 1365 봉사 공고를 수집·가공해, 모집/신청 인원, 지역, 날짜, 키워드 기준으로 빠르게 검색할 수 있도록 만든 봉사 탐색 서비스입니다. 공고를 더 빠르게 이해하고 이어서 탐색할 수 있도록 로컬 LLM 기반 요약·태그 생성과 유사 공고 추천 기능도 함께 구현했습니다.

---

## 📌 Overview

연합 봉사 동아리에서 단체 봉사를 찾을 때, 1365 포털은 모집 인원 기준 검색이 되지 않고 신청 인원도 공고별로 직접 확인해야 해 탐색 비용이 컸습니다. 이 프로젝트는 이러한 불편을 줄이기 위해 서울 지역 1365 공고 데이터를 수집·가공하고, 실제 단체 봉사 탐색에 필요한 조건 중심으로 검색할 수 있는 서비스를 만드는 것을 목표로 했습니다.

---

## ✨ Key Features

- 서울 지역 1365 공고 데이터를 수집·가공해 검색용 데이터셋 구성
- 모집/신청 인원, 지역, 날짜, 키워드 기반 검색 및 정렬 기능 구현
- 목록 화면에서 핵심 정보를 표 형태로 비교할 수 있는 UI 구성
- Ollama 기반 **Gemma 4B**를 활용해 공고 `summary`, `tags` 생성
- 프롬프트 엔지니어링을 통해 모델이 자유 서술형 응답 대신, 공고의 핵심 정보는 `summary` 규칙에 맞게 요약하고 활동 성격은 `tags` 규칙에 맞게 분류하여 **일관된 JSON 포맷으로 생성**하도록 설계
- **LangChain** 기반 파이프라인으로 요약·태그 생성 및 유사 공고 추천 기능 구현
- **Hugging Face 임베딩 기반** 유사 공고 추천 기능 구현
- GitHub Actions 기반 배치 자동화로 공고 수집과 데이터 업데이트를 주기적으로 수행

---

## 🛠 What I Built

### 1. Searchable Volunteer Dataset
서울 지역 1365 공고 데이터를 수집하고, 검색과 정렬에 바로 활용할 수 있도록 정규화된 데이터셋으로 가공했습니다.

### 2. Search & Filtering
다음 조건을 기준으로 봉사 공고를 탐색할 수 있도록 구현했습니다.

- 모집 인원
- 신청 인원
- 지역
- 날짜
- 키워드

단체 참여 가능 여부를 빠르게 판단할 수 있도록, 실제 봉사 기획 과정에서 필요한 조건들을 중심으로 검색 기능을 설계했습니다.

### 3. Table-based Exploration UI
목록 화면에서 공고의 핵심 정보를 표 형태로 비교할 수 있도록 구성해, 여러 공고를 빠르게 훑고 후보를 추릴 수 있게 했습니다.

### 4. Local LLM-based Enrichment
Ollama로 Gemma 4B를 로컬에서 실행해 각 공고에 대해 `summary`, `tags`를 자동 생성했습니다. 프롬프트 엔지니어링을 통해 결과를 정해진 JSON 포맷으로 출력하도록 설계해, 후처리 없이 안정적으로 활용할 수 있도록 구성했습니다.

### 5. Similar Volunteer Recommendation
LangChain 파이프라인과 Hugging Face 임베딩을 활용해 유사 공고 추천 기능을 구현했습니다. 하나의 공고를 확인한 뒤, 비슷한 성격의 봉사 활동을 이어서 탐색할 수 있도록 설계했습니다.

### 6. Automated Data Pipeline
GitHub Actions를 활용해 공고 수집과 데이터 업데이트가 주기적으로 이루어지도록 배치 자동화를 구성했습니다. 정적 서비스 형태에서도 최신 공고 데이터를 지속적으로 반영할 수 있도록 했습니다.

---

## 🔄 User Flow

```text
1365 공고 수집
   ↓
검색 가능한 형태로 데이터 정리
   ↓
summary / tags 생성
   ↓
유사 공고 계산
   ↓
정적 JSON 생성
   ↓
GitHub Pages에서 검색 / 상세 조회 / 비교
```

---

## 🧰 Tech Stack

### Frontend
- HTML
- CSS
- Vanilla JavaScript

### Data / Automation
- Python
- GitHub Actions
- GitHub Pages

### AI / Recommendation
- Ollama
- Gemma 4B
- LangChain
- Hugging Face Embeddings
- FAISS

---

## 📂 Project Structure

```text
1365-vols-pages/
├─ docs/                   # GitHub Pages 정적 프론트
│  ├─ index.html
│  ├─ app.js
│  ├─ api.js
│  ├─ search.js
│  ├─ chat.js
│  └─ data/
├─ backend/                # 수집, 데이터 가공, 요약/태그 생성, 유사 공고 추천 로직
│  ├─ app/
│  ├─ scripts/
│  └─ data/
└─ .github/workflows/
   └─ fetch.yml
```

현재 사용자가 접하는 메인 서비스는 **정적 JSON 기반 검색 서비스**입니다.  
한편 `backend/`에는 공고 수집, 데이터 가공, 요약·태그 생성, 유사 공고 추천 등 현재 서비스 운영에 필요한 데이터 처리 로직이 포함되어 있습니다. DB, API 관련 구조도 일부 포함되어 있지만 현재 프로젝트에서는 보조적인 개발 구조로 두고 있습니다.

---

## 🖥 Main Screens

### 1. Search Page
- 서울 지역 봉사 공고를 조건별로 검색
- 모집 인원, 신청 인원, 지역, 날짜, 키워드 기반 필터링
- 여러 공고를 표 형태로 빠르게 비교 가능

### 2. Detail Page
- 공고의 핵심 정보 확인
- AI 요약 및 태그 제공
- 비슷한 봉사 공고 추천

> 필요하면 아래처럼 스크린샷을 추가해 사용할 수 있습니다.

```md
![search-page](./assets/search-page.png)
![detail-page](./assets/detail-page.png)
```

---

## ▶️ How to Run

### 1. Clone Repository

```bash
git clone https://github.com/BJEon01/1365-vols-pages.git
cd 1365-vols-pages
```

### 2. Run Static Frontend

```bash
cd docs
python -m http.server 5500
```

브라우저에서 로컬 서버 주소로 접속하면 정적 페이지를 확인할 수 있습니다.

---

## 🚀 Future Improvements

- 서울 외 지역까지 확장
- 사용자 맞춤형 추천 기능 추가
- 챗 기반 탐색 UI 고도화
- 즐겨찾기, 일정 관리 등 사용자 기능 확장
- 정적 서비스에서 실시간 서비스 구조로 확장

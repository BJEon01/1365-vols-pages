import { fetchJson, matchesStaticFilters } from "./api.js";

const SORT_OPTIONS = [
  { value: "recruit_end_date_asc", label: "모집 마감 빠른 순" },
  { value: "recruit_end_date_desc", label: "모집 마감 늦은 순" },
  { value: "volunteer_date_start_asc", label: "봉사 시작 빠른 순" },
  { value: "volunteer_date_start_desc", label: "봉사 시작 늦은 순" },
  { value: "collected_at_desc", label: "최근 수집 순" },
];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value) {
  return value || "-";
}

function formatDateRange(start, end) {
  if (!start && !end) {
    return "-";
  }
  if (start && end) {
    return `${start} ~ ${end}`;
  }
  return start || end || "-";
}

function formatTimeRange(start, end, fallback) {
  if (start && end) {
    return `${String(start).slice(0, 5)} ~ ${String(end).slice(0, 5)}`;
  }
  return fallback || "-";
}

function formatLocation(item) {
  return [item.province, item.city_district, item.place_text].filter(Boolean).join(" / ") || "-";
}

function formatRegion(item) {
  return [item.province, item.city_district].filter(Boolean).join(" / ") || "-";
}

function formatCompactSimilarMeta(item) {
  const metaParts = [
    formatRegion(item),
    formatDateRange(item.volunteer_date_start, item.volunteer_date_end),
    formatTimeRange(item.start_time, item.end_time, item.time_text),
    `모집 ${item.recruit_count ?? "-"} / 신청 ${item.applied_count ?? "-"}`,
  ];
  return metaParts.filter(Boolean).join(" · ");
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags
    .map((tag) => String(tag || "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function buildSummaryText(state) {
  if (state.loading) {
    return "공고를 불러오는 중입니다.";
  }
  if (state.error) {
    return state.error;
  }
  if (!state.total) {
    return "조건에 맞는 공고가 없습니다.";
  }
  const start = state.offset + 1;
  const end = Math.min(state.offset + state.items.length, state.total);
  return `${state.total}건 중 ${start}-${end}건을 표시합니다.`;
}

function tableRowHtml(item, index) {
  return `
    <tr>
      <td>${index}</td>
      <td class="table-title-cell">
        <button type="button" data-detail-id="${item.id}" class="table-title-button">${escapeHtml(item.title)}</button>
      </td>
      <td>${escapeHtml(formatDateRange(item.volunteer_date_start, item.volunteer_date_end))}</td>
      <td>${escapeHtml(formatTimeRange(item.start_time, item.end_time, item.time_text))}</td>
      <td>${escapeHtml(formatDate(item.recruit_end_date))}</td>
      <td>${escapeHtml(item.recruit_count ?? "-")}</td>
      <td>${escapeHtml(item.applied_count ?? "-")}</td>
      <td class="table-ellipsis-cell">${escapeHtml(formatLocation(item))}</td>
    </tr>
  `;
}

function detailHtml(item, similarItems = []) {
  const tags = normalizeTags(item.tags);
  const similarContent = similarItems.length
    ? `
      <div class="similar-list">
        ${similarItems
          .map(
            (similarItem) => `
              <button type="button" class="similar-item-button" data-similar-id="${escapeHtml(similarItem.id)}">
                <strong>${escapeHtml(similarItem.title)}</strong>
                <span>${escapeHtml(formatCompactSimilarMeta(similarItem))}</span>
              </button>
            `
          )
          .join("")}
      </div>
    `
    : `<p class="detail-placeholder">현재 검색조건에 맞는 비슷한 봉사가 없습니다.</p>`;

  return `
    <div class="detail-stack">
      <section class="detail-grid">
        <div class="meta-item detail-meta-card">
          <span class="meta-label">기관명</span>
          <span class="meta-value">${escapeHtml(item.organization_name || "-")}</span>
        </div>
        <div class="meta-item detail-meta-card">
          <span class="meta-label">지역/장소</span>
          <span class="meta-value">${escapeHtml(formatLocation(item))}</span>
        </div>
        <div class="meta-item detail-meta-card">
          <span class="meta-label">모집 기간</span>
          <span class="meta-value">${escapeHtml(formatDateRange(item.recruit_start_date, item.recruit_end_date))}</span>
        </div>
        <div class="meta-item detail-meta-card">
          <span class="meta-label">봉사 기간</span>
          <span class="meta-value">${escapeHtml(formatDateRange(item.volunteer_date_start, item.volunteer_date_end))}</span>
        </div>
        <div class="meta-item detail-meta-card">
          <span class="meta-label">시간</span>
          <span class="meta-value">${escapeHtml(formatTimeRange(item.start_time, item.end_time, item.time_text))}</span>
        </div>
        <div class="meta-item detail-meta-card">
          <span class="meta-label">모집 인원</span>
          <span class="meta-value">${escapeHtml(item.recruit_count ?? "-")}</span>
        </div>
      </section>
      <section class="detail-link-card">
        <div class="detail-link-copy">
          <span class="meta-label">원문 링크</span>
          <p class="detail-link-url">${escapeHtml(item.source_url)}</p>
        </div>
        <a class="detail-link-button" href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener">원문 열기</a>
      </section>
      <section class="detail-ai-panel" aria-label="AI recommendation section">
        <div class="detail-ai-panel__head">
          <h3 class="detail-ai-panel__title">AI 추천정보</h3>
          <p class="detail-ai-panel__description">공고 이해를 돕는 보조 정보입니다.</p>
        </div>
        <div class="detail-ai-panel__body">
          <section class="detail-section detail-section--compact">
            <h4 class="detail-section-title">요약</h4>
            <p class="detail-summary">${escapeHtml(item.summary || "AI 요약을 준비 중입니다.")}</p>
          </section>
          <section class="detail-section detail-section--compact">
            <h4 class="detail-section-title">태그</h4>
            ${
              tags.length
                ? `<div class="tag-list">${tags
                    .map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`)
                    .join("")}</div>`
                : `<p class="detail-placeholder">태그를 준비 중입니다.</p>`
            }
          </section>
          <section class="detail-section detail-section--compact">
            <h4 class="detail-section-title">비슷한 봉사 추천</h4>
            ${similarContent}
          </section>
        </div>
      </section>
    </div>
  `;
}

function showDialog(dialog) {
  if (typeof dialog.showModal === "function") {
    if (dialog.open) {
      return;
    }
    dialog.showModal();
    return;
  }
  dialog.setAttribute("open", "open");
}

export function createSearchTab({ root, detailDialog, detailTitle, detailBody }) {
  const state = {
    keyword: "",
    province: "",
    cityDistrict: "",
    minRecruitCount: "",
    dateFrom: "",
    dateTo: "",
    sort: "recruit_end_date_asc",
    limit: 20,
    offset: 0,
    total: 0,
    items: [],
    loading: false,
    error: "",
  };

  root.innerHTML = `
    <div class="stack">
      <section class="panel">
        <div class="panel-body">
          <form id="searchForm">
            <div class="filter-grid">
              <div class="field">
                <label for="provinceInput">시/도</label>
                <input id="provinceInput" name="province" type="text" placeholder="예: 서울, 경기, 부산" />
              </div>
              <div class="field">
                <label for="districtInput">시/군/구</label>
                <input id="districtInput" name="cityDistrict" type="text" placeholder="예: 강남, 수원, 해운대" />
              </div>
              <div class="field">
                <label for="keywordInput">키워드</label>
                <input id="keywordInput" name="keyword" type="text" placeholder="예: 환경, 교육, 멘토링" />
              </div>
              <div class="field">
                <label for="minRecruitCountInput">최소 모집인원</label>
                <input
                  id="minRecruitCountInput"
                  name="minRecruitCount"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="예: 10"
                />
              </div>
              <div class="field">
                <label for="dateFromInput">봉사 시작일 이후</label>
                <input id="dateFromInput" name="dateFrom" type="date" />
              </div>
              <div class="field">
                <label for="dateToInput">봉사 종료일 이전</label>
                <input id="dateToInput" name="dateTo" type="date" />
              </div>
              <div class="field">
                <label for="sortSelect">정렬</label>
                <select id="sortSelect" name="sort">
                  ${SORT_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join("")}
                </select>
              </div>
              <div class="field">
                <label for="limitSelect">페이지 크기</label>
                <select id="limitSelect" name="limit">
                  <option value="10">10건</option>
                  <option value="20" selected>20건</option>
                  <option value="50">50건</option>
                </select>
              </div>
            </div>
            <div class="filter-actions">
              <button type="button" id="resetSearchBtn" class="button-muted">초기화</button>
              <button type="submit" class="button-primary">검색</button>
            </div>
          </form>
        </div>
      </section>

      <section class="panel">
        <div class="panel-body stack">
          <div class="summary-row">
            <p id="searchSummary" class="summary-copy">봉사 공고를 불러오는 중입니다.</p>
            <p id="searchStatus" class="status-line"></p>
          </div>
          <div id="resultsContainer" class="results-grid"></div>
          <div id="paginationContainer" class="pagination"></div>
        </div>
      </section>
    </div>
  `;

  const form = root.querySelector("#searchForm");
  const summaryEl = root.querySelector("#searchSummary");
  const statusEl = root.querySelector("#searchStatus");
  const resultsContainer = root.querySelector("#resultsContainer");
  const paginationContainer = root.querySelector("#paginationContainer");
  const resetButton = root.querySelector("#resetSearchBtn");

  function readFormIntoState() {
    const formData = new FormData(form);
    state.keyword = String(formData.get("keyword") || "").trim();
    state.province = String(formData.get("province") || "").trim();
    state.cityDistrict = String(formData.get("cityDistrict") || "").trim();
    state.minRecruitCount = String(formData.get("minRecruitCount") || "").trim();
    state.sort = String(formData.get("sort") || "recruit_end_date_asc");
    state.dateFrom = String(formData.get("dateFrom") || "").trim();
    state.dateTo = String(formData.get("dateTo") || "").trim();
    state.limit = Number(formData.get("limit") || 20);
  }

  function writeStateToForm() {
    root.querySelector("#keywordInput").value = state.keyword;
    root.querySelector("#provinceInput").value = state.province;
    root.querySelector("#districtInput").value = state.cityDistrict;
    root.querySelector("#minRecruitCountInput").value = state.minRecruitCount;
    root.querySelector("#sortSelect").value = state.sort;
    root.querySelector("#dateFromInput").value = state.dateFrom;
    root.querySelector("#dateToInput").value = state.dateTo;
    root.querySelector("#limitSelect").value = String(state.limit);
  }

  function render() {
    summaryEl.textContent = buildSummaryText(state);
    statusEl.textContent = state.loading ? "검색 결과를 불러오는 중입니다." : "";
    statusEl.classList.toggle("is-error", Boolean(state.error));

    if (state.error) {
      resultsContainer.innerHTML = `<div class="error-state">${escapeHtml(state.error)}</div>`;
      paginationContainer.innerHTML = "";
      return;
    }

    if (state.loading && !state.items.length) {
      resultsContainer.innerHTML = `<div class="empty-state">공고를 불러오는 중입니다.</div>`;
      paginationContainer.innerHTML = "";
      return;
    }

    if (!state.items.length) {
      resultsContainer.innerHTML = `<div class="empty-state">조건에 맞는 공고가 없습니다.</div>`;
      paginationContainer.innerHTML = "";
      return;
    }

    resultsContainer.innerHTML = `
      <div class="table-scroll">
        <table class="results-table">
          <thead>
            <tr>
              <th style="width: 5%;">번호</th>
              <th style="width: 39%;">제목</th>
              <th style="width: 13%;">봉사기간</th>
              <th style="width: 9%;">봉사시간</th>
              <th style="width: 10%;">모집마감</th>
              <th style="width: 7%;">모집</th>
              <th style="width: 7%;">신청</th>
              <th style="width: 10%;">지역/장소</th>
            </tr>
          </thead>
          <tbody>
            ${state.items.map((item, index) => tableRowHtml(item, state.offset + index + 1)).join("")}
          </tbody>
        </table>
      </div>
    `;

    const currentPage = Math.floor(state.offset / state.limit) + 1;
    const totalPages = Math.max(1, Math.ceil(state.total / state.limit));
    paginationContainer.innerHTML = `
      <span class="pagination-meta">${currentPage} / ${totalPages} 페이지</span>
      <button type="button" id="prevPageBtn" ${(state.loading || state.offset === 0) ? "disabled" : ""}>이전</button>
      <button type="button" id="nextPageBtn" ${(state.loading || (state.offset + state.limit) >= state.total) ? "disabled" : ""}>다음</button>
    `;

    const prevButton = paginationContainer.querySelector("#prevPageBtn");
    const nextButton = paginationContainer.querySelector("#nextPageBtn");
    if (prevButton) {
      prevButton.addEventListener("click", async () => {
        state.offset = Math.max(0, state.offset - state.limit);
        await load();
      });
    }
    if (nextButton) {
      nextButton.addEventListener("click", async () => {
        state.offset += state.limit;
        await load();
      });
    }

    resultsContainer.querySelectorAll("[data-detail-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        await openDetail(Number(button.dataset.detailId));
      });
    });
  }

  async function load() {
    state.loading = true;
    state.error = "";
    render();
    try {
      const data = await fetchJson("/api/posts", {
        params: {
          keyword: state.keyword,
          province: state.province,
          city_district: state.cityDistrict,
          min_recruit_count: state.minRecruitCount,
          date_from: state.dateFrom,
          date_to: state.dateTo,
          sort: state.sort,
          limit: state.limit,
          offset: state.offset,
        },
      });
      state.total = Number(data.total || 0);
      state.items = Array.isArray(data.items) ? data.items : [];
    } catch (error) {
      state.error = `검색 데이터를 불러오지 못했습니다. ${error.message}`;
      state.total = 0;
      state.items = [];
    } finally {
      state.loading = false;
      render();
    }
  }

  function currentSearchParams() {
    return {
      keyword: state.keyword,
      province: state.province,
      city_district: state.cityDistrict,
      min_recruit_count: state.minRecruitCount,
      date_from: state.dateFrom,
      date_to: state.dateTo,
    };
  }

  async function openDetail(postId) {
    detailTitle.textContent = "공고 상세";
    detailBody.innerHTML = `<div class="empty-state">상세 정보를 불러오는 중입니다.</div>`;
    showDialog(detailDialog);
    try {
      const item = await fetchJson(`/api/posts/${postId}`);
      const similarIds = Array.isArray(item.similar_post_ids) ? item.similar_post_ids.slice(0, 20) : [];
      const rawSimilarItems = (
        await Promise.all(
          similarIds.map((similarId) =>
            fetchJson(`/api/posts/${similarId}`).catch(() => null)
          )
        )
      ).filter(Boolean);
      const similarItems = rawSimilarItems
        .filter((similarItem) => String(similarItem.id) !== String(item.id))
        .filter((similarItem) => matchesStaticFilters(similarItem, currentSearchParams()))
        .slice(0, 3);
      detailTitle.textContent = item.title || "공고 상세";
      detailBody.innerHTML = detailHtml(item, similarItems);
      detailBody.querySelectorAll("[data-similar-id]").forEach((button) => {
        button.addEventListener("click", async () => {
          await openDetail(button.dataset.similarId);
        });
      });
    } catch (error) {
      detailBody.innerHTML = `<div class="error-state">상세 조회에 실패했습니다. ${escapeHtml(error.message)}</div>`;
    }
  }

  async function reset() {
    state.keyword = "";
    state.province = "";
    state.cityDistrict = "";
    state.minRecruitCount = "";
    state.dateFrom = "";
    state.dateTo = "";
    state.sort = "recruit_end_date_asc";
    state.limit = 20;
    state.offset = 0;
    writeStateToForm();
    await load();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    readFormIntoState();
    state.offset = 0;
    await load();
  });

  resetButton.addEventListener("click", async () => {
    await reset();
  });

  writeStateToForm();

  return {
    async loadInitial() {
      await load();
    },
    async reload() {
      state.offset = 0;
      await load();
    },
  };
}

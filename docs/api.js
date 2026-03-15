const STORAGE_KEY = "volunteer_api_base_url";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8000";
const STATIC_DATA_PATH = "./data/volunteer_posts.json";

const PROVINCE_ALIASES = {
  "서울특별시": ["서울", "서울시", "서울특별시"],
  "부산광역시": ["부산", "부산시", "부산광역시"],
  "대구광역시": ["대구", "대구시", "대구광역시"],
  "인천광역시": ["인천", "인천시", "인천광역시"],
  "광주광역시": ["광주", "광주시", "광주광역시"],
  "대전광역시": ["대전", "대전시", "대전광역시"],
  "울산광역시": ["울산", "울산시", "울산광역시"],
  "세종특별자치시": ["세종", "세종시", "세종특별자치시"],
  경기도: ["경기", "경기도"],
  "강원특별자치도": ["강원", "강원도", "강원특별자치도"],
  충청북도: ["충북", "충청북도"],
  충청남도: ["충남", "충청남도"],
  "전북특별자치도": ["전북", "전라북도", "전북특별자치도"],
  전라남도: ["전남", "전라남도"],
  경상북도: ["경북", "경상북도"],
  경상남도: ["경남", "경상남도"],
  "제주특별자치도": ["제주", "제주도", "제주특별자치도"],
};

let staticDataPromise = null;

function getDataMode() {
  const mode = new URLSearchParams(window.location.search).get("dataMode");
  if (mode === "json") {
    return "json";
  }
  if (mode === "api") {
    return "api";
  }
  return window.location.hostname.endsWith("github.io") ? "json" : "api";
}

function splitTerms(value) {
  return String(value || "")
    .trim()
    .split(/[\s,]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function canonicalizeProvince(value) {
  const normalized = String(value || "").trim();
  for (const [canonical, aliases] of Object.entries(PROVINCE_ALIASES)) {
    if (aliases.includes(normalized)) {
      return canonical;
    }
  }
  return normalized;
}

function provincePatterns(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return [];
  }
  return [...new Set([normalized, canonicalizeProvince(normalized)])];
}

function cityDistrictCandidates(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return [];
  }
  if (/[구군시읍면]$/.test(normalized)) {
    return [normalized];
  }
  return [normalized, `${normalized}구`, `${normalized}군`, `${normalized}시`, `${normalized}읍`, `${normalized}면`];
}

function normalizeApiBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return DEFAULT_API_BASE_URL;
  }
  return raw.replace(/\/+$/, "");
}

export function getApiBaseUrl() {
  const queryBase = new URLSearchParams(window.location.search).get("apiBase");
  if (queryBase) {
    return normalizeApiBaseUrl(queryBase);
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored) {
    return normalizeApiBaseUrl(stored);
  }

  return DEFAULT_API_BASE_URL;
}

export function setApiBaseUrl(value) {
  const normalized = normalizeApiBaseUrl(value);
  window.localStorage.setItem(STORAGE_KEY, normalized);
  return normalized;
}

export function buildApiUrl(path, params) {
  const base = `${getApiBaseUrl()}/`;
  const url = new URL(path.replace(/^\//, ""), base);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value === null || value === undefined || value === "") {
        return;
      }
      url.searchParams.set(key, String(value));
    });
  }
  return url.toString();
}

function compareNullable(left, right, direction = "asc") {
  const leftEmpty = left === null || left === undefined || left === "";
  const rightEmpty = right === null || right === undefined || right === "";
  if (leftEmpty && rightEmpty) {
    return 0;
  }
  if (leftEmpty) {
    return 1;
  }
  if (rightEmpty) {
    return -1;
  }
  const leftValue = String(left);
  const rightValue = String(right);
  if (leftValue === rightValue) {
    return 0;
  }
  const order = leftValue < rightValue ? -1 : 1;
  return direction === "desc" ? order * -1 : order;
}

function matchesKeyword(item, keyword) {
  const terms = splitTerms(keyword);
  if (!terms.length) {
    return true;
  }
  const haystack = [
    item.title,
    item.organization_name,
    item.place_text,
    item.description,
    item.target_text,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term.toLowerCase()));
}

function matchesProvince(item, province) {
  const terms = splitTerms(province);
  if (!terms.length) {
    return true;
  }
  const provinceValue = String(item.province || "");
  return terms.some((term) => provincePatterns(term).some((pattern) => provinceValue.includes(pattern)));
}

function matchesCityDistrict(item, cityDistrict) {
  const terms = splitTerms(cityDistrict);
  if (!terms.length) {
    return true;
  }
  const districtValue = String(item.city_district || "");
  return terms.some((term) => cityDistrictCandidates(term).some((candidate) => districtValue.includes(candidate)));
}

function matchesDateFrom(item, dateFrom) {
  if (!dateFrom) {
    return true;
  }
  return !item.volunteer_date_end || item.volunteer_date_end >= dateFrom;
}

function matchesDateTo(item, dateTo) {
  if (!dateTo) {
    return true;
  }
  return !item.volunteer_date_start || item.volunteer_date_start <= dateTo;
}

export function matchesStaticFilters(item, params = {}) {
  if (item.recruit_count === null || item.recruit_count === undefined) {
    return false;
  }
  if (item.applied_count === null || item.applied_count === undefined) {
    return false;
  }
  if (!matchesKeyword(item, params.keyword)) {
    return false;
  }
  if (!matchesProvince(item, params.province)) {
    return false;
  }
  if (!matchesCityDistrict(item, params.city_district)) {
    return false;
  }
  if (params.min_recruit_count !== undefined && params.min_recruit_count !== null && params.min_recruit_count !== "") {
    if (Number(item.recruit_count || 0) < Number(params.min_recruit_count)) {
      return false;
    }
  }
  if (!matchesDateFrom(item, params.date_from)) {
    return false;
  }
  if (!matchesDateTo(item, params.date_to)) {
    return false;
  }
  return true;
}

function applyStaticFilters(items, params = {}) {
  return items.filter((item) => matchesStaticFilters(item, params));
}

function sortStaticItems(items, sort = "recruit_end_date_asc") {
  const sorted = [...items];
  sorted.sort((left, right) => {
    if (sort === "recruit_end_date_desc") {
      const compare = compareNullable(left.recruit_end_date, right.recruit_end_date, "desc");
      return compare || compareNullable(right.id ?? right.source_post_id, left.id ?? left.source_post_id, "asc");
    }
    if (sort === "volunteer_date_start_asc") {
      const compare = compareNullable(left.volunteer_date_start, right.volunteer_date_start, "asc");
      return compare || compareNullable(right.id ?? right.source_post_id, left.id ?? left.source_post_id, "asc");
    }
    if (sort === "volunteer_date_start_desc") {
      const compare = compareNullable(left.volunteer_date_start, right.volunteer_date_start, "desc");
      return compare || compareNullable(right.id ?? right.source_post_id, left.id ?? left.source_post_id, "asc");
    }
    if (sort === "collected_at_desc") {
      const compare = compareNullable(left.collected_at, right.collected_at, "desc");
      return compare || compareNullable(right.id ?? right.source_post_id, left.id ?? left.source_post_id, "asc");
    }
    const compare = compareNullable(left.recruit_end_date, right.recruit_end_date, "asc");
    return compare || compareNullable(right.id ?? right.source_post_id, left.id ?? left.source_post_id, "asc");
  });
  return sorted;
}

async function loadStaticData() {
  if (!staticDataPromise) {
    const staticUrl = new URL(STATIC_DATA_PATH, window.location.href);
    staticUrl.searchParams.set("v", String(Date.now()));
    staticDataPromise = fetch(staticUrl.toString(), { cache: "no-store" }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`정적 JSON을 불러오지 못했습니다. HTTP ${response.status}`);
      }
      return response.json();
    });
  }
  return staticDataPromise;
}

async function fetchStaticList(params = {}) {
  const payload = await loadStaticData();
  const items = Array.isArray(payload.items) ? payload.items : [];
  const filtered = sortStaticItems(applyStaticFilters(items, params), params.sort);
  const limit = Math.max(1, Number(params.limit || 20));
  const offset = Math.max(0, Number(params.offset || 0));
  return {
    total: filtered.length,
    limit,
    offset,
    items: filtered.slice(offset, offset + limit),
  };
}

async function fetchStaticDetail(postId) {
  const payload = await loadStaticData();
  const items = Array.isArray(payload.items) ? payload.items : [];
  const item = items.find(
    (candidate) => String(candidate.id ?? candidate.source_post_id) === String(postId)
  );
  if (!item) {
    throw new Error("Post not found");
  }
  return item;
}

async function fetchFromApi(path, options = {}) {
  const url = buildApiUrl(path, options.params);
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "detail" in payload
        ? payload.detail
        : `HTTP ${response.status}`;
    throw new Error(String(message));
  }

  return payload;
}

export async function fetchJson(path, options = {}) {
  if (getDataMode() === "json") {
    const normalizedPath = path.replace(/\/+$/, "");
    if (normalizedPath === "/health") {
      return { status: "ok" };
    }
    if ((options.method || "GET").toUpperCase() !== "GET") {
      throw new Error("정적 JSON 모드에서는 읽기 전용입니다.");
    }
    if (normalizedPath === "/api/posts") {
      return fetchStaticList(options.params);
    }
    if (normalizedPath.startsWith("/api/posts/")) {
      return fetchStaticDetail(normalizedPath.split("/").pop());
    }
    throw new Error("정적 JSON 모드에서 지원하지 않는 경로입니다.");
  }

  return fetchFromApi(path, options);
}

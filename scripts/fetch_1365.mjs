// Node 18+ / ESM
// 서울 25개 구 샤딩 수집 + 상세페이지 "모집/신청" 동시 추출
// 안정성 보강: IPv4 강제, br 비활성, 지수백오프 재시도, 직렬 리스트+페이지 지연, KST필터, 단계적 fallback

import fs from "fs";
import http from "http";
import https from "https";
import axios from "axios";
import dns from "node:dns";
import { parseStringPromise } from "xml2js";

// ====== ENV ======
const SERVICE_KEY = process.env.SERVICE_KEY?.trim();
if (!SERVICE_KEY) throw new Error("SERVICE_KEY missing");

// 동작 옵션
const USE_NOTICE_RANGE   = (process.env.USE_NOTICE_RANGE ?? "false") === "true";
const OFFSET_BG          = Number(process.env.OFFSET_BG ?? 0);
const OFFSET_ED          = Number(process.env.OFFSET_ED ?? 30);

const SIDO_NAME          = (process.env.SIDO_NAME || "").trim();
const SIDO_CODE          = (process.env.SIDO_CODE || "").trim();         // 6110000 (서울)
const GUGUN_CODE         = (process.env.GUGUN_CODE || "").trim();
const PROGRM_STTUS_SE    = (process.env.PROGRM_STTUS_SE || "").trim();   // 2=모집중
let   RECRUITING_ONLY    = (process.env.RECRUITING_ONLY ?? "true") === "true"; // KST 기준 필터

const PER                = Number(process.env.PER || 100);
const MAX_PAGES          = Number(process.env.MAX_PAGES || 50);
const KEYWORD            = (process.env.KEYWORD || "").trim();

const SHARD_GUGUN        = (process.env.SHARD_GUGUN ?? "true") === "true";
const DESIRED_MIN        = Number(process.env.DESIRED_MIN || 5000);

// 동시성/지연/타임아웃
const DETAIL_CONCURRENCY = Number(process.env.DETAIL_CONCURRENCY || 16);
const DETAIL_DELAY_MS    = Number(process.env.DETAIL_DELAY_MS || 0);
const MAX_DETAIL         = Number(process.env.MAX_DETAIL || 999999);

const LIST_CONCURRENCY   = Number(process.env.LIST_CONCURRENCY || 1);      // ⬅ 기본 직렬
const LIST_PAGE_DELAY_MS = Number(process.env.LIST_PAGE_DELAY_MS || 350);  // ⬅ 페이지 간 지연
const AXIOS_TIMEOUT_MS   = Number(process.env.AXIOS_TIMEOUT_MS || 45000);

// 지역 필터 강도
let   STRICT_REGION_FILTER = (process.env.STRICT_REGION_FILTER ?? "true") === "true";

// ====== CONSTS ======
const BASE = "http://openapi.1365.go.kr/openapi/service/rest/VolunteerPartcptnService";
const EP   = `${BASE}/getVltrSearchWordList`;

// === 날짜 유틸 (KST) ===
function ymdKST(date = new Date()) {
  try {
    const f = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
    return f.format(date).replace(/-/g, "");
  } catch {
    // fallback: UTC+9 보정
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    return d.toISOString().slice(0, 10).replace(/-/g, "");
  }
}
function addDaysKST(days) {
  // KST 기준 yyyymmdd를 날짜로 취급해 days 가감 후 다시 KST yyyymmdd
  const t = ymdKST();
  const y = Number(t.slice(0,4)), m = Number(t.slice(4,6)), d = Number(t.slice(6,8));
  // KST 자정 시각을 만들기 어렵기 때문에 UTC 기준으로 하루를 밀도 있게 가감
  const base = Date.UTC(y, m - 1, d, 15); // 15:00 UTC = 00:00+09:00 KST 근처
  const dt = new Date(base + days * 24 * 3600 * 1000);
  return ymdKST(dt);
}
const TODAY_YMD  = ymdKST();
const NOTICE_BG  = USE_NOTICE_RANGE ? addDaysKST(OFFSET_BG) : "";
const NOTICE_ED  = USE_NOTICE_RANGE ? addDaysKST(OFFSET_ED) : "";

// ====== HTTP keep-alive + IPv4 강제 + br 제외 ======
const lookupV4 = (hostname, opts, cb) =>
  dns.lookup(hostname, { family: 4, all: false }, cb);

const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 32, lookup: lookupV4 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, lookup: lookupV4 });

const AX = axios.create({
  httpAgent,
  httpsAgent,
  proxy: false,
  timeout: AXIOS_TIMEOUT_MS,
  headers: {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ko,en;q=0.8",
    "User-Agent": "Mozilla/5.0",
    "Accept-Encoding": "gzip, deflate", // br 제외
  },
  transitional: { clarifyTimeoutError: true },
  validateStatus: (s) => s >= 200 && s < 500,
});

// ====== 재시도(지수백오프+지터) ======
async function withRetry(doReq, name = "request", retries = 5) {
  let attempt = 0;
  while (true) {
    try {
      return await doReq();
    } catch (e) {
      const status = e.response?.status;
      const code = e.code;
      const retriable =
        ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(code) ||
        status === 429 ||
        (status >= 500 && status <= 599);
      if (!retriable || attempt >= retries) throw e;

      attempt++;
      const base = 500 * 2 ** (attempt - 1);
      const delay = Math.min(5000, base) * (0.7 + Math.random() * 0.6);
      console.warn(`[retry ${attempt}/${retries}] ${name}: ${code || status} → wait ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ====== 지역/리스트 유틸 ======
const SIDO_TEXT_HINT = { "6110000": ["서울", "서울특별시"] };
const SEOUL_GUGUN = [
  "강남구","강동구","강북구","강서구","관악구","광진구","구로구","금천구",
  "노원구","도봉구","동대문구","동작구","마포구","서대문구","서초구","성동구",
  "성북구","송파구","양천구","영등포구","용산구","은평구","종로구","중구","중랑구"
];

const toArray = x => (x ? (Array.isArray(x) ? x : [x]) : []);
const isYmd   = v => typeof v === "string" && /^\d{8}$/.test(v);
const between = (v, a, b) => (isYmd(v) ? (!a || v >= a) && (!b || v <= b) : false);
const includesAny = (s, arr) => arr.some(w => w && String(s).includes(w));

function uniqBy(arr, key){
  const seen = new Set(); const out = [];
  for (const it of arr) {
    const k = key(it);
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}

// ====== 간단 동시성 리미터 ======
function createPLimit(n){
  let active = 0, q = [];
  const next = () => { if (q.length && active < n) { active++; q.shift()(); } };
  return fn => new Promise((res, rej) => {
    const run = () => fn().then(res, rej).finally(()=>{ active--; next(); });
    q.push(run); next();
  });
}
const detailLimit = createPLimit(DETAIL_CONCURRENCY);
const listLimit   = createPLimit(LIST_CONCURRENCY);

// ====== 숫자 추출 / 상세 파서 ======
const pickNumber = (txt) => {
  const m = String(txt).match(/([0-9][0-9,]*)\s*명/i);
  return m ? m[1].replace(/,/g,"") : "";
};
function extractCountByLabels(html, labels) {
  const s = String(html);
  for (const label of labels) {
    let m = s.match(new RegExp(`<dt[^>]*>\\s*(?:${label})\\s*<\\/dt>[\\s\\S]{0,200}?(<dd[^>]*>[\\s\\S]*?<\\/dd>)`, "i"));
    if (m) { const n = pickNumber(m[1].replace(/<[^>]+>/g, " ")); if (n) return n; }
    m = s.match(new RegExp(`<th[^>]*>\\s*(?:${label})[\\s\\S]{0,120}?<td[^>]*>([\\s\\S]{0,100}?)<\\/td>`, "i"));
    if (m) { const n = pickNumber(m[1].replace(/<[^>]+>/g, " ")); if (n) return n; }
    m = s.match(new RegExp(`(?:${label})[\\s\\S]{0,300}?([0-9][0-9,]*)\\s*명`, "i"));
    if (m) return (m[1] || "").replace(/,/g,"");
  }
  return "";
}
function extractCounts(html) {
  const recruit = extractCountByLabels(html, ["모집\\s*인원","총\\s*모집\\s*인원"]);
  let applied   = extractCountByLabels(html, ["신청\\s*인원","신청\\s*현황","신청\\s*자(?:\\s*수)?","현재\\s*신청"]);
  if (!applied) {
    const s = String(html).replace(/<[^>]+>/g, " ");
    const m = s.match(/신청[^0-9]{0,10}?([0-9][0-9,]*)\s*명\s*\/\s*([0-9][0-9,]*)\s*명/);
    if (m) applied = m[1].replace(/,/g,"");
  }
  return { recruit, applied };
}
const DETAIL_URL = pid =>
  `https://www.1365.go.kr/vols/P9210/partcptn/timeCptn.do?type=show&progrmRegistNo=${encodeURIComponent(pid)}`;

async function fetchDetailCounts(pid) {
  const { data, status } = await withRetry(
    () => AX.get(DETAIL_URL(pid), { responseType: "text" }),
    `detail:${pid}`
  );
  if (status >= 400) return { recruit: "", applied: "" };
  return extractCounts(data);
}

// ====== 본문 파서 ======
async function parseBody(data, headers){
  const ct = String(headers["content-type"] || "").toLowerCase();
  const s  = typeof data === "string" ? data.trim() : "";

  if (ct.includes("application/json") || s.startsWith("{")) {
    const j = typeof data === "string" ? JSON.parse(s) : data;
    const header = j?.response?.header;
    if (header && header.resultCode && header.resultCode !== "00") {
      throw new Error(`API error ${header.resultCode}: ${header.resultMsg}`);
    }
    const body = j?.response?.body;
    if (!body) throw new Error(`Unexpected JSON: ${s.slice(0,200)}`);
    return body;
  }
  if (s.startsWith("<")) {
    const j = await parseStringPromise(s, { explicitArray: false });
    const header = j?.response?.header;
    if (header && header.resultCode && header.resultCode !== "00") {
      throw new Error(`API error ${header.resultCode}: ${header.resultMsg}`);
    }
    const body = j?.response?.body;
    if (!body) throw new Error(`Unexpected XML: ${s.slice(0,200)}`);
    return body;
  }
  throw new Error(`Unknown response: ${s.slice(0,200)}`);
}

// ====== 캐시 ======
const CACHE_PATH = "docs/data/recruit_cache.json";
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8")); } catch { cache = {}; }

function readCache(pid) {
  const c = cache[pid];
  if (!c) return { recruit: "", applied: "", appliedFetchedAt: null };
  if (typeof c === "string") return { recruit: c, applied: "", appliedFetchedAt: null };
  return {
    recruit: c.recruit ?? c.value ?? "",
    applied: c.applied ?? c.aplyNmpr ?? "",
    appliedFetchedAt: c.appliedFetchedAt ?? c.fetchedAt ?? null,
  };
}
function writeCache(pid, { recruit, applied, touchedApplied=false }) {
  const prev = cache[pid] || {};
  const now = new Date().toISOString();
  const next = {
    ...prev,
    recruit: recruit ?? prev.recruit ?? "",
    applied: applied ?? prev.applied ?? "",
    fetchedAt: now,
  };
  if (touchedApplied) next.appliedFetchedAt = now;
  cache[pid] = next;
}

// ====== 리스트 호출 ======
async function fetchListPage({ page, extraKeyword }) {
  const qs = new URLSearchParams({ numOfRows: String(PER), pageNo: String(page), _type: "json" });
  if (USE_NOTICE_RANGE) { qs.set("noticeBgnde", NOTICE_BG); qs.set("noticeEndde", NOTICE_ED); }
  const kwAll = [KEYWORD, extraKeyword].filter(Boolean).join(" ").trim();
  if (kwAll) qs.set("keyword", kwAll);
  if (SIDO_CODE) qs.set("sidoCd", SIDO_CODE);
  if (GUGUN_CODE) qs.set("gugunCd", GUGUN_CODE);
  if (PROGRM_STTUS_SE) qs.set("progrmSttusSe", PROGRM_STTUS_SE);

  const url = `${EP}?serviceKey=${SERVICE_KEY}&${qs.toString()}`;
  const { data, headers, status } = await withRetry(
    () => AX.get(url, { transformResponse: [d=>d] }),
    `list:${kwAll || "base"}:p${page}`
  );
  if (status >= 400) throw new Error(`HTTP ${status}. Body: ${String(data).slice(0,200)}`);
  const body  = await parseBody(data, headers);
  const items = toArray(body?.items?.item);
  const total = Number(body?.totalCount || 0);
  return { items, total };
}

async function fetchListOnce({ pageStart=1, pageStop=MAX_PAGES, extraKeyword="" } = {}, opts = {}) {
  const out = [];
  for (let page = pageStart; page <= pageStop; page++) {
    const { items, total } = await fetchListPage({ page, extraKeyword });
    console.log(`page=${page} total=${total} pageItems=${items.length} kw="${extraKeyword}"`);

    if (!items.length) {
      // 페이지 1에서 0 item이면 서버의 일시적 zero-bug 가능 → 살짝 대기 후 1회 재시도
      if (page === 1) {
        await new Promise(r => setTimeout(r, 500));
        const retry = await fetchListPage({ page, extraKeyword });
        if (retry.items.length === 0) break;
        else { items.splice(0, items.length, ...retry.items); }
      } else {
        break;
      }
    }

    for (const it of items) {
      // KST 기준 오늘 포함 모집기간만
      if (RECRUITING_ONLY) {
        const nb = it.noticeBgnde ?? "", ne = it.noticeEndde ?? "";
        if (!(isYmd(nb) && isYmd(ne) && between(TODAY_YMD, nb, ne))) continue;
      }

      // 지역 강제 필터 (API가 무시하는 경우 대비)
      if (SIDO_CODE === "6110000" && STRICT_REGION_FILTER) {
        const pool = `${it.actPlace||""} ${it.mnnstNm||""} ${it.nanmmbyNm||""}`;
        const hints = SIDO_NAME ? [SIDO_NAME] : (SIDO_TEXT_HINT["6110000"] || []);
        const apiSido = (it.sidoCd ?? "").toString();
        if (apiSido !== "6110000" && !includesAny(pool, hints)) continue;
      }

      out.push({
        progrmRegistNo: it.progrmRegistNo ?? "",
        progrmSj:       it.progrmSj ?? "",
        progrmBgnde:    it.progrmBgnde ?? "",
        progrmEndde:    it.progrmEndde ?? "",
        noticeBgnde:    it.noticeBgnde ?? "",
        noticeEndde:    it.noticeEndde ?? "",
        rcritNmpr:      (it.rcritNmpr ?? "").toString().trim(),
        aplyNmpr:       "", // 상세에서 갱신
        mnnstNm:        it.mnnstNm ?? "",
        nanmmbyNm:      it.nanmmbyNm ?? "",
        actPlace:       it.actPlace ?? "",
        actBeginTm:     (it.actBeginTm ?? "").toString().trim(),
        actEndTm:       (it.actEndTm ?? "").toString().trim(),
        actBeginMnt:    (it.actBeginMnt ?? "").toString().trim(),
        actEndMnt:      (it.actEndMnt ?? "").toString().trim(),
        sidoCd:         (it.sidoCd ?? "").toString().trim(),
      });
    }

    if (LIST_PAGE_DELAY_MS) await new Promise(r => setTimeout(r, LIST_PAGE_DELAY_MS));
    if (out.length >= DESIRED_MIN) break;
  }
  return out;
}

// 안전 래퍼
async function safeFetchListOnce(args, tag) {
  try { return await fetchListOnce(args); }
  catch (e) { console.warn(`[warn] list fetch skipped(${tag}): ${e.code || e.message}`); return []; }
}

// ====== 메인 ======
(async () => {
  console.log("▶ params", {
    USE_NOTICE_RANGE, NOTICE_BG, NOTICE_ED,
    SIDO_CODE, GUGUN_CODE, PROGRM_STTUS_SE,
    RECRUITING_ONLY, KEYWORD, PER, MAX_PAGES,
    SHARD_GUGUN, DESIRED_MIN,
    LIST_CONCURRENCY, LIST_PAGE_DELAY_MS,
    DETAIL_CONCURRENCY, AXIOS_TIMEOUT_MS,
    STRICT_REGION_FILTER
  });

  let collected = [];

  // 1) 기본: 서울 25개 구 직렬/저동시성 샤딩
  if (SHARD_GUGUN && SIDO_CODE === "6110000") {
    const tasks = SEOUL_GUGUN.map((gu) =>
      listLimit(async () => {
        const part = await safeFetchListOnce({ extraKeyword: gu }, gu);
        console.log(`  └ ${gu} 수집=${part.length}`);
        return part;
      })
    );
    const results = await Promise.all(tasks);
    collected = uniqBy(results.flat(), it => it.progrmRegistNo);
  } else {
    collected = await safeFetchListOnce({}, "base");
  }

  // 2) Fallback 단계적 완화
  if (collected.length === 0) {
    console.warn("[fallback] STRICT_REGION_FILTER → false");
    STRICT_REGION_FILTER = false;
    if (SHARD_GUGUN && SIDO_CODE === "6110000") {
      let tmp = [];
      for (const gu of SEOUL_GUGUN) {
        const part = await safeFetchListOnce({ extraKeyword: gu }, `relaxed-${gu}`);
        tmp = tmp.concat(part);
      }
      collected = uniqBy(tmp, it => it.progrmRegistNo);
    } else {
      collected = await safeFetchListOnce({}, "relaxed-base");
    }
  }

  if (collected.length === 0 && RECRUITING_ONLY) {
    console.warn("[fallback] RECRUITING_ONLY → false");
    RECRUITING_ONLY = false;
    if (SHARD_GUGUN && SIDO_CODE === "6110000") {
      let tmp = [];
      for (const gu of SEOUL_GUGUN) {
        const part = await safeFetchListOnce({ extraKeyword: gu }, `noRecruit-${gu}`);
        tmp = tmp.concat(part);
      }
      collected = uniqBy(tmp, it => it.progrmRegistNo);
    } else {
      collected = await safeFetchListOnce({}, "noRecruit-base");
    }
  }

  if (collected.length === 0 && SHARD_GUGUN && SIDO_CODE === "6110000") {
    console.warn("[fallback] keyword 없이 SIDO 전체 재수집");
    collected = await safeFetchListOnce({ extraKeyword: "" }, "sido-only");
  }

  // ====== 상세 보강 ======
  let filledApiRecruit = 0;
  let filledDetailRecruit = 0;
  let filledDetailApplied = 0;
  let stillEmptyRecruit = 0;
  let stillEmptyApplied = 0;
  let triedDetail = 0;

  for (const it of collected) {
    const c = readCache(it.progrmRegistNo);
    if (!it.rcritNmpr && c.recruit) it.rcritNmpr = c.recruit;
    if (it.rcritNmpr) filledApiRecruit++;
  }

  const needDetail = collected.slice(0, MAX_DETAIL);
  await Promise.all(needDetail.map(it => detailLimit(async () => {
    if (DETAIL_DELAY_MS) await new Promise(r=>setTimeout(r, DETAIL_DELAY_MS));
    triedDetail++;
    const { recruit, applied } = await fetchDetailCounts(it.progrmRegistNo);
    if (recruit && !it.rcritNmpr) { it.rcritNmpr = recruit; filledDetailRecruit++; }
    if (applied) { it.aplyNmpr = applied; filledDetailApplied++; }
    if (!it.rcritNmpr) stillEmptyRecruit++;
    if (!it.aplyNmpr)  stillEmptyApplied++;
    writeCache(it.progrmRegistNo, {
      recruit: it.rcritNmpr || recruit || undefined,
      applied: it.aplyNmpr || applied || undefined,
      touchedApplied: !!(it.aplyNmpr || applied)
    });
  })));

  // 정렬
  const sortKey = v => {
    if (v == null) return "99999999";
    const s = String(v).replace(/\D/g, "");
    return s && s.length >= 8 ? s.slice(0,8) : "99999999";
  };
  collected.sort((a,b) => sortKey(a.noticeEndde).localeCompare(sortKey(b.noticeEndde)));

  // 저장
  fs.mkdirSync("docs/data", { recursive: true });
  fs.writeFileSync("docs/data/1365.json", JSON.stringify({
    updatedAt: new Date().toISOString(),
    params: {
      USE_NOTICE_RANGE, NOTICE_BG, NOTICE_ED,
      OFFSET_BG, OFFSET_ED,
      SIDO_NAME, SIDO_CODE, GUGUN_CODE,
      PROGRM_STTUS_SE, RECRUITING_ONLY,
      PER, MAX_PAGES, KEYWORD,
      SHARD_GUGUN, DESIRED_MIN,
      LIST_CONCURRENCY, LIST_PAGE_DELAY_MS,
      DETAIL_CONCURRENCY, DETAIL_DELAY_MS, MAX_DETAIL,
      AXIOS_TIMEOUT_MS, STRICT_REGION_FILTER,
      refreshApplied: "always"
    },
    stat: {
      total: collected.length,
      triedDetail,
      recruit: { fromApiOrCache: filledApiRecruit, fromDetail: filledDetailRecruit, stillEmpty: stillEmptyRecruit },
      applied: { fromDetail: filledDetailApplied, stillEmpty: stillEmptyApplied }
    },
    count: collected.length,
    items: collected
  }, null, 2), "utf-8");

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");

  console.log(`✅ Saved docs/data/1365.json with ${collected.length} items`);
  console.log(`   ▶ 모집인원 채움: API/CACHE=${filledApiRecruit}, 상세=${filledDetailRecruit}, 미확인=${stillEmptyRecruit}`);
  console.log(`   ▶ 신청인원 채움(항상 상세): 상세=${filledDetailApplied}, 미확인=${stillEmptyApplied}`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});

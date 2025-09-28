// Node 18+ / ESM
// 서울 25개 구 샤딩 수집 + 상세페이지 "모집/신청" 동시 추출
// 안정성 보강 + "0건시 즉시 폴백" 다단 전략 + 디버그 덤프

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

const LIST_CONCURRENCY   = Number(process.env.LIST_CONCURRENCY || 1);      // 기본 직렬
const LIST_PAGE_DELAY_MS = Number(process.env.LIST_PAGE_DELAY_MS || 350);  // 페이지 간 지연
const AXIOS_TIMEOUT_MS   = Number(process.env.AXIOS_TIMEOUT_MS || 45000);

// 지역 필터 강도 (초기 true 이지만 0건이면 자동 완화)
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
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    return d.toISOString().slice(0, 10).replace(/-/g, "");
  }
}
function addDaysKST(baseYmd, days) {
  const y = Number(baseYmd.slice(0,4)), m = Number(baseYmd.slice(4,6)), d = Number(baseYmd.slice(6,8));
  const dt = new Date(Date.UTC(y, m - 1, d, 15) + days * 86400000); // 15:00 UTC ≈ 00:00 KST
  return ymdKST(dt);
}
const TODAY_YMD = ymdKST();
const NOTICE_BG = USE_NOTICE_RANGE ? addDaysKST(TODAY_YMD, OFFSET_BG) : "";
const NOTICE_ED = USE_NOTICE_RANGE ? addDaysKST(TODAY_YMD, OFFSET_ED) : "";

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
  // 서버가 XML 기본이 가장 안정적 → Accept를 XML로 강제
  headers: {
    Accept: "application/xml,text/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
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
      const delay = Math.min(6000, base) * (0.7 + Math.random() * 0.6);
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

// ====== 디버그 덤프 ======
function debugDump(name, payload) {
  try {
    fs.mkdirSync("docs/debug", { recursive: true });
    const p = `docs/debug/${name}`;
    fs.writeFileSync(p, typeof payload === "string" ? payload : String(payload), "utf-8");
    console.warn(`[debug] dumped → ${p}`);
  } catch {}
}

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

// ====== 본문 파서(XML/JSON) ======
async function parseBody(data, headers){
  const ct = String(headers["content-type"] || "").toLowerCase();
  const s  = typeof data === "string" ? data.trim() : "";

  // JSON
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

  // XML
  if (s.startsWith("<") || ct.includes("xml")) {
    const j = await parseStringPromise(s, { explicitArray: false });
    const header = j?.response?.header;
    if (header && header.resultCode && header.resultCode !== "00") {
      throw new Error(`API error ${header.resultCode}: ${header.resultMsg}`);
    }
    const body = j?.response?.body;
    if (!body) throw new Error(`Unexpected XML: ${s.slice(0,200)}`);
    return body;
  }

  // 알 수 없는 응답 → 덤프
  debugDump("unknown_body.txt", s);
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

// ====== 한 페이지 호출 ======
async function fetchListPage({ page, paramsForLog, queryParams }) {
  const qs = new URLSearchParams({ numOfRows: String(PER), pageNo: String(page), _type: "json" });
  // 서비스키는 대소문자 민감한 API도 있어 대문자 사용
  const urlBase = `${EP}?ServiceKey=${SERVICE_KEY}`;

  // 동적 파라미터
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }

  const url = `${urlBase}&${qs.toString()}`;

  const { data, headers, status } = await withRetry(
    () => AX.get(url, { transformResponse: [d=>d] }),
    `list:${paramsForLog}:p${page}`
  );

  if (status >= 400) {
    debugDump(`list_${paramsForLog}_p${page}.txt`, typeof data === "string" ? data : JSON.stringify(data));
    throw new Error(`HTTP ${status}. Body: ${String(data).slice(0,200)}`);
  }

  const body  = await parseBody(data, headers);
  const items = toArray(body?.items?.item);
  const total = Number(body?.totalCount || 0);

  return { items, total, raw: typeof data === "string" ? data : JSON.stringify(data) };
}

// ====== 전략별 한 샤드 수집 (다단 폴백) ======
/**
 * strategies 배열의 각 항목은 queryParams를 리턴하는 함수
 *  - A: sido + status + keyword
 *  - B: sido + status
 *  - C: sido only
 *  - D: keyword only
 *  - E: no filter
 */
function buildStrategies(guKeyword) {
  const strategies = [];

  // A
  strategies.push(() => ({
    name: `A_sido+status+kw(${guKeyword || "-"})`,
    params: {
      keyword: [KEYWORD, guKeyword].filter(Boolean).join(" ").trim(),
      sidoCd: SIDO_CODE,
      progrmSttusSe: PROGRM_STTUS_SE,
      ...(USE_NOTICE_RANGE ? { noticeBgnde: NOTICE_BG, noticeEndde: NOTICE_ED } : {})
    }
  }));

  // B
  strategies.push(() => ({
    name: "B_sido+status",
    params: {
      sidoCd: SIDO_CODE,
      progrmSttusSe: PROGRM_STTUS_SE,
      ...(USE_NOTICE_RANGE ? { noticeBgnde: NOTICE_BG, noticeEndde: NOTICE_ED } : {})
    }
  }));

  // C
  strategies.push(() => ({
    name: "C_sido_only",
    params: {
      sidoCd: SIDO_CODE,
      ...(USE_NOTICE_RANGE ? { noticeBgnde: NOTICE_BG, noticeEndde: NOTICE_ED } : {})
    }
  }));

  // D
  strategies.push(() => ({
    name: `D_kw_only(${guKeyword || "-"})`,
    params: {
      keyword: [KEYWORD, guKeyword].filter(Boolean).join(" ").trim(),
      ...(USE_NOTICE_RANGE ? { noticeBgnde: NOTICE_BG, noticeEndde: NOTICE_ED } : {})
    }
  }));

  // E
  strategies.push(() => ({
    name: "E_no_filter",
    params: {
      ...(USE_NOTICE_RANGE ? { noticeBgnde: NOTICE_BG, noticeEndde: NOTICE_ED } : {})
    }
  }));

  return strategies;
}

async function collectWithStrategies(guKeyword = "") {
  const strategies = buildStrategies(guKeyword);
  let out = [];

  for (const make of strategies) {
    const { name, params } = make();

    // 페이지 루프
    out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { items, total, raw } = await fetchListPage({
        page,
        paramsForLog: name,
        queryParams: params
      });

      if (page === 1 && items.length === 0) {
        // 1페이지 0건이면 원문 덤프(분석용)
        debugDump(`page1_zero_${name}.xml`, raw);
      }

      // 로컬 필터링
      for (const it of items) {
        // KST 기준 오늘 포함 모집기간만
        if (RECRUITING_ONLY) {
          const nb = it.noticeBgnde ?? "", ne = it.noticeEndde ?? "";
          if (!(isYmd(nb) && isYmd(ne) && between(TODAY_YMD, nb, ne))) continue;
        }
        // 서울 강제 필터 (과도시 완화)
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
          aplyNmpr:       "",
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

      console.log(`[${name}] page=${page} total=${total} pageItems=${items.length} kept=${out.length}`);

      if (LIST_PAGE_DELAY_MS) await new Promise(r => setTimeout(r, LIST_PAGE_DELAY_MS));

      if (items.length === 0 || out.length >= DESIRED_MIN) break;
    }

    if (out.length > 0) {
      console.log(`[${name}] → collected ${out.length} items`);
      return out;
    } else {
      console.warn(`[${name}] 0 items → try next strategy`);
    }
  }

  return out; // 전부 실패 시 []
}

// ====== 상세 ======
async function enrichDetails(collected) {
  let filledApiRecruit = 0;
  let filledDetailRecruit = 0;
  let filledDetailApplied = 0;
  let stillEmptyRecruit = 0;
  let stillEmptyApplied = 0;
  let triedDetail = 0;

  // 캐시에서 모집인원만 선적용
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

  return {
    filledApiRecruit, filledDetailRecruit, filledDetailApplied,
    stillEmptyRecruit, stillEmptyApplied, triedDetail
  };
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

  // 1) 서울 25개 구: 각 구에 대해 다단 폴백을 적용
  if (SHARD_GUGUN && SIDO_CODE === "6110000") {
    const shards = SEOUL_GUGUN.map(gu => listLimit(async () => {
      const part = await collectWithStrategies(gu);
      console.log(`  └ ${gu} 수집=${part.length}`);
      return part;
    }));
    const results = await Promise.all(shards);
    collected = uniqBy(results.flat(), it => it.progrmRegistNo);

    // 구 샤딩 전체가 0이면 필터 완화 후 재시도(한 번만)
    if (collected.length === 0) {
      console.warn("[fallback] STRICT_REGION_FILTER → false, RECRUITING_ONLY → false 로 완화 후 재시도");
      STRICT_REGION_FILTER = false;
      RECRUITING_ONLY = false;
      const shards2 = SEOUL_GUGUN.map(gu => listLimit(async () => collectWithStrategies(gu)));
      const results2 = await Promise.all(shards2);
      collected = uniqBy(results2.flat(), it => it.progrmRegistNo);
    }

    // 그래도 적으면 SIDO Only 한 번 더
    if (collected.length === 0) {
      console.warn("[fallback] keyword 없이 SIDO 전체 재수집");
      collected = await collectWithStrategies("");
    }
  } else {
    // 샤딩 비활성화
    collected = await collectWithStrategies(KEYWORD);
    if (collected.length === 0) {
      console.warn("[fallback] STRICT_REGION_FILTER → false, RECRUITING_ONLY → false 로 완화 후 재시도");
      STRICT_REGION_FILTER = false;
      RECRUITING_ONLY = false;
      collected = await collectWithStrategies(KEYWORD);
    }
  }

  // ====== 상세 보강 ======
  const stat2 = await enrichDetails(collected);

  // 정렬
  const sortKey = v => {
    if (v == null) return "99999999";
    const s = String(v).replace(/\D/g, "");
    return s && s.length >= 8 ? s.slice(0,8) : "99999999";
  };
  collected.sort((a,b) => sortKey(a.noticeEndde).localeCompare(sortKey(b.noticeEndde)));

  // 저장
  fs.mkdirSync("docs/data", { recursive: true });
  const outJson = {
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
      triedDetail: stat2.triedDetail,
      recruit: { fromApiOrCache: stat2.filledApiRecruit, fromDetail: stat2.filledDetailRecruit, stillEmpty: stat2.stillEmptyRecruit },
      applied: { fromDetail: stat2.filledDetailApplied, stillEmpty: stat2.stillEmptyApplied }
    },
    count: collected.length,
    items: collected
  };
  fs.writeFileSync("docs/data/1365.json", JSON.stringify(outJson, null, 2), "utf-8");

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");

  console.log(`✅ Saved docs/data/1365.json with ${collected.length} items`);
  console.log(`   ▶ 모집인원 채움: API/CACHE=${stat2.filledApiRecruit}, 상세=${stat2.filledDetailRecruit}, 미확인=${stat2.stillEmptyRecruit}`);
  console.log(`   ▶ 신청인원 채움(항상 상세): 상세=${stat2.filledDetailApplied}, 미확인=${stat2.stillEmptyApplied}`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});

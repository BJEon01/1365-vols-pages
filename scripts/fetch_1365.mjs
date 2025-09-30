// Node 18+ / ESM
// 서울 25개 구로 샤딩해 처음부터 서울 결과를 많이 모으는 버전
// + 상세페이지에서 "모집인원"과 "신청인원"을 함께 추출 (신청인원은 매번 갱신)

import fs from "fs";
import http from "http";
import https from "https";
import axios from "axios";
import { parseStringPromise } from "xml2js";

// ====== ENV ======
const SERVICE_KEY = process.env.SERVICE_KEY?.trim();
if (!SERVICE_KEY) throw new Error("SERVICE_KEY missing");

// 기본 동작 옵션
const USE_NOTICE_RANGE = (process.env.USE_NOTICE_RANGE ?? "false") === "true";
const OFFSET_BG   = Number(process.env.OFFSET_BG ?? 0);
const OFFSET_ED   = Number(process.env.OFFSET_ED ?? 30);

const SIDO_NAME   = (process.env.SIDO_NAME || "").trim();    // 선택 텍스트 보정
const SIDO_CODE   = (process.env.SIDO_CODE || "").trim();    // 6110000 (서울)
const GUGUN_CODE  = (process.env.GUGUN_CODE || "").trim();   // 미사용(샤딩은 이름 위주)
const PROGRM_STTUS_SE = (process.env.PROGRM_STTUS_SE || "").trim(); // 2=모집중
const RECRUITING_ONLY = (process.env.RECRUITING_ONLY ?? "true") === "true"; // 오늘 포함 모집기간 로컬필터

const PER        = Number(process.env.PER || 100);
const MAX_PAGES  = Number(process.env.MAX_PAGES || 50); // 페이지 상한
const KEYWORD    = (process.env.KEYWORD || "").trim();

// 서울 구 단위 샤딩
const SHARD_GUGUN = (process.env.SHARD_GUGUN ?? "true") === "true";
const DESIRED_MIN = Number(process.env.DESIRED_MIN || 5000); // 서울 결과를 이정도 모으면 조기종료

// 상세 병렬
const DETAIL_CONCURRENCY = Number(process.env.DETAIL_CONCURRENCY || 16);
const DETAIL_DELAY_MS    = Number(process.env.DETAIL_DELAY_MS || 0);
const MAX_DETAIL         = Number(process.env.MAX_DETAIL || 999999);

// === 타임아웃 & 속도 제어 ENV ===
const AXIOS_TIMEOUT_MS   = Number(process.env.AXIOS_TIMEOUT_MS || 20000); // 20s (짧게 끊고 재시도)
const LIST_PAGE_DELAY_MS = Number(process.env.LIST_PAGE_DELAY_MS || 350); // 페이지 간 딜레이(ms)
const SHARD_DELAY_MS     = Number(process.env.SHARD_DELAY_MS || 300);     // 서울 구 샤드 간 딜레이(ms)

// ====== CONSTS ======
const BASE = "https://openapi.1365.go.kr/openapi/service/rest/VolunteerPartcptnService"; // https로 변경
const EP   = `${BASE}/getVltrSearchWordList`;

const today = new Date();
const ymd = d => d.toISOString().slice(0,10).replace(/-/g,"");
const addDays = (dt, n) => { const t = new Date(dt); t.setDate(t.getDate()+n); return t; };

const NOTICE_BG = ymd(addDays(today, OFFSET_BG));
const NOTICE_ED = ymd(addDays(today, OFFSET_ED));

// ====== HTTP keep-alive ======
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 128 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128 });
const AX = axios.create({
  httpAgent, httpsAgent,
  headers: { "Accept-Language":"ko,en;q=0.8", "User-Agent":"Mozilla/5.0" },
  timeout: AXIOS_TIMEOUT_MS, // 20s
  validateStatus: s => s >= 200 && s < 500
});

// ====== 지역 힌트 ======
const SIDO_TEXT_HINT = {
  "6110000": ["서울", "서울특별시"],
};

const SEOUL_GUGUN = [
  "강남구","강동구","강북구","강서구","관악구","광진구","구로구","금천구",
  "노원구","도봉구","동대문구","동작구","마포구","서대문구","서초구","성동구",
  "성북구","송파구","양천구","영등포구","용산구","은평구","종로구","중구","중랑구"
];

// ====== 유틸 ======
const toArray = x => (x ? (Array.isArray(x) ? x : [x]) : []);
const isYmd = v => typeof v === "string" && /^\d{8}$/.test(v);
const between = (v, a, b) => (isYmd(v) ? (!a || v >= a) && (!b || v <= b) : false);
const includesAny = (s, arr) => arr.some(w => w && String(s).includes(w));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function uniqBy(arr, key){
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = key(it);
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}

// --- 재시도 + 지수 백오프 ---
async function withRetry(fn, {retries=5, base=700, factor=1.8}={}) {
  let last;
  for (let i=0; i<retries; i++) {
    try { return await fn(); }
    catch (e) {
      const retriable =
        e.code === "ECONNABORTED" || e.code === "ETIMEDOUT" ||
        e.code === "ECONNRESET"   || e.code === "EAI_AGAIN" ||
        (e.response && (e.response.status >= 500 || e.response.status === 429));
      if (!retriable || i === retries-1) { last = e; break; }
      const backoff = Math.round(base * Math.pow(factor, i)) + Math.floor(Math.random()*250);
      await sleep(backoff);
      last = e;
    }
  }
  throw last;
}

// 숫자만 추출
const pickNumber = (txt) => {
  const m = String(txt).match(/([0-9][0-9,]*)\s*명/i);
  return m ? m[1].replace(/,/g,"") : "";
};

// 라벨 기반 숫자 추출기 (dt/dd, th/td, 근처 스캔)
function extractCountByLabels(html, labels) {
  const s = String(html);

  for (const label of labels) {
    // 1) <dt>라벨</dt> 다음 <dd>
    let m = s.match(new RegExp(`<dt[^>]*>\\s*(?:${label})\\s*<\\/dt>[\\s\\S]{0,200}?(<dd[^>]*>[\\s\\S]*?<\\/dd>)`, "i"));
    if (m) {
      const txt = m[1].replace(/<[^>]+>/g, " ");
      const n = pickNumber(txt);
      if (n) return n;
    }

    // 2) <th>라벨</th> 인접 <td>
    m = s.match(new RegExp(`<th[^>]*>\\s*(?:${label})[\\s\\S]{0,120}?<td[^>]*>([\\s\\S]{0,100}?)<\\/td>`, "i"));
    if (m) {
      const txt = m[1].replace(/<[^>]+>/g, " ");
      const n = pickNumber(txt);
      if (n) return n;
    }

    // 3) 라벨 근처 윈도우 스캔 (앞쪽 첫 번째 "XX명")
    m = s.match(new RegExp(`(?:${label})[\\s\\S]{0,300}?([0-9][0-9,]*)\\s*명`, "i"));
    if (m) {
      const n = (m[1] || "").replace(/,/g,"");
      if (n) return n;
    }
  }
  return "";
}

// 상세 페이지에서 모집/신청 동시 추출
function extractCounts(html) {
  const recruit = extractCountByLabels(html, [
    "모집\\s*인원",
    "총\\s*모집\\s*인원"
  ]);

  // 신청인원 / 신청자 / 신청현황(보통 "0명 / 10명" 형태면 앞 숫자를 잡음)
  let applied = extractCountByLabels(html, [
    "신청\\s*인원",
    "신청\\s*현황",
    "신청\\s*자(?:\\s*수)?",
    "현재\\s*신청"
  ]);

  // 혹시 "신청 3명 / 모집 10명" 같이 붙어 있을 때 보정
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
  const res = await withRetry(() => AX.get(DETAIL_URL(pid), { responseType: "text" }));
  const { data, status } = res;
  if (status >= 400) return { recruit: "", applied: "" };
  return extractCounts(data);
}

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

// 간단 동시성 리미터
function pLimit(n){
  let active = 0, q = [];
  const next = () => { if (q.length && active < n) { active++; q.shift()(); } };
  return fn => new Promise((res, rej) => {
    const run = () => fn().then(res, rej).finally(()=>{ active--; next(); });
    q.push(run); next();
  });
}
const limit = pLimit(DETAIL_CONCURRENCY);

// ====== 캐시 ======
const CACHE_PATH = "docs/data/recruit_cache.json";
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8")); } catch { cache = {}; }

// 구 캐시 호환 + 읽기/쓰기 헬퍼
function readCache(pid) {
  const c = cache[pid];
  if (!c) return { recruit: "", applied: "", appliedFetchedAt: null };
  if (typeof c === "string") return { recruit: c, applied: "", appliedFetchedAt: null }; // 최구버전 호환
  return {
    recruit: c.recruit ?? c.value ?? "",
    applied: c.applied ?? c.aplyNmpr ?? "",
    appliedFetchedAt: c.appliedFetchedAt ?? c.fetchedAt ?? null, // 구버전 호환
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

// ====== 한 번의 리스트 호출 (키워드 추가 인자 지원) ======
async function fetchListOnce({ pageStart=1, pageStop=MAX_PAGES, extraKeyword="" } = {}){
  const out = [];
  for (let page = pageStart; page <= pageStop; page++){
    const per = Math.min(Number(PER || 100), 50); // 서버 부담 완화 (최대 50)
    const qs = new URLSearchParams({
      numOfRows: String(per),
      pageNo: String(page),
      _type: "json"
    });

    if (USE_NOTICE_RANGE) {
      qs.set("noticeBgnde", NOTICE_BG);
      qs.set("noticeEndde", NOTICE_ED);
    }
    const kwAll = [KEYWORD, extraKeyword].filter(Boolean).join(" ").trim();
    if (kwAll) qs.set("keyword", kwAll);
    if (SIDO_CODE) {
      qs.set("sidoCd", SIDO_CODE);   // 호환
      qs.set("schSido", SIDO_CODE);  // 문서상 서버 필터
    }
    if (GUGUN_CODE) {
      qs.set("gugunCd", GUGUN_CODE);
      qs.set("schSign1", GUGUN_CODE); // 문서상 서버 필터
    }
    if (PROGRM_STTUS_SE) qs.set("progrmSttusSe", PROGRM_STTUS_SE);

    const url = `${EP}?serviceKey=${SERVICE_KEY}&${qs.toString()}`;
    const { data, headers, status } = await withRetry(
      () => AX.get(url, { transformResponse: [d=>d] })
    );
    if (status >= 400) throw new Error(`HTTP ${status}. Body: ${String(data).slice(0,200)}`);

    const body  = await parseBody(data, headers);
    const items = toArray(body?.items?.item);
    const total = Number(body?.totalCount || 0);

    console.log(`page=${page} total=${total} pageItems=${items.length} kw="${extraKeyword}"`);

    if (!items.length) break;

    for (const it of items) {
      // (선택) 오늘 포함 모집기간만
      if (RECRUITING_ONLY) {
        const nb = it.noticeBgnde ?? "", ne = it.noticeEndde ?? "";
        if (!(isYmd(nb) && isYmd(ne) && between(ymd(today), nb, ne))) continue;
      }

      // 지역 강제 필터 (API가 무시해도 안전장치)
      if (SIDO_CODE === "6110000") {
        const pool = `${it.actPlace||""} ${it.mnnstNm||""} ${it.nanmmbyNm||""}`;
        const hints = SIDO_NAME ? [SIDO_NAME] : (SIDO_TEXT_HINT["6110000"] || []);
        const apiSido = (it.sidoCd ?? "").toString();
        if (apiSido !== "6110000" && !includesAny(pool, hints)) {
          continue;
        }
      }

      out.push({
        progrmRegistNo: it.progrmRegistNo ?? "",
        progrmSj:       it.progrmSj ?? "",
        progrmBgnde:    it.progrmBgnde ?? "",
        progrmEndde:    it.progrmEndde ?? "",
        noticeBgnde:    it.noticeBgnde ?? "",
        noticeEndde:    it.noticeEndde ?? "",
        rcritNmpr:      (it.rcritNmpr ?? "").toString().trim(),
        // 신청인원은 항상 상세에서 최신으로 덮어쓸 것
        aplyNmpr:       "",
        mnnstNm:        it.mnnstNm ?? "",
        nanmmbyNm:      it.nanmmbyNm ?? "",
        actPlace:       it.actPlace ?? "",
        actBeginTm:     (it.actBeginTm ?? "").toString().trim(),
        actEndTm:       (it.actEndTm ?? "").toString().trim(),
        actBeginMnt:    (it.actBeginMnt ?? "").toString().trim(),
        actEndMnt:      (it.actEndMnt ?? "").toString().trim(),
      });
    }

    // 조기 종료: 충분히 모였으면 페이지 루프 중단(샤드 안)
    if (out.length >= DESIRED_MIN) break;

    // 페이지 간 딜레이
    if (LIST_PAGE_DELAY_MS) await sleep(LIST_PAGE_DELAY_MS);
  }
  return out;
}

// ====== 메인 수집 ======
(async () => {
  console.log("▶ params", {
    USE_NOTICE_RANGE, NOTICE_BG, NOTICE_ED,
    SIDO_CODE, GUGUN_CODE, PROGRM_STTUS_SE,
    RECRUITING_ONLY, KEYWORD, PER, MAX_PAGES,
    SHARD_GUGUN, DESIRED_MIN
  });

  let collected = [];

  if (SHARD_GUGUN && SIDO_CODE === "6110000") {
    // 서울 25개 구로 샤딩해서 수집
    for (const gu of SEOUL_GUGUN) {
      const part = await fetchListOnce({ extraKeyword: gu });
      collected = collected.concat(part);
      // 전체 dedup
      collected = uniqBy(collected, it => it.progrmRegistNo);
      console.log(`  └ ${gu} 누적=${collected.length}`);

      if (collected.length >= DESIRED_MIN) break; // 충분히 모이면 샤딩 루프도 중단

      // 샤드 간 딜레이
      if (SHARD_DELAY_MS) await sleep(SHARD_DELAY_MS);
    }
    // 보너스: 샤딩 후에도 부족하면 기본(키워드 없음)으로 한 번 더
    if (collected.length < DESIRED_MIN) {
      const part = await fetchListOnce({ extraKeyword: "" });
      collected = uniqBy(collected.concat(part), it => it.progrmRegistNo);
    }
  } else {
    // 샤딩 비활성화: 단일 쿼리만
    collected = await fetchListOnce();
  }

  // ====== 상세 보강 ======
  // 캐시 반영: 모집인원만(비었을 때) 캐시로 메우기. 신청인원은 항상 상세로 덮어쓸 예정이라 캐시 미사용.
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
    // aplyNmpr는 캐시 선적용하지 않음(항상 상세로 갱신)
  }

  // 항상 상세조회해서 신청인원 갱신 (MAX_DETAIL 한도 내)
  const needDetail = collected.slice(0, MAX_DETAIL);

  await Promise.all(needDetail.map(it => limit(async () => {
    if (DETAIL_DELAY_MS) await sleep(DETAIL_DELAY_MS);
    triedDetail++;
    const { recruit, applied } = await fetchDetailCounts(it.progrmRegistNo);

    // 모집인원: API가 비어있을 때만 상세로 보강
    if (recruit && !it.rcritNmpr) { it.rcritNmpr = recruit; filledDetailRecruit++; }

    // 신청인원: 항상 상세 결과로 갱신(값 있으면 덮어씀)
    if (applied) { it.aplyNmpr = applied; filledDetailApplied++; }

    if (!it.rcritNmpr) stillEmptyRecruit++;
    if (!it.aplyNmpr)  stillEmptyApplied++;

    // 캐시 갱신 (신청인원은 매번 최신으로 덮어쓴 값 저장)
    writeCache(it.progrmRegistNo, {
      recruit: it.rcritNmpr || recruit || undefined,
      applied: it.aplyNmpr || applied || undefined,
      touchedApplied: !!(it.aplyNmpr || applied)
    });
  })));

  // 정렬: 모집기간 종료일 오름차순
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
      DETAIL_CONCURRENCY, DETAIL_DELAY_MS, MAX_DETAIL,
      refreshApplied: "always",
      AXIOS_TIMEOUT_MS, LIST_PAGE_DELAY_MS, SHARD_DELAY_MS
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
  // 에러 타입별 로그 보강
  if (e.code === "ECONNABORTED") {
    console.error(`[TIMEOUT] exceeded ${AXIOS_TIMEOUT_MS}ms`);
  } else if (e.response) {
    console.error(`[HTTP ${e.response.status}] ${e.response.config?.url}`);
  } else {
    console.error(`[NETWORK] ${e.code || e.message}`);
  }
  console.error(e);
  process.exit(1);
});

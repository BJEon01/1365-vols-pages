// Node 18+ / ESM
// 서울 25개 구로 샤딩해 처음부터 서울 결과를 많이 모으는 버전

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

// ====== CONSTS ======
const BASE = "http://openapi.1365.go.kr/openapi/service/rest/VolunteerPartcptnService";
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
  timeout: 15000,
  validateStatus: s => s >= 200 && s < 500
});

// ====== 지역 힌트 ======
const SIDO_TEXT_HINT = {
  "6110000": ["서울", "서울특별시"],
  // 필요한 시도 추가시 여기에...
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

function uniqBy(arr, key){
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = key(it);
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}

// 상세 HTML에서 '모집인원' 추출(빠른 정규식)
function extractRecruit(html) {
  const s = String(html);
  let pos = s.indexOf(">모집인원<");
  if (pos === -1) pos = s.search(/<dt[^>]*>\s*모집\s*인원\s*<\/dt>/i);
  if (pos !== -1) {
    const ddOpen = s.indexOf("<dd", pos);
    if (ddOpen !== -1) {
      const contOpen = s.indexOf(">", ddOpen) + 1;
      const ddClose = s.indexOf("</dd>", contOpen);
      if (contOpen > 0 && ddClose > contOpen) {
        const text = s.slice(contOpen, ddClose).replace(/<[^>]+>/g, " ");
        const m = text.match(/([0-9][0-9,]*)\s*명/i);
        if (m) return m[1].replace(/,/g, "");
      }
    }
  }
  let m = s.match(/<th[^>]*>\s*모집\s*인원[\s\S]{0,100}?<td[^>]*>([\s\S]{0,80}?)<\/td>/i);
  if (m) {
    const n = m[1].replace(/<[^>]+>/g, " ").match(/([0-9][0-9,]*)\s*명/i);
    if (n) return n[1].replace(/,/g, "");
  }
  const i = s.search(/모집\s*인원/i);
  if (i >= 0) {
    const w = s.slice(i, i + 500).replace(/<[^>]+>/g, " ");
    const n = w.match(/([0-9][0-9,]*)\s*명/i);
    if (n) return n[1].replace(/,/g, "");
  }
  return "";
}

const DETAIL_URL = pid =>
  `https://www.1365.go.kr/vols/P9210/partcptn/timeCptn.do?type=show&progrmRegistNo=${encodeURIComponent(pid)}`;

async function fetchRecruitFromDetail(pid) {
  const { data, status } = await AX.get(DETAIL_URL(pid), { responseType: "text" });
  if (status >= 400) return "";
  return extractRecruit(data);
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

// ====== 한 번의 리스트 호출 (키워드 추가 인자 지원) ======
async function fetchListOnce({ pageStart=1, pageStop=MAX_PAGES, extraKeyword="" } = {}){
  const out = [];
  for (let page = pageStart; page <= pageStop; page++){
    const qs = new URLSearchParams({
      numOfRows: String(PER),
      pageNo: String(page),
      _type: "json"
    });

    if (USE_NOTICE_RANGE) {
      qs.set("noticeBgnde", NOTICE_BG);
      qs.set("noticeEndde", NOTICE_ED);
    }
    const kwAll = [KEYWORD, extraKeyword].filter(Boolean).join(" ").trim();
    if (kwAll) qs.set("keyword", kwAll);
    if (SIDO_CODE) qs.set("sidoCd", SIDO_CODE);
    if (GUGUN_CODE) qs.set("gugunCd", GUGUN_CODE);
    if (PROGRM_STTUS_SE) qs.set("progrmSttusSe", PROGRM_STTUS_SE);

    const url = `${EP}?serviceKey=${SERVICE_KEY}&${qs.toString()}`;
    const { data, headers, status } = await AX.get(url, { transformResponse: [d=>d] });
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

  // ====== 상세 보강(모집인원) ======
  const needs = collected.filter(it => !it.rcritNmpr).slice(0, MAX_DETAIL);
  let filledApi = collected.length - needs.length;
  let filledDetail = 0, stillEmpty = 0, triedDetail = 0;

  const limiter = pLimit(DETAIL_CONCURRENCY);
  await Promise.all(needs.map(it => limiter(async () => {
    const c = cache[it.progrmRegistNo];
    if (c && c.value) { it.rcritNmpr = c.value; return; }

    if (DETAIL_DELAY_MS) await new Promise(r=>setTimeout(r, DETAIL_DELAY_MS));
    triedDetail++;
    const v = await fetchRecruitFromDetail(it.progrmRegistNo);
    if (v) { it.rcritNmpr = v; filledDetail++; }
    else { stillEmpty++; }
    cache[it.progrmRegistNo] = { value: it.rcritNmpr || "", fetchedAt: new Date().toISOString() };
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
      DETAIL_CONCURRENCY, DETAIL_DELAY_MS, MAX_DETAIL
    },
    stat: { filledApi, filledDetail, stillEmpty, total: collected.length, triedDetail },
    count: collected.length,
    items: collected
  }, null, 2), "utf-8");

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");

  console.log(`✅ Saved docs/data/1365.json with ${collected.length} items`);
  console.log(`   ▶ 모집인원 채움: API=${filledApi}, 상세=${filledDetail}, 미확인=${stillEmpty}, 상세시도=${triedDetail}`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});

// Node 18+ / ESM (.mjs)
// 목록 API + (필요시) 상세페이지를 긁어 "모집인원" 보강
// 빠른 최초 수집을 위해 DOM 파서 없이 정규식/슬라이싱만 사용

import fs from "fs";
import http from "http";
import https from "https";
import axios from "axios";
import { parseStringPromise } from "xml2js";

// ====== ENV ======
const SERVICE_KEY = process.env.SERVICE_KEY?.trim();
if (!SERVICE_KEY) throw new Error("SERVICE_KEY missing");

const OFFSET_BG   = Number(process.env.OFFSET_BG ?? 0);   // 오늘 + offset
const OFFSET_ED   = Number(process.env.OFFSET_ED ?? 30);

const SIDO_NAME   = (process.env.SIDO_NAME || "").trim();   // 서울 같은 텍스트 보정(선택)
const SIDO_CODE   = (process.env.SIDO_CODE || "").trim();   // 6110000 (서울)
const GUGUN_CODE  = (process.env.GUGUN_CODE || "").trim();  // 시군구 코드 (미지정 = 전체)

const PROGRM_STTUS_SE = (process.env.PROGRM_STTUS_SE || "").trim(); // 2=모집중
const RECRUITING_ONLY = (process.env.RECRUITING_ONLY ?? "true") === "true"; // true면 '오늘이 모집기간'인 것만 로컬 필터

const PER        = Number(process.env.PER || 100);
const MAX_PAGES  = Number(process.env.MAX_PAGES || 50); // 100*50=5000
const KEYWORD    = (process.env.KEYWORD || "").trim();

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

// ====== HTTP: Keep-Alive ======
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 128 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128 });
const AX = axios.create({
  httpAgent, httpsAgent,
  headers: { "Accept-Language":"ko,en;q=0.8", "User-Agent":"Mozilla/5.0" },
  timeout: 15000,
  validateStatus: s => s >= 200 && s < 500
});

// ====== 유틸 ======
const toArray = x => (x ? (Array.isArray(x) ? x : [x]) : []);
const isYmd = v => typeof v === "string" && /^\d{8}$/.test(v);
const between = (v, a, b) => (isYmd(v) ? (!a || v >= a) && (!b || v <= b) : false);

// 상세 HTML에서 '모집인원' 빠르게 추출
function extractRecruit(html) {
  const s = String(html);

  // 1) '<dt>모집인원</dt>' 기준 바로 다음 <dd> 텍스트
  let pos = s.indexOf(">모집인원<");
  if (pos === -1) pos = s.search(/<dt[^>]*>\s*모집\s*인원\s*<\/dt>/i);
  if (pos !== -1) {
    const ddOpen = s.indexOf("<dd", pos);
    if (ddOpen !== -1) {
      const contOpen = s.indexOf(">", ddOpen) + 1;
      const ddClose = s.indexOf("</dd>", contOpen);
      if (contOpen > 0 && ddClose > contOpen) {
        const text = s.slice(contOpen, ddClose).replace(/<[^>]+>/g, " ");
        const m = text.match(/([0-9][0-9,]*)\s*명/i); // '80 명 / 일' 등 커버
        if (m) return m[1].replace(/,/g, "");
      }
    }
  }

  // 2) th/td 형태 대비
  let m = s.match(/<th[^>]*>\s*모집\s*인원[\s\S]{0,100}?<td[^>]*>([\s\S]{0,80}?)<\/td>/i);
  if (m) {
    const n = m[1].replace(/<[^>]+>/g, " ").match(/([0-9][0-9,]*)\s*명/i);
    if (n) return n[1].replace(/,/g, "");
  }

  // 3) 라벨 근처 500자 스캔 (보루)
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

  // JSON 응답
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
  // XML 응답
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

// ====== 수집 ======
console.log("▶ params", { NOTICE_BG, NOTICE_ED, SIDO_CODE, GUGUN_CODE, PROGRM_STTUS_SE, RECRUITING_ONLY, KEYWORD, PER, MAX_PAGES });

let page = 1;
const all = [];
let filledApi = 0, filledDetail = 0, stillEmpty = 0, triedDetail = 0;

while (true) {
  const qs = new URLSearchParams({
    numOfRows: String(PER),
    pageNo: String(page),
    noticeBgnde: NOTICE_BG,
    noticeEndde: NOTICE_ED,
    _type: "json"
  });
  if (KEYWORD) qs.set("keyword", KEYWORD);
  if (SIDO_CODE) qs.set("sidoCd", SIDO_CODE);
  if (GUGUN_CODE) qs.set("gugunCd", GUGUN_CODE);
  if (PROGRM_STTUS_SE) qs.set("progrmSttusSe", PROGRM_STTUS_SE);

  const url = `${EP}?serviceKey=${SERVICE_KEY}&${qs.toString()}`;
  const { data, headers, status } = await AX.get(url, { transformResponse: [d=>d] });
  if (status >= 400) throw new Error(`HTTP ${status}. Body: ${String(data).slice(0,200)}`);

  const body  = await parseBody(data, headers);
  const items = toArray(body?.items?.item);
  const total = Number(body?.totalCount || 0);

  console.log(`page=${page} total=${total} pageItems=${items.length}`);

  for (const it of items) {
    // (선택) 서울 텍스트 보정
    if (SIDO_NAME) {
      const text = `${it.actPlace||""} ${it.mnnstNm||""} ${it.nanmmbyNm||""}`;
      if (!text.includes(SIDO_NAME)) continue;
    }
    // (로컬 보정) 모집기간에 오늘 포함
    if (RECRUITING_ONLY) {
      const nb = it.noticeBgnde ?? "", ne = it.noticeEndde ?? "";
      if (!(isYmd(nb) && isYmd(ne) && between(ymd(today), nb, ne))) continue;
    }

    const base = {
      progrmRegistNo: it.progrmRegistNo ?? "",
      progrmSj:       it.progrmSj ?? "",
      progrmBgnde:    it.progrmBgnde ?? "",
      progrmEndde:    it.progrmEndde ?? "",
      noticeBgnde:    it.noticeBgnde ?? "",
      noticeEndde:    it.noticeEndde ?? "",
      rcritNmpr:      (it.rcritNmpr ?? "").toString().trim(),

      // 기관/장소
      mnnstNm:        it.mnnstNm ?? "",
      nanmmbyNm:      it.nanmmbyNm ?? "",
      actPlace:       it.actPlace ?? "",

      // 봉사시간 (API에 있으면 사용)
      actBeginTm:     (it.actBeginTm ?? "").toString().trim(),
      actEndTm:       (it.actEndTm ?? "").toString().trim(),
      actBeginMnt:    (it.actBeginMnt ?? "").toString().trim(),
      actEndMnt:      (it.actEndMnt ?? "").toString().trim(),
    };
    if (base.rcritNmpr) filledApi++;
    all.push(base);
  }

  if (items.length === 0 || (total && all.length >= total) || page >= MAX_PAGES) break;
  page++;
}

// ====== 상세 보강 (병렬 + 캐시 + 딜레이) ======
const needs = all.filter(it => !it.rcritNmpr).slice(0, MAX_DETAIL);

await Promise.all(needs.map(it => limit(async () => {
  // 캐시 hit?
  const c = cache[it.progrmRegistNo];
  if (c && c.value) { it.rcritNmpr = c.value; return; }

  if (DETAIL_DELAY_MS) await new Promise(r=>setTimeout(r, DETAIL_DELAY_MS));
  triedDetail++;
  const v = await fetchRecruitFromDetail(it.progrmRegistNo);
  if (v) { it.rcritNmpr = v; filledDetail++; }
  else { stillEmpty++; }

  // 캐시 업데이트
  cache[it.progrmRegistNo] = { value: it.rcritNmpr || "", fetchedAt: new Date().toISOString() };
})));

// ====== 저장 전 정렬: 모집기간 종료일 오름차순 ======
all.sort((a, b) => (a.noticeEndde || "99999999").localeCompare(b.noticeEndde || "99999999"));

// ====== 저장 ======
fs.mkdirSync("docs/data", { recursive: true });
fs.writeFileSync("docs/data/1365.json", JSON.stringify({
  updatedAt: new Date().toISOString(),
  params: {
    NOTICE_BG, NOTICE_ED, OFFSET_BG, OFFSET_ED,
    SIDO_NAME, SIDO_CODE, GUGUN_CODE,
    PROGRM_STTUS_SE, RECRUITING_ONLY,
    PER, MAX_PAGES, KEYWORD,
    DETAIL_CONCURRENCY, DETAIL_DELAY_MS, MAX_DETAIL
  },
  stat: { filledApi, filledDetail, stillEmpty, total: all.length },
  count: all.length,
  items: all
}, null, 2), "utf-8");

// 캐시도 저장
fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");

console.log(`✅ Saved docs/data/1365.json with ${all.length} items`);
console.log(`   ▶ 모집인원 채움: API=${filledApi}, 상세=${filledDetail}, 미확인=${stillEmpty}, 상세시도=${triedDetail}`);

// node >=18
import fs from "fs";
import axios from "axios";
import { parseStringPromise } from "xml2js";

const SERVICE_KEY = process.env.SERVICE_KEY?.trim();
if (!SERVICE_KEY) throw new Error("SERVICE_KEY missing");

// 기본 기간: 오늘 기준 -30일 ~ +30일
const today = new Date();
const fmt = d => d.toISOString().slice(0,10).replace(/-/g,"");
const NOTICE_BG = (process.env.NOTICE_BG || fmt(new Date(today.getTime() - 30*86400000))).trim();
const NOTICE_ED = (process.env.NOTICE_ED || fmt(new Date(today.getTime() + 30*86400000))).trim();
const KEYWORD   = (process.env.KEYWORD   || "").trim();

const BASE = "http://openapi.1365.go.kr/openapi/service/rest/VolunteerPartcptnService";
const EP   = `${BASE}/getVltrSearchWordList`;
const PER  = 100;

// 상세페이지(필요 시 모집인원 보강)
const DETAIL = pid =>
  `https://www.1365.go.kr/vols/P9210/partcptn/timeCptn.do?progrmRegistNo=${encodeURIComponent(pid)}&type=show`;

async function fetchRecruitFromDetail(pid){
  const { data } = await axios.get(DETAIL(pid), { timeout: 20000, responseType: "text" });
  const text = String(data);
  const m = text.match(/모집인원\s*([0-9,]+)\s*명/);
  return m ? m[1].replace(/,/g,"") : "";
}

function guessRegionFromItem(it){
  const REGION_PAT = /(서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|경기도|강원특별자치도|충청북도|충청남도|전라북도|전라남도|경상북도|경상남도|제주특별자치도)/;
  const text = `${it.actPlace||""} ${it.mnnstNm||""} ${it.nanmmbyNm||""}`;
  const m = text.match(REGION_PAT);
  return m ? m[1] : "";
}

// 응답(JSON/XML) 자동 판별
async function parseBody(data, headers){
  const ct = String(headers["content-type"] || "").toLowerCase();
  const s  = typeof data === "string" ? data.trim() : "";

  if (ct.includes("application/json") || s.startsWith("{")) {
    const j = typeof data === "string" ? JSON.parse(s) : data;
    if (j?.fault) throw new Error(`API fault: ${j.fault?.faultstring || JSON.stringify(j.fault)}`);
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

const toArray = x => (x ? (Array.isArray(x) ? x : [x]) : []);

let page = 1;
const all = [];

while (true) {
  // serviceKey는 '그대로' 붙이고, 나머지는 안전 인코딩
  const qs = new URLSearchParams({
    numOfRows: String(PER),
    pageNo: String(page),
    noticeBgnde: NOTICE_BG,
    noticeEndde: NOTICE_ED,
    _type: "json"
  });
  if (KEYWORD) qs.append("keyword", KEYWORD);

  const url = `${EP}?serviceKey=${SERVICE_KEY}&${qs.toString()}`;

  const { data, headers, status } = await axios.get(url, {
    transformResponse: [d => d],
    timeout: 30000,
    validateStatus: s => s >= 200 && s < 500
  });

  if (status >= 400) throw new Error(`HTTP ${status}. Body: ${String(data).slice(0,200)}`);

  const body  = await parseBody(data, headers);
  const items = toArray(body?.items?.item);
  const total = Number(body?.totalCount || 0);

  for (const it of items) {
    let recruit = it.rcritNmpr ?? "";
    if (!recruit) {
      try { await new Promise(r=>setTimeout(r,150)); recruit = await fetchRecruitFromDetail(it.progrmRegistNo); }
      catch(_) { recruit = ""; }
    }

    all.push({
      progrmRegistNo: it.progrmRegistNo ?? "",
      progrmSj:       it.progrmSj ?? "",
      progrmBgnde:    it.progrmBgnde ?? "",
      progrmEndde:    it.progrmEndde ?? "",
      noticeBgnde:    it.noticeBgnde ?? "",
      noticeEndde:    it.noticeEndde ?? "",
      rcritNmpr:      recruit,        // 보강된 모집인원
      mnnstNm:        it.mnnstNm ?? "",
      nanmmbyNm:      it.nanmmbyNm ?? "",
      actPlace:       it.actPlace ?? "",
      region:         guessRegionFromItem(it)
    });
  }

  if (items.length === 0 || (total && all.length >= total) || page > 50) break;
  page++;
}

fs.mkdirSync("docs/data", { recursive: true });
fs.writeFileSync("docs/data/1365.json", JSON.stringify({
  updatedAt: new Date().toISOString(),
  params: { NOTICE_BG, NOTICE_ED, KEYWORD },
  count: all.length,
  items: all
}, null, 2), "utf-8");

console.log(`✅ Saved docs/data/1365.json with ${all.length} items`);

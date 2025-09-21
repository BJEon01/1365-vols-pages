// node >=18
import fs from "fs";
import axios from "axios";
import { parseStringPromise } from "xml2js";

const SERVICE_KEY = process.env.SERVICE_KEY;
if (!SERVICE_KEY) throw new Error("SERVICE_KEY missing");

// 기본 기간: 오늘 기준 -30일 ~ +30일
const today = new Date();
const fmt = d => d.toISOString().slice(0,10).replace(/-/g,"");
const NOTICE_BG = process.env.NOTICE_BG || fmt(new Date(today.getTime()-30*86400000));
const NOTICE_ED = process.env.NOTICE_ED || fmt(new Date(today.getTime()+30*86400000));
const KEYWORD   = process.env.KEYWORD   || "";

const BASE = "http://openapi.1365.go.kr/openapi/service/rest/VolunteerPartcptnService";
const EP   = `${BASE}/getVltrSearchWordList`;
const PER  = 100;

// JSON/HTML/XML 어떤 응답이 와도 깨지지 않게 파서
async function parseBody(data, headers) {
  const ct = String(headers["content-type"] || "").toLowerCase();
  const s  = typeof data === "string" ? data.trim() : "";

  // 1) JSON
  if (ct.includes("application/json") || s.startsWith("{")) {
    const j = typeof data === "string" ? JSON.parse(s) : data;
    // data.go.kr 스타일
    const header = j?.response?.header;
    if (header && header.resultCode && header.resultCode !== "00") {
      throw new Error(`API error ${header.resultCode}: ${header.resultMsg}`);
    }
    if (j?.fault) {
      throw new Error(`API fault: ${j.fault?.faultstring || JSON.stringify(j.fault)}`);
    }
    const body = j?.response?.body;
    if (!body) throw new Error(`Unexpected JSON: ${s.slice(0,200)}`);
    return body;
  }

  // 2) XML
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

  // 3) 기타(HTML 등)
  throw new Error(`Unknown response: ${s.slice(0,200)}`);
}

let page = 1, all = [];
while (true) {
  const { data, headers } = await axios.get(EP, {
    params: {
      serviceKey: SERVICE_KEY,       // 일반키(Decoding Key) 권장
      numOfRows: PER,
      pageNo: page,
      noticeBgnde: NOTICE_BG,
      noticeEndde: NOTICE_ED,
      ...(KEYWORD ? { keyword: KEYWORD } : {}),
      _type: "json"                  // 가능하면 JSON으로 받도록 요청
    },
    // 응답을 '문자열'로 유지해 우리가 직접 판별
    transformResponse: [d => d],
    timeout: 30000
  });

  const body = await parseBody(data, headers);
  const total = Number(body.totalCount || 0);
  const items = body.items?.item;
  const arr = Array.isArray(items) ? items : (items ? [items] : []);

  all.push(...arr.map(it => ({
    progrmRegistNo: it.progrmRegistNo,
    progrmSj:       it.progrmSj,
    progrmBgnde:    it.progrmBgnde,
    progrmEndde:    it.progrmEndde,
    noticeBgnde:    it.noticeBgnde,
    noticeEndde:    it.noticeEndde,
    rcritNmpr:      it.rcritNmpr,
    mnnstNm:        it.mnnstNm,
    nanmmbyNm:      it.nanmmbyNm
  })));

  if (arr.length === 0 || (total && all.length >= total) || page > 50) break;
  page++;
}

fs.mkdirSync("docs/data", { recursive: true });
fs.writeFileSync("docs/data/1365.json", JSON.stringify({
  updatedAt: new Date().toISOString(),
  params: { NOTICE_BG, NOTICE_ED, KEYWORD },
  count: all.l

// node >=18
import fs from "fs";
import axios from "axios";
import { parseStringPromise } from "xml2js";

const SERVICE_KEY = process.env.SERVICE_KEY; // GitHub Secret에 저장
if (!SERVICE_KEY) throw new Error("SERVICE_KEY missing");

// 기본 기간: 오늘 기준 -30일 ~ +30일
const today = new Date();
const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const NOTICE_BG =
  process.env.NOTICE_BG || fmt(new Date(today.getTime() - 30 * 86400000));
const NOTICE_ED =
  process.env.NOTICE_ED || fmt(new Date(today.getTime() + 30 * 86400000));
const KEYWORD = process.env.KEYWORD || ""; // 필요시 키워드 고정 수집

const BASE =
  "http://openapi.1365.go.kr/openapi/service/rest/VolunteerPartcptnService";
const EP = `${BASE}/getVltrSearchWordList`; // 검색어/기간 목록
const PER = 100;

let page = 1,
  all = [];

while (true) {
  const { data } = await axios.get(EP, {
    params: {
      serviceKey: SERVICE_KEY,
      numOfRows: PER,
      pageNo: page,
      noticeBgnde: NOTICE_BG,
      noticeEndde: NOTICE_ED,
      ...(KEYWORD ? { keyword: KEYWORD } : {}),
    },
    responseType: "text",
  });
  const json = await parseStringPromise(data, { explicitArray: false });
  const body = json?.response?.body || {};
  const total = Number(body.totalCount || 0);
  const items = body.items?.item;
  const arr = Array.isArray(items) ? items : items ? [items] : [];

  all.push(
    ...arr.map((it) => ({
      progrmRegistNo: it.progrmRegistNo,
      progrmSj: it.progrmSj, // 봉사명
      progrmBgnde: it.progrmBgnde, // 봉사기간 시작
      progrmEndde: it.progrmEndde, // 봉사기간 종료
      noticeBgnde: it.noticeBgnde, // 모집기간 시작
      noticeEndde: it.noticeEndde, // 모집기간 종료
      rcritNmpr: it.rcritNmpr, // 모집인원
      mnnstNm: it.mnnstNm, // 모집기관
      nanmmbyNm: it.nanmmbyNm, // 등록기관
    }))
  );

  if (all.length >= total || arr.length === 0 || page > 50) break;
  page++;
}

fs.mkdirSync("docs/data", { recursive: true });
fs.writeFileSync(
  "docs/data/1365.json",
  JSON.stringify(
    {
      updatedAt: new Date().toISOString(),
      params: { NOTICE_BG, NOTICE_ED, KEYWORD },
      count: all.length,
      items: all,
    },
    null,
    2
  )
);

console.log("Saved docs/data/1365.json with", all.length, "items");

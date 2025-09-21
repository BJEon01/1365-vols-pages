<!doctype html>
<html lang="ko">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>1365 모집인원 정리</title>
<style>
  body{font:14px/1.4 system-ui,apple sd gothic neo,malgun gothic,sans-serif;margin:24px;}
  table{width:100%;border-collapse:collapse;margin-top:12px}
  th,td{border:1px solid #ddd;padding:8px;text-align:left}
  th{position:sticky;top:0;background:#fafafa}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  input,select,button{padding:6px 8px}
  footer{margin-top:16px;color:#666}
</style>

<h1>1365 모집인원 정리 (github.io)</h1>

<div class="row">
  <label>키워드:
    <input id="kw" placeholder="봉사명/기관명 포함 검색"/>
  </label>

  <label>봉사 시작 ≥
    <input id="vb" type="date"/>
  </label>

  <label>봉사 종료 ≤
    <input id="ve" type="date"/>
  </label>

  <label>모집인원 ≥
    <input id="minr" type="number" min="0" step="1" style="width:90px" placeholder="예: 10"/>
  </label>

  <label>봉사지역:
    <select id="region">
      <option value="">전체</option>
    </select>
  </label>

  <button id="search">검색</button>
  <button id="sort">모집인원↓</button>
  <button id="csv">CSV 다운로드</button>
  <button id="reset">초기화</button>
</div>

<div id="meta"></div>

<table id="tbl">
  <thead><tr>
    <th>봉사명</th>
    <th>봉사기간</th>
    <th>모집기간</th>
    <th>모집인원</th>
    <th>모집기관</th>
    <th>등록기관</th>
    <th>ID</th>
  </tr></thead>
  <tbody></tbody>
</table>

<footer>※ 데이터는 GitHub Actions로 주기적으로 새로고침됩니다.</footer>

<script>
const z = s => (s===0 ? "0" : (s?.toString().trim() || ""));
const dstr = s => (typeof s === "string" && /^\d{8}$/.test(s))
  ? `${s.slice(0,4)}.${s.slice(4,6)}.${s.slice(6)}`
  : z(s);
const toInt = v => {
  const n = parseInt(String(v ?? "").replace(/,/g,""), 10);
  return Number.isFinite(n) ? n : 0;
};

// YYYYMMDD 범위 체크 (값이 없으면 통과)
function inRange(ymd, from, to){
  if (!/^\d{8}$/.test(ymd || "")) return true;
  const f = from ? from.replaceAll("-","") : "";
  const t = to   ? to.replaceAll("-","") : "";
  return (!f || ymd >= f) && (!t || ymd <= t);
}

// 상세페이지 링크
function makeDetailUrl(id){
  return `https://www.1365.go.kr/vols/P9210/partcptn/timeCptn.do?progrmRegistNo=${encodeURIComponent(id||"")}&type=show`;
}

// 지역 추정 (액션에서 region 필드를 넣었으면 그걸 우선 사용)
const REGION_PAT = /(서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|경기도|강원특별자치도|충청북도|충청남도|전라북도|전라남도|경상북도|경상남도|제주특별자치도)/;
function guessRegion(it){
  if (it.region) return it.region;
  const text = `${it.actPlace||""} ${it.mnnstNm||""} ${it.nanmmbyNm||""}`;
  const m = text.match(REGION_PAT);
  return m ? m[1] : "";
}

let ALL = [];         // 전체 원본
let VIEW = [];        // 현재 화면 행
let sortDesc = true;  // 모집인원 내림차순 기본

function renderTable(rows){
  const tb = document.querySelector("#tbl tbody");
  tb.innerHTML = rows.map(it => `
    <tr>
      <td><a href="${makeDetailUrl(it.progrmRegistNo)}" target="_blank" rel="noopener">${z(it.progrmSj)}</a></td>
      <td>${dstr(it.progrmBgnde)} ~ ${dstr(it.progrmEndde)}</td>
      <td>${dstr(it.noticeBgnde)} ~ ${dstr(it.noticeEndde)}</td>
      <td>${z(it.rcritNmpr ?? it.recruit ?? "")}</td>
      <td>${z(it.mnnstNm)}</td>
      <td>${z(it.nanmmbyNm)}</td>
      <td>${z(it.progrmRegistNo)}</td>
    </tr>`).join("");
}

function applyFilters(){
  const kw    = document.querySelector("#kw").value.toLowerCase();
  const vb    = document.querySelector("#vb").value;  // 봉사 시작
  const ve    = document.querySelector("#ve").value;  // 봉사 종료
  const minr  = toInt(document.querySelector("#minr").value);
  const reg   = document.querySelector("#region").value;

  let rows = ALL.filter(it => {
    const text = `${it.progrmSj||""} ${it.mnnstNm||""} ${it.nanmmbyNm||""}`.toLowerCase();

    const okKw  = (!kw || text.includes(kw));
    const okVol = inRange(it.progrmBgnde, vb, ve) && inRange(it.progrmEndde, vb, ve);
    const r     = toInt(it.rcritNmpr ?? it.recruit);
    const okR   = (isNaN(minr) || minr===0) ? true : (r >= minr);
    const region = guessRegion(it);
    const okReg  = (!reg || region === reg);

    return okKw && okVol && okR && okReg;
  });

  rows.sort((a,b) => (toInt(b.rcritNmpr ?? b.recruit) - toInt(a.rcritNmpr ?? a.recruit)) * (sortDesc ? 1 : -1));
  VIEW = rows;
  renderTable(rows);
}

function exportCSV(rows){
  const header = ["봉사명","봉사기간","모집기간","모집인원","모집기관","등록기관","ID"];
  const esc = v => `"${String(v??"").replace(/"/g,'""')}"`;
  const lines = [header.map(esc).join(",")];
  rows.forEach(it=>{
    lines.push([
      it.progrmSj,
      `${dstr(it.progrmBgnde)} ~ ${dstr(it.progrmEndde)}`,
      `${dstr(it.noticeBgnde)} ~ ${dstr(it.noticeEndde)}`,
      (it.rcritNmpr ?? it.recruit ?? ""),
      it.mnnstNm, it.nanmmbyNm, it.progrmRegistNo
    ].map(esc).join(","));
  });
  const blob = new Blob([lines.join("\r\n")], {type:"text/csv;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "1365_results.csv";
  document.body.appendChild(a); a.click(); a.remove();
}

(async function init(){
  const meta = document.querySelector("#meta");

  // 데이터 로드
  let payload;
  try{
    const res = await fetch("data/1365.json", { cache: "no-store" });
    if(!res.ok) throw new Error("load fail");
    payload = await res.json();
  }catch(e){
    meta.textContent = "data/1365.json 이 아직 없습니다. Actions에서 Fetch 워크플로우를 먼저 실행하세요.";
    return;
  }

  ALL = Array.isArray(payload.items) ? payload.items : [];
  meta.textContent = `업데이트: ${payload.updatedAt ? new Date(payload.updatedAt).toLocaleString() : "—"} · 총 ${ALL.length}건`;

  // 지역 옵션 구성(데이터에서 자동 수집)
  const set = new Set();
  ALL.forEach(it => { const g = guessRegion(it); if (g) set.add(g); });
  const opts = [...set].sort();
  const sel = document.querySelector("#region");
  opts.forEach(v => {
    const o = document.createElement("option");
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  });

  // 버튼 이벤트
  document.querySelector("#search").onclick = applyFilters; // ← 검색 버튼 눌러야 반영
  document.querySelector("#sort").onclick = () => {
    sortDesc = !sortDesc;
    document.querySelector("#sort").textContent = sortDesc ? "모집인원↓" : "모집인원↑";
    applyFilters();
  };
  document.querySelector("#csv").onclick = () => exportCSV(VIEW);
  document.querySelector("#reset").onclick = () => {
    document.querySelector("#kw").value = "";
    document.querySelector("#vb").value = "";
    document.querySelector("#ve").value = "";
    document.querySelector("#minr").value = "";
    document.querySelector("#region").value = "";
    sortDesc = true;
    document.querySelector("#sort").textContent = "모집인원↓";
    applyFilters();
  };

  // 최초 한 번 전체 표시
  applyFilters();
})();
</script>
</html>

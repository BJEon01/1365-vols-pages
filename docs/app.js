import { createSearchTab } from "./search.js";

const panels = {
  search: document.querySelector("#searchTabPanel"),
};

const detailDialog = document.querySelector("#detailDialog");
const detailTitle = document.querySelector("#detailTitle");
const detailBody = document.querySelector("#detailBody");
const closeDetailButton = document.querySelector("#closeDetailBtn");
const heroUpdate = document.querySelector("#heroUpdate");

const searchTab = createSearchTab({
  root: panels.search,
  detailDialog,
  detailTitle,
  detailBody,
});

function formatUpdatedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}. ${lookup.month}. ${lookup.day}. ${lookup.dayPeriod} ${lookup.hour}:${lookup.minute}:${lookup.second}`;
}

async function loadHeroUpdate() {
  try {
    const dataUrl = new URL("./data/volunteer_posts.json", window.location.href);
    dataUrl.searchParams.set("v", String(Date.now()));
    const response = await fetch(dataUrl.toString(), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const formatted = formatUpdatedAt(payload.updatedAt);
    if (!formatted) {
      throw new Error("updatedAt missing");
    }
    heroUpdate.textContent = `최근 업데이트: ${formatted} (6시간마다 자동갱신)`;
  } catch {
    heroUpdate.textContent = "최근 업데이트 정보를 확인하지 못했습니다.";
  }
}

closeDetailButton.addEventListener("click", () => {
  detailDialog.close();
});

detailDialog.addEventListener("click", (event) => {
  const bounds = detailDialog.getBoundingClientRect();
  const inside =
    bounds.top <= event.clientY &&
    event.clientY <= bounds.top + bounds.height &&
    bounds.left <= event.clientX &&
    event.clientX <= bounds.left + bounds.width;
  if (!inside) {
    detailDialog.close();
  }
});

await loadHeroUpdate();
await searchTab.loadInitial();

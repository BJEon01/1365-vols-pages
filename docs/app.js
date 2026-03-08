import { createChatTab } from "./chat.js";
import { createSearchTab } from "./search.js";

const tabButtons = [...document.querySelectorAll(".tab-button")];
const panels = {
  search: document.querySelector("#searchTabPanel"),
  chat: document.querySelector("#chatTabPanel"),
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
const chatTab = createChatTab({ root: panels.chat });

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
    const response = await fetch("./data/volunteer_posts.json", { cache: "no-store" });
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

function switchTab(name) {
  tabButtons.forEach((button) => {
    const active = button.dataset.tab === name;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });

  Object.entries(panels).forEach(([key, panel]) => {
    panel.classList.toggle("is-hidden", key !== name);
  });
}

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    switchTab(button.dataset.tab);
  });
});

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

switchTab("search");
await loadHeroUpdate();
await searchTab.loadInitial();
chatTab.refresh();

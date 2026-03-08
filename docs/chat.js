export function createChatTab({ root }) {
  function render() {
    root.innerHTML = `
      <div class="stack">
        <section class="panel">
          <div class="panel-body">
            <div class="chat-placeholder chat-placeholder-dev">
              <p class="eyebrow">AI RECOMMENDATION</p>
              <h2>챗봇 추천</h2>
              <p>개발 중입니다.</p>
            </div>
          </div>
        </section>
      </div>
    `;
  }

  render();

  return {
    refresh() {
      render();
    },
  };
}

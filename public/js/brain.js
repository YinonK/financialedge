renderSidebar('/brain.html');

function appendMessage(role, content) {
  const log = document.getElementById('chatLog');
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.textContent = content;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function loadHistory() {
  const log = document.getElementById('chatLog');
  try {
    const messages = await Api.get('/api/brain/messages');
    if (!messages.length) {
      log.innerHTML = `<div class="empty-state">No conversation yet. The Brain has your portfolio, signals, and market context loaded — ask it anything.</div>`;
      return;
    }
    log.innerHTML = '';
    messages.forEach((m) => appendMessage(m.role, m.content));
  } catch (err) {
    log.innerHTML = `<div class="empty-state">Couldn't load chat history: ${err.message}</div>`;
  }
}

async function sendChat() {
  const input = document.getElementById('chatInput');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';

  const log = document.getElementById('chatLog');
  if (log.querySelector('.empty-state')) log.innerHTML = '';
  appendMessage('user', message);

  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'chat-msg assistant dim';
  thinkingEl.textContent = 'The Brain is thinking…';
  log.appendChild(thinkingEl);
  log.scrollTop = log.scrollHeight;

  try {
    const res = await Api.post('/api/brain/chat', { message });
    thinkingEl.remove();
    appendMessage('assistant', res.assistantMsg.content);
  } catch (err) {
    thinkingEl.remove();
    if (err.code === 'GEMINI_NOT_CONFIGURED') {
      appendMessage('assistant', err.message);
    } else {
      appendMessage('assistant', `(error: ${err.message})`);
    }
  }
}

(async function init() {
  await syncContextFromServer();
  loadHistory();
})();

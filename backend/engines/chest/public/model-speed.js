'use strict';

const form = document.getElementById('test-form');
const provider = document.getElementById('provider');
const statusEl = document.getElementById('status');
const answerEl = document.getElementById('answer');
const historyEl = document.getElementById('history');
const modelNameEl = document.getElementById('model-name');
const clearButton = document.getElementById('clear-results');
const metrics = {
  firstByte: document.getElementById('first-byte'),
  firstToken: document.getElementById('first-token'),
  total: document.getElementById('total-time'),
  speed: document.getElementById('speed')
};

const presets = {
  openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  deepseek: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  qwen: { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  moonshot: { base_url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  zhipu: { base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' }
};

let rows = [];

function setMetric(el, value, suffix = 'ms') {
  el.textContent = value === null || value === undefined ? '-' : `${value}${suffix}`;
}

function renderResult(result) {
  const m = result.metrics || {};
  setMetric(metrics.firstByte, m.first_byte_ms);
  setMetric(metrics.firstToken, m.first_token_ms);
  setMetric(metrics.total, m.total_ms);
  metrics.speed.textContent = m.chars_per_second ? `${m.chars_per_second}字/秒` : '-';
  modelNameEl.textContent = result.model || '已完成';
  answerEl.textContent = result.answer || result.raw_preview || '接口返回成功，但未解析到文本内容。';
}

function renderHistory() {
  if (!rows.length) {
    historyEl.innerHTML = '<tr><td colspan="5">暂无记录</td></tr>';
    return;
  }
  historyEl.innerHTML = rows.map(row => `<tr>
    <td>${row.time}</td>
    <td>${escapeHtml(row.model)}</td>
    <td>${row.firstToken ?? '-'}ms</td>
    <td>${row.total ?? '-'}ms</td>
    <td>${row.speed ? row.speed + '字/秒' : '-'}</td>
  </tr>`).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

provider.addEventListener('change', () => {
  const preset = presets[provider.value];
  if (!preset) return;
  form.elements.base_url.value = preset.base_url;
  form.elements.model.value = preset.model;
});

clearButton.addEventListener('click', () => {
  rows = [];
  renderHistory();
  modelNameEl.textContent = '尚未测试';
  answerEl.textContent = '填写左侧信息后开始测试。';
  Object.values(metrics).forEach(el => { el.textContent = '-'; });
  statusEl.textContent = '已清空本页记录。';
  statusEl.classList.remove('error');
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(form));
  data.stream = form.elements.stream.checked;
  statusEl.textContent = '正在请求模型接口...';
  statusEl.classList.remove('error');
  answerEl.textContent = '等待模型回复...';
  button.disabled = true;
  try {
    const response = await fetch('/api/model-test', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '测试失败，请检查接口配置。');
    renderResult(result);
    const m = result.metrics || {};
    rows.unshift({
      time: new Date().toLocaleTimeString('zh-CN', {hour12: false}),
      model: result.model,
      firstToken: m.first_token_ms,
      total: m.total_ms,
      speed: m.chars_per_second
    });
    rows = rows.slice(0, 12);
    renderHistory();
    statusEl.textContent = '测试完成。可以换模型名继续对比。';
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.classList.add('error');
    answerEl.textContent = '测试未完成。请确认 Base URL、模型名称、API Key 和网络连接。';
  } finally {
    button.disabled = false;
  }
});

function bugreportElapsed(status) {
  if (!status.started_at) return '';
  const end = status.finished_at || Date.now() / 1000;
  return `${Math.max(0, Math.round(end - status.started_at))} 秒`;
}

function renderBugreportStatus(status) {
  state.bugreports.status = status || {state: 'idle'};
  const text = $('#bugreportStatus');
  const start = $('#bugreportStartButton');
  const cancel = $('#bugreportCancelButton');
  if (!text || !start || !cancel) return;
  const active = ['running', 'cancelling'].includes(status.state);
  text.textContent = `${status.message || '当前没有 Bugreport 采集任务'}${bugreportElapsed(status) ? ` · ${bugreportElapsed(status)}` : ''}`;
  start.disabled = active;
  start.textContent = active ? '采集中…' : '开始采集';
  cancel.hidden = !active;
  clearTimeout(state.bugreports.timer);
  if (active) state.bugreports.timer = setTimeout(loadBugreports, 1500);
}

function renderBugreportFiles(items) {
  const root = $('#bugreportList');
  if (!root) return;
  root.innerHTML = items.length ? items.map(item => `<div class="bugreport-row"><div><b>${escapeHtml(item.name)}</b><small>${formatSize(item.size)} · ${new Date(item.modified).toLocaleString()}</small></div><a class="button subtle" href="${item.url}" download="${escapeHtml(item.name)}">下载</a><button class="button danger" type="button" onclick="deleteBugreport('${escapeHtml(item.id)}')">删除</button></div>`).join('') : '<div class="device-log-empty">尚未采集 Bugreport。</div>';
}

async function loadBugreports() {
  try {
    const [status, result] = await Promise.all([api('/api/bugreports/status'), api('/api/bugreports/files')]);
    renderBugreportStatus(status);
    state.bugreports.items = result.items || [];
    renderBugreportFiles(state.bugreports.items);
  } catch (error) { toast(error.message, true); }
}

async function startBugreport() {
  const button = $('#bugreportStartButton');
  button.disabled = true;
  try {
    const status = await api('/api/bugreports/start', {method: 'POST', body: JSON.stringify(withAdbSerial({note: $('#bugreportNote').value.trim()}))});
    renderBugreportStatus(status);
    toast('Bugreport 已开始采集');
  } catch (error) { toast(error.message, true); button.disabled = false; }
}

async function cancelBugreport() {
  if (!confirm('确认取消当前 Bugreport 采集？未完成的临时文件会被清理。')) return;
  try { renderBugreportStatus(await api('/api/bugreports/cancel', {method: 'POST', body: '{}'})); }
  catch (error) { toast(error.message, true); }
}

async function deleteBugreport(id) {
  if (!confirm(`确认删除 Bugreport？\n\n${id}`)) return;
  try { await api('/api/bugreports/delete', {method: 'POST', body: JSON.stringify({id})}); toast('Bugreport 已删除'); await loadBugreports(); }
  catch (error) { toast(error.message, true); }
}


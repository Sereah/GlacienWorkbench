function performanceValue(value, suffix = '') {
  return value === null || value === undefined || Number.isNaN(value) ? '—' : `${value}${suffix}`;
}
function performanceBytes(value) {
  return value === null || value === undefined ? '—' : formatSize(value);
}

function performanceRatio(used, total) {
  if (used === null || used === undefined || !total) return '—';
  return `${performanceBytes(used)} / ${performanceBytes(total)}`;
}

function performanceElapsed(status) {
  if (!status.started_at) return '00:00';
  const end = status.finished_at ? Date.parse(status.finished_at) : Date.now();
  const seconds = Math.max(0, Math.floor((end - Date.parse(status.started_at)) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function performanceSmoothPath(points) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1], current = points[index], middle = (previous.x + current.x) / 2;
    path += ` C ${middle} ${previous.y}, ${middle} ${current.y}, ${current.x} ${current.y}`;
  }
  return path;
}

function performanceChart(chart, samples, series, options = {}) {
  if (!chart) return;
  const width = 600, height = 210, left = 48, right = 590, top = 12, bottom = 178;
  const styles = getComputedStyle(document.documentElement);
  const line = styles.getPropertyValue('--line').trim() || '#45464e';
  const light = document.documentElement.dataset.themeMode === 'light';
  const colors = light ? ['#4557d6', '#008b83'] : ['#969cff', '#40d8c7'];
  const nodes = [];
  for (let row = 0; row <= 4; row += 1) {
    const y = top + (bottom - top) * row / 4;
    nodes.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" class="performance-chart-grid"/>`);
  }
  const values = series.flatMap(item => samples.map(item.read)).filter(value => Number.isFinite(value));
  const ceiling = options.maximum ? Math.max(options.maximum, ...values) : Math.max(1, ...values) * 1.12;
  const axisFormat = options.axisFormat || (value => String(Math.round(value)));
  for (let row = 0; row <= 4; row += 1) {
    const value = ceiling * (4 - row) / 4;
    const y = top + (bottom - top) * row / 4 + 4;
    nodes.push(`<text x="40" y="${y}" text-anchor="end" class="performance-chart-axis">${escapeHtml(axisFormat(value))}</text>`);
  }
  series.forEach((item, index) => {
    const segments = [];
    let points = [];
    samples.forEach((sample, position) => {
      const value = item.read(sample);
      if (!Number.isFinite(value)) { if (points.length) segments.push(points); points = []; return; }
      const x = left + (right - left) * position / Math.max(1, samples.length - 1);
      const y = bottom - Math.min(1, value / ceiling) * (bottom - top);
      points.push({x: Number(x.toFixed(1)), y: Number(y.toFixed(1))});
    });
    if (points.length) segments.push(points);
    for (const segment of segments) {
      const path = performanceSmoothPath(segment);
      if (index === 0 && segment.length > 1) nodes.push(`<path d="${path} L ${segment[segment.length - 1].x} ${bottom} L ${segment[0].x} ${bottom} Z" fill="${colors[index]}" opacity=".07"/>`);
      nodes.push(`<path d="${path}" fill="none" stroke="${colors[index % colors.length]}" stroke-width="1.45" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`);
      if (segment.length === 1) nodes.push(`<circle cx="${segment[0].x}" cy="${segment[0].y}" r="2.4" fill="${colors[index % colors.length]}"/>`);
    }
  });
  if (samples.length) {
    nodes.push(`<text x="${left}" y="202" class="performance-chart-axis">${escapeHtml(performanceSampleTime(samples[0]))}</text>`);
    nodes.push(`<text x="${right}" y="202" text-anchor="end" class="performance-chart-axis">${escapeHtml(performanceSampleTime(samples[samples.length - 1]))}</text>`);
    nodes.push(`<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" class="performance-chart-cursor" hidden/>`);
    nodes.push(`<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" class="performance-chart-hit"/>`);
  } else {
    nodes.push('<text x="300" y="105" text-anchor="middle" class="performance-chart-empty">等待采样数据</text>');
  }
  chart.innerHTML = nodes.join('');
  const tooltip = chart.nextElementSibling;
  const cursor = chart.querySelector('.performance-chart-cursor');
  chart.onpointerleave = () => { if (tooltip) tooltip.hidden = true; if (cursor) cursor.hidden = true; };
  chart.onpointermove = event => {
    if (!tooltip || !samples.length) return;
    const rect = chart.getBoundingClientRect();
    const viewX = (event.clientX - rect.left) * width / rect.width;
    const relative = Math.max(0, Math.min(1, (viewX - left) / (right - left)));
    const index = Math.round(relative * (samples.length - 1));
    const sample = samples[index];
    const cursorX = left + (right - left) * index / Math.max(1, samples.length - 1);
    if (cursor) { cursor.hidden = false; cursor.setAttribute('x1', cursorX); cursor.setAttribute('x2', cursorX); }
    tooltip.replaceChildren();
    const time = document.createElement('b'); time.textContent = performanceSampleTime(sample);
    tooltip.append(time);
    for (const [seriesIndex, item] of series.entries()) {
      const row = document.createElement('span'); row.style.setProperty('--series-color', colors[seriesIndex % colors.length]);
      const value = item.read(sample); row.textContent = `${item.label}  ${Number.isFinite(value) ? item.format(value) : '不可用'}`;
      tooltip.append(row);
    }
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(8, Math.min(rect.width - 160, event.clientX - rect.left + 10))}px`;
    const pointerY = event.clientY - rect.top;
    tooltip.style.top = `${chart.offsetTop + pointerY}px`;
    tooltip.style.transform = pointerY > rect.height * .55 ? 'translateY(calc(-100% - 14px))' : 'translateY(14px)';
  };
}

function performanceSampleTime(sample) {
  const seconds = Math.max(0, Math.round(Number(sample?.elapsed_ms || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderPerformanceActivityTimeline(samples, latest) {
  const container = $('#performanceActivityTimeline');
  if (!container) return;
  const source = samples.length ? samples : latest?.foreground?.component ? [latest] : [];
  const events = [];
  let previous = '';
  for (const sample of source) {
    const foreground = sample.foreground || {};
    if (!foreground.component) continue;
    const identity = `${foreground.display_id ?? '?'}|${foreground.component}`;
    if (identity === previous) continue;
    previous = identity;
    events.push({sample, foreground});
  }
  if (!events.length) {
    container.innerHTML = '<p>尚未读取到前台 Activity。</p>';
    return;
  }
  container.innerHTML = events.slice(-8).map((event, index, visible) => {
    const display = event.foreground.display_id === null || event.foreground.display_id === undefined ? 'Display ?' : `Display ${event.foreground.display_id}`;
    return `<article class="${index === visible.length - 1 ? 'current' : ''}"><i></i><time>${escapeHtml(performanceSampleTime(event.sample))}</time><span>${escapeHtml(display)}</span><b>${escapeHtml(event.foreground.component)}</b></article>`;
  }).join('');
}

function renderPerformanceStatus(status) {
  state.performance.status = status;
  const latest = status.latest || {};
  const system = latest.system || {}, process = latest.process || {}, battery = latest.battery || {};
  const memory = system.memory || {}, storage = system.data_storage || {}, foreground = latest.foreground || {};
  const active = ['running', 'paused', 'stopping'].includes(status.state);
  const paused = status.state === 'paused';
  $('#performanceStart').disabled = active;
  $('#performancePause').disabled = !['running', 'paused'].includes(status.state);
  $('#performancePause').textContent = paused ? '恢复' : '暂停';
  $('#performanceStop').disabled = !['running', 'paused'].includes(status.state);
  $('#performancePackage').disabled = active;
  $('#performanceInterval').disabled = active;
  $('#performanceState').textContent = ({idle: '未采样', running: '采样中', paused: '已暂停', stopping: '归档中', completed: '已完成', interrupted: '已中断'}[status.state] || status.state);
  $('#performanceState').dataset.state = status.state || 'idle';
  $('#performanceSummary').textContent = status.session_id ? `${status.package} · ${performanceElapsed(status)} · ${status.sample_count || 0} 条样本` : '选择应用后开始采样';
  $('#performanceSystemCpu').textContent = performanceValue(system.cpu_percent, '%');
  $('#performanceMemory').textContent = performanceRatio(memory.used_bytes, memory.total_bytes);
  $('#performanceStorage').textContent = performanceRatio(storage.used_bytes, storage.total_bytes);
  $('#performanceThermal').textContent = performanceValue(latest.thermal?.status);
  $('#performanceProcessCpu').textContent = performanceValue(process.cpu_percent, '%');
  $('#performanceRss').textContent = performanceBytes(process.rss_bytes);
  $('#performancePss').textContent = performanceBytes(process.pss_bytes);
  const batteryParts = [performanceValue(battery.level, '%')];
  if (battery.current_ma !== null && battery.current_ma !== undefined) batteryParts.push(`${battery.current_ma} mA`);
  if (battery.temperature_c !== null && battery.temperature_c !== undefined) batteryParts.push(`${battery.temperature_c}°C`);
  $('#performanceBattery').textContent = batteryParts.filter(value => value !== '—').join(' · ') || '—';
  $('#performanceForeground').textContent = foreground.component ? `${foreground.display_id === null || foreground.display_id === undefined ? 'Display ?' : `Display ${foreground.display_id}`} · ${foreground.component}` : '—';
  const warnings = latest.errors || [];
  $('#performanceWarnings').hidden = !warnings.length;
  $('#performanceWarnings').textContent = warnings.length ? `部分指标不可用：${warnings[0]}${warnings.length > 1 ? `（另有 ${warnings.length - 1} 项）` : ''}` : '';
  const downloads = status.downloads || {};
  for (const [format, selector] of [['csv', '#performanceCsv'], ['json', '#performanceJson']]) {
    const link = $(selector); link.href = downloads[format] || ''; link.classList.toggle('disabled-link', !downloads[format]);
  }
  const samples = (status.samples || []).slice(-90);
  performanceChart($('#performanceCpuChart'), samples, [
    {label: '整机', read: sample => sample.system?.cpu_percent, format: value => `${value.toFixed(1)}%`},
    {label: '目标进程', read: sample => sample.process?.cpu_percent, format: value => `${value.toFixed(1)}%`},
  ], {maximum: 100, axisFormat: value => `${Math.round(value)}%`});
  performanceChart($('#performanceMemoryChart'), samples, [
    {label: 'RSS', read: sample => Number.isFinite(sample.process?.rss_bytes) ? sample.process.rss_bytes / 1048576 : null, format: value => `${value.toFixed(1)} MB`},
    {label: 'PSS', read: sample => Number.isFinite(sample.process?.pss_bytes) ? sample.process.pss_bytes / 1048576 : null, format: value => `${value.toFixed(1)} MB`},
  ], {axisFormat: value => `${Math.round(value)} MB`});
  renderPerformanceActivityTimeline(samples, latest);
  if (active) startPerformancePolling(); else stopPerformancePolling();
}

function stopPerformancePolling() {
  if (state.performance.timer) clearInterval(state.performance.timer);
  state.performance.timer = null;
}

function startPerformancePolling() {
  if (state.performance.timer) return;
  state.performance.timer = setInterval(refreshPerformanceStatus, 750);
}

async function refreshPerformanceStatus() {
  try { renderPerformanceStatus(await api('/api/performance/status')); }
  catch (error) { stopPerformancePolling(); toast(error.message, true); }
}

async function loadPerformanceApplications() {
  if (state.performance.applicationsLoaded || !selectedAdbSerial()) return;
  try {
    const result = await api(apiPathWithSerial('/api/apps'));
    $('#performanceApplications').innerHTML = (result.items || []).map(item => `<option value="${escapeHtml(item.package)}"></option>`).join('');
    state.performance.applicationsLoaded = true;
  } catch (error) { toast(`读取应用列表失败：${error.message}`, true); }
}

async function loadPerformancePage() {
  if (state.performance.status.state === 'idle' && state.config?.sample_interval_seconds) $('#performanceInterval').value = String(state.config.sample_interval_seconds);
  await Promise.all([refreshPerformanceStatus(), loadPerformanceApplications()]);
}

async function startPerformanceSampling() {
  const packageName = $('#performancePackage').value.trim();
  if (!packageName) return toast('请选择或输入目标应用包名', true);
  const button = $('#performanceStart'); button.disabled = true; button.textContent = '启动中…';
  try {
    await api('/api/config/domain', {method: 'POST', body: JSON.stringify({domain: 'performance_diagnostics', values: {sample_interval_seconds: Number($('#performanceInterval').value)}})});
    state.config.sample_interval_seconds = Number($('#performanceInterval').value);
    const result = await api('/api/performance/start', {method: 'POST', body: JSON.stringify(withAdbSerial({package: packageName, sample_interval_seconds: Number($('#performanceInterval').value)}))});
    renderPerformanceStatus(result); toast('性能采样已开始');
  } catch (error) { toast(error.message, true); }
  finally { button.textContent = '开始采样'; if (!['running', 'paused'].includes(state.performance.status.state)) button.disabled = false; }
}

async function togglePerformancePause() {
  const paused = state.performance.status.state === 'paused';
  try {
    const result = await api(`/api/performance/${paused ? 'resume' : 'pause'}`, {method: 'POST', body: '{}'});
    renderPerformanceStatus(result); toast(paused ? '性能采样已恢复' : '性能采样已暂停');
  } catch (error) { toast(error.message, true); }
}

async function stopPerformanceSampling() {
  const button = $('#performanceStop'); button.disabled = true; button.textContent = '归档中…';
  try {
    const result = await api('/api/performance/stop', {method: 'POST', body: '{}'});
    renderPerformanceStatus(result); toast('性能采样已归档，可导出 CSV 或 JSON');
  } catch (error) { toast(error.message, true); }
  finally { button.textContent = '停止并归档'; }
}

function performanceSessionState(value) {
  return ({running: '采样中', paused: '已暂停', stopping: '归档中', completed: '已完成', interrupted: '异常中断'}[value] || value || '未知');
}

function updatePerformanceSessionSelection() {
  const selected = state.performance.selectedSessions;
  $$('.performance-session-row').forEach(row => {
    const checked = selected.has(row.dataset.id);
    row.classList.toggle('selected', checked);
    const input = row.querySelector('input[type="checkbox"]');
    if (input) input.checked = checked;
  });
  const count = $('#performanceSessionSelected');
  const remove = $('#performanceSessionDelete');
  if (count) count.textContent = `已选 ${selected.size} 条`;
  if (remove) remove.disabled = !selected.size;
}

function togglePerformanceSession(id, checked) {
  if (checked) state.performance.selectedSessions.add(id);
  else state.performance.selectedSessions.delete(id);
  updatePerformanceSessionSelection();
}

function toggleAllPerformanceSessions() {
  const removable = state.performance.sessions.filter(item => !item.active);
  const allSelected = removable.length && removable.every(item => state.performance.selectedSessions.has(item.id));
  for (const item of removable) {
    if (allSelected) state.performance.selectedSessions.delete(item.id);
    else state.performance.selectedSessions.add(item.id);
  }
  updatePerformanceSessionSelection();
}

function renderPerformanceSessions(result) {
  state.performance.sessions = result.items || [];
  const valid = new Set(state.performance.sessions.map(item => item.id));
  state.performance.selectedSessions = new Set([...state.performance.selectedSessions].filter(id => valid.has(id)));
  const rows = state.performance.sessions.map(item => {
    const downloads = item.downloads || {};
    const actions = `${downloads.csv ? `<a class="button subtle" href="${downloads.csv}" download>CSV</a>` : ''}${downloads.json ? `<a class="button subtle" href="${downloads.json}" download>JSON</a>` : ''}`;
    return `<article class="performance-session-row${state.performance.selectedSessions.has(item.id) ? ' selected' : ''}" data-id="${item.id}"><label><input type="checkbox" ${item.active ? 'disabled' : ''} ${state.performance.selectedSessions.has(item.id) ? 'checked' : ''} onchange="togglePerformanceSession('${item.id}',this.checked)"><span></span></label><div><b>${escapeHtml(item.package || '未知应用')}</b><small>${escapeHtml(item.serial || '未知设备')} · ${escapeHtml(new Date(item.started_at || item.modified).toLocaleString())}</small></div><span class="performance-session-state">${escapeHtml(performanceSessionState(item.state))}</span><span>${item.sample_count || 0} 条 · ${formatSize(item.size || 0)}</span><div class="performance-session-actions">${actions}</div></article>`;
  }).join('');
  const body = $('#configModalBody');
  body.innerHTML = `<div class="performance-session-manager"><div class="performance-session-toolbar"><span>共 ${result.total || 0} 条 · ${formatSize(result.total_size || 0)}</span><span id="performanceSessionSelected">已选 ${state.performance.selectedSessions.size} 条</span><button class="button subtle" type="button" onclick="toggleAllPerformanceSessions()">全选可删除项</button><button class="button danger" id="performanceSessionDelete" type="button" onclick="deleteSelectedPerformanceSessions()" ${state.performance.selectedSessions.size ? '' : 'disabled'}>删除所选</button><button class="button subtle" type="button" onclick="loadPerformanceSessions()">刷新</button></div><div class="performance-session-list">${rows || '<p class="performance-session-empty">尚无性能采样记录。</p>'}</div></div>`;
}

async function loadPerformanceSessions() {
  try { renderPerformanceSessions(await api('/api/performance/sessions')); }
  catch (error) { $('#configModalBody').innerHTML = `<p class="user-guide-error">${escapeHtml(error.message)}</p>`; }
}

async function openPerformanceSessionManager() {
  state.performance.selectedSessions = new Set();
  openFeatureModal('performance-sessions', '采样记录', '<p class="user-guide-loading">正在读取采样记录…</p>', {hideFooter: true});
  await loadPerformanceSessions();
}

async function deleteSelectedPerformanceSessions() {
  const ids = [...state.performance.selectedSessions];
  if (!ids.length || !confirm(`确认删除选中的 ${ids.length} 条性能采样记录？\n\n采样原始数据和 CSV/JSON 将被永久删除。`)) return;
  const button = $('#performanceSessionDelete'); button.disabled = true; button.textContent = '删除中…';
  try {
    const result = await api('/api/performance/sessions/delete', {method: 'POST', body: JSON.stringify({ids, confirmed: true})});
    state.performance.selectedSessions = new Set();
    await Promise.all([loadPerformanceSessions(), refreshPerformanceStatus()]);
    toast(`已删除 ${result.deleted.length} 条采样记录`);
  } catch (error) { toast(error.message, true); button.disabled = false; button.textContent = '删除所选'; }
}

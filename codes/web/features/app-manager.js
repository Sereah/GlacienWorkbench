function selectAppManagerTab(tab) {
  state.appManager.tab = tab;
  $$('.app-manager-tab').forEach(button => button.classList.toggle('active', button.dataset.appManagerTab === tab));
  $$('.app-manager-panel').forEach(panel => panel.classList.toggle('visible', panel.id === `app-manager-${tab}`));
  if (tab === 'apps') loadApplications();
  if (tab === 'processes') loadProcesses();
}

async function fetchApplications(force = false) {
  const cache = state.appManager;
  const serial = selectedAdbSerial();
  if (!force && cache.loaded && cache.serial === serial) return cache.items;
  if (cache.serial !== serial) cache.details = {};
  const result = await api(apiPathWithSerial('/api/apps'));
  cache.items = result.items || [];
  cache.serial = serial;
  cache.loaded = true;
  return cache.items;
}

function watchedPackages() { return Array.isArray(state.config?.watched_packages) ? state.config.watched_packages : []; }
function matchingWatchKeywords(packageName) {
  const target = packageName.toLowerCase();
  return (state.config?.process_package_keywords || []).map(value => String(value).trim()).filter(value => value && target.includes(value.toLowerCase()));
}
function applicationSignatureMeta(packageName) {
  const detail = state.appManager.details[packageName];
  if (!detail) return {label: '平台签名：点击查询', resolved: false};
  const label = {platform: '平台签名：是', non_platform: '平台签名：否', unknown: '平台签名：未知'}[detail.signature_status] || '平台签名：未知';
  return {label, resolved: true};
}

function applicationItem(item) {
  const watched = watchedPackages().includes(item.package), signature = applicationSignatureMeta(item.package);
  return `<article class="app-manager-row">
    <i class="process-dot${item.running ? ' running' : ''}"></i>
    <div class="app-manager-main"><b>${escapeHtml(item.package)}</b><div class="app-manager-meta"><span>${item.kind === 'user' ? '用户应用' : '系统应用'}</span>${item.uid ? `<span>UID ${escapeHtml(item.uid)}</span>` : ''}<span>${item.pids?.length ? `PID ${item.pids.map(escapeHtml).join('、')}` : '未运行'}</span><button class="app-manager-signature${signature.resolved ? ' resolved' : ''}" type="button" onclick="queryApplicationPlatformSignature('${escapeHtml(item.package)}',this)">${signature.label}</button></div><small title="${escapeHtml(item.apk_path)}">${escapeHtml(item.apk_path)}</small></div>
    <span class="process-state${item.running ? ' running' : ''}">${item.running ? 'RUNNING' : 'STOPPED'}</span>
    <button class="watch-toggle${watched ? ' active' : ''}" type="button" onclick="toggleWatchedPackage('${escapeHtml(item.package)}')" title="${watched ? '取消手动关注' : '添加到关注应用'}">${watched ? '★' : '☆'}</button>
    <button class="button subtle" type="button" onclick="openApplicationDetails('${escapeHtml(item.package)}')">详情</button>
    <button class="button subtle" type="button" onclick="runApplicationAction('launch','${escapeHtml(item.package)}')">启动</button>
    <button class="button danger" type="button" onclick="runApplicationAction('stop','${escapeHtml(item.package)}')" ${item.running ? '' : 'disabled'}>停止</button>
  </article>`;
}

async function queryApplicationPlatformSignature(packageName, button) {
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '平台签名：查询中…';
  try {
    const detail = await api(`/api/apps/details?serial=${encodeURIComponent(selectedAdbSerial())}&package=${encodeURIComponent(packageName)}`);
    state.appManager.details[packageName] = detail;
    renderApplications();
    renderFocusedApplications();
  } catch (error) {
    button.disabled = false;
    button.textContent = '平台签名：查询失败，点击重试';
    toast(error.message, true);
  }
}

function filteredApplications() {
  const query = ($('#appManagerSearch')?.value || '').trim().toLowerCase();
  const kind = $('#appManagerKind')?.value || 'all';
  const running = $('#appManagerRunning')?.checked || false;
  return state.appManager.items.filter(item => {
    if (kind !== 'all' && item.kind !== kind) return false;
    if (running && !item.running) return false;
    const packageMatched = item.package.toLowerCase().includes(query);
    const pidMatched = (item.pids || []).some(pid => String(pid).includes(query));
    return !query || packageMatched || pidMatched;
  });
}

function renderApplicationList(root, items, emptyText) {
  if (!items.length) {
    root.innerHTML = `<div class="process-row">${escapeHtml(emptyText)}</div>`;
    return;
  }
  root.innerHTML = items.map(applicationItem).join('');
}

function renderApplications() {
  const root = $('#appManagerList');
  if (!root) return;
  const items = filteredApplications();
  $('#appManagerCount').textContent = `显示 ${items.length} / ${state.appManager.items.length} 个应用`;
  renderApplicationList(root, items, '当前条件没有匹配的应用。');
}

function focusedApplications() {
  const keywords = Array.isArray(state.config?.process_package_keywords) ? state.config.process_package_keywords.map(value => String(value).trim().toLowerCase()).filter(Boolean) : [];
  const watched = new Set(watchedPackages());
  return state.appManager.items.filter(item => watched.has(item.package) || keywords.some(keyword => item.package.toLowerCase().includes(keyword)));
}

function renderFocusedApplications() {
  const root = $('#processList');
  if (!root) return;
  renderApplicationList(root, focusedApplications(), '尚未关注应用，请在“应用管理”点击星标或配置关键词规则。');
}

async function toggleWatchedPackage(packageName) {
  const packages = new Set(watchedPackages());
  const removing = packages.delete(packageName);
  if (!removing) packages.add(packageName);
  try {
    await saveConfigDomain('processes', {watched_packages: [...packages]});
    renderApplications();
    renderFocusedApplications();
    const keywordMatched = matchingWatchKeywords(packageName).length > 0;
    toast(removing && keywordMatched ? '已取消手动关注；该应用仍符合关键词规则' : removing ? '已取消关注' : '已添加到关注应用');
  } catch (error) { toast(error.message, true); }
}

async function loadApplications(force = false) {
  const root = $('#appManagerList');
  if (!root) return;
  if (force || !state.appManager.loaded || state.appManager.serial !== selectedAdbSerial()) root.innerHTML = '<div class="process-row">正在批量读取设备应用…</div>';
  try { await fetchApplications(force); renderApplications(); }
  catch (error) { root.innerHTML = `<div class="process-row">${escapeHtml(error.message)}</div>`; }
}

async function loadProcesses(force = false) {
  const root = $('#processList');
  if (!root) return;
  if (force || !state.appManager.loaded || state.appManager.serial !== selectedAdbSerial()) root.innerHTML = '<div class="process-row">正在批量读取设备应用…</div>';
  try { await fetchApplications(force); renderFocusedApplications(); }
  catch (error) { root.innerHTML = `<div class="process-row">${escapeHtml(error.message)}</div>`; }
}

async function openApplicationDetails(packageName) {
  openFeatureModal('app-details', `应用详情：${packageName}`, `<div class="app-detail-loading" aria-live="polite">
    <div class="app-detail-loading-heading"><span class="app-detail-spinner"></span><b>正在读取应用详情…</b></div>
    <div class="app-detail-loading-grid">${Array.from({length: 8}, () => '<i></i>').join('')}</div>
  </div>`, {hideFooter: true});
  try {
    const item = state.appManager.items.find(value => value.package === packageName) || {};
    const detail = await api(`/api/apps/details?serial=${encodeURIComponent(selectedAdbSerial())}&package=${encodeURIComponent(packageName)}`);
    if (state.featureConfigKind !== 'app-details') return;
    state.appManager.details[packageName] = detail;
    const enabledText = detail.enabled ? '已启用' : '已禁用';
    const signatureText = {platform: '平台签名匹配', non_platform: '非平台签名', unknown: '签名未知'}[detail.signature_status] || '签名未知';
    $('#configModalBody').innerHTML = `<div class="app-detail-grid">
      <section><span>包名</span><code>${escapeHtml(packageName)}</code></section>
      <section><span>应用类型</span><b>${item.kind === 'user' ? '用户应用' : '系统应用'}</b></section>
      <section><span>版本</span><b>${escapeHtml(detail.version_name || '未知')} ${detail.version_code ? `(${escapeHtml(detail.version_code)})` : ''}</b></section>
      <section><span>UID</span><b>${escapeHtml(detail.uid || item.uid || '未知')}</b></section>
      <section><span>状态</span><b>${enabledText}${item.running ? ' · 运行中' : ' · 未运行'}</b></section>
      <section><span>平台签名</span><b>${signatureText}</b><small>应用类型表示安装位置；平台签名表示证书是否与 android 包一致，两者不是同一概念。</small></section>
      <section><span>安装时间</span><b>${escapeHtml(detail.first_install_time || '未知')}</b></section>
      <section><span>更新时间</span><b>${escapeHtml(detail.last_update_time || '未知')}</b></section>
      <section class="app-detail-wide"><span>APK 路径</span><code>${escapeHtml((detail.apk_paths || []).join('\n') || '未知')}</code></section>
    </div><div class="app-certificate-result" id="appManagerCertificateResult"><span>签名证书 SHA-256</span><small>尚未计算</small></div><div class="app-detail-progress" id="appManagerActionProgress" hidden><span></span><i></i></div><div class="app-detail-actions">
      <section class="app-detail-action-group"><span>常用操作</span><div><button class="button primary" onclick="runApplicationAction('launch','${escapeHtml(packageName)}')">启动</button><button class="button subtle" onclick="runApplicationAction('stop','${escapeHtml(packageName)}')">强制停止</button><button class="button subtle" onclick="runApplicationAction('pull-apk','${escapeHtml(packageName)}',undefined,this)">Pull APK</button><button class="button subtle" id="appManagerCertificateButton" onclick="calculateApplicationCertificate('${escapeHtml(packageName)}',this)">证书 SHA-256</button><button class="button subtle" id="appSpecialLaunchButton" data-package="${escapeHtml(packageName)}" onclick="openApplicationLaunchConfig('${escapeHtml(packageName)}')">${detail.launch_configured ? '编辑特殊拉起' : '特殊拉起配置'}</button></div></section>
      <section class="app-detail-action-group app-detail-danger"><span>应用状态</span><div><button class="button subtle" onclick="runApplicationAction('enabled','${escapeHtml(packageName)}',${detail.enabled ? 'false' : 'true'})">${detail.enabled ? '禁用' : '启用'}</button><button class="button danger" onclick="runApplicationAction('clear','${escapeHtml(packageName)}')">清除数据</button><button class="button danger" onclick="runApplicationAction('uninstall','${escapeHtml(packageName)}')">卸载</button></div></section>
    </div>`;
  } catch (error) {
    if (state.featureConfigKind === 'app-details') $('#configModalBody').innerHTML = `<p class="user-guide-error">${escapeHtml(error.message)}</p>`;
  }
}

function openApplicationLaunchConfig(packageName) {
  pushFeatureModalView();
  openProcessLaunchConfig(packageName);
}

async function copyApplicationCertificate(button) {
  const value = button?.dataset.copyValue || '';
  if (!value) return;
  const copied = await copyTextToClipboard(value);
  toast(copied ? '证书 SHA-256 已复制到剪贴板' : '复制失败，请手动选择摘要复制', !copied);
}

async function calculateApplicationCertificate(packageName, button) {
  const root = $('#appManagerCertificateResult');
  button.disabled = true;
  button.textContent = '验签中…';
  if (root) root.innerHTML = '<span>签名证书 SHA-256</span><small>正在临时 Pull base.apk 并验签…</small>';
  try {
    const result = await api('/api/processes/cert-sha256', {method: 'POST', body: JSON.stringify(withAdbSerial({package: packageName}))});
    if (!root) return;
    root.innerHTML = '<span>签名证书 SHA-256 · 点击摘要复制</span>' + (result.warning ? `<small class="warning-text">${escapeHtml(result.warning)}</small>` : '') + result.certificates.map(item => `<button class="app-certificate-value" type="button" data-copy-value="${escapeHtml(item.sha256)}" onclick="copyApplicationCertificate(this)"><b>Signer #${item.signer}</b><code>${escapeHtml(item.sha256)}</code><small>${escapeHtml(item.dn || '未提供证书 DN')}</small></button>`).join('');
    toast('证书 SHA-256 已计算');
  } catch (error) {
    if (root) root.innerHTML = `<span>签名证书 SHA-256</span><small class="warning-text">${escapeHtml(error.message)}</small>`;
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '重新计算证书';
  }
}

function setApplicationActionProgress(button, message = '') {
  const progress = $('#appManagerActionProgress');
  if (button) {
    if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
    button.disabled = Boolean(message);
    button.textContent = message ? '正在 Pull…' : button.dataset.idleText;
  }
  if (!progress) return;
  progress.hidden = !message;
  const label = progress.querySelector('span');
  if (label) label.textContent = message;
}

async function runApplicationAction(action, packageName, enabled, button) {
  const messages = {
    clear: `确认清除“${packageName}”的全部应用数据？此操作不可恢复。`,
    uninstall: `确认卸载“${packageName}”？应用及设备端数据将被删除。`,
    enabled: enabled === false ? `确认禁用“${packageName}”？这可能影响依赖它的系统功能。` : '',
  };
  const requiresConfirmation = Boolean(messages[action]);
  if (requiresConfirmation && !confirm(messages[action])) return;
  if (action === 'pull-apk') setApplicationActionProgress(button, '正在从设备 Pull base.apk，请稍候…');
  try {
    const body = withAdbSerial({package: packageName, confirmed: requiresConfirmation});
    if (action === 'enabled') body.enabled = enabled;
    const result = await api(`/api/apps/${action}`, {method: 'POST', body: JSON.stringify(body)});
    if (result.requires_confirmation) return toast(result.message, true);
    if (action === 'pull-apk') {
      const link = document.createElement('a');
      link.href = result.url;
      link.download = result.name;
      link.click();
      toast(`APK 已 Pull，正在选择保存位置：${result.name}`);
    } else {
      toast(result.output || '操作完成', !result.ok);
      closeFeatureConfig();
      await fetchApplications(true);
      state.appManager.tab === 'processes' ? renderFocusedApplications() : renderApplications();
    }
  } catch (error) { toast(error.message, true); }
  finally {
    if (action === 'pull-apk') setApplicationActionProgress(button);
  }
}

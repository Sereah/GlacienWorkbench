let persistedConfigSnapshot = null;
const configDomainFields = {
  app: ['port'], adb: ['sdk_root'], apk_center: ['apk_sources', 'apk_push_device_paths'],
  signing: ['signing'], resources: ['resource_device_paths'], processes: ['process_package_keywords', 'watched_packages', 'app_launches'],
  broadcasts: ['broadcasts'], live_logs: ['log_filters'], offline_logs: ['offline_filter_presets', 'offline_log_sources'],
  device_logs: ['device_log_sources'], commands: ['adb_commands', 'adb_command_categories'], captures: ['scrcpy_path'],
  audio_processing: ['ffmpeg_path', 'audio_sample_format', 'audio_sample_rate', 'audio_channels'], themes: ['selected_theme'],
};

function cloneConfig(value) { return JSON.parse(JSON.stringify(value)); }
function sameConfigValue(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

async function saveLegacyConfigByDomain(body) {
  if (!persistedConfigSnapshot) throw new Error('配置基线尚未加载，请刷新页面后重试');
  const knownFields = new Set(Object.values(configDomainFields).flat());
  const unknown = Object.keys(body).filter(key => key !== '_meta' && !knownFields.has(key));
  if (unknown.length) throw new Error('配置字段尚未登记稳定存储域：' + unknown.join('、'));
  const changed = Object.entries(configDomainFields).filter(([, fields]) => fields.some(field => Object.prototype.hasOwnProperty.call(body, field) && !sameConfigValue(body[field], persistedConfigSnapshot[field])));
  let result = {ok: true, config: persistedConfigSnapshot};
  for (const [domain, fields] of changed) {
    const values = Object.fromEntries(fields.filter(field => Object.prototype.hasOwnProperty.call(body, field)).map(field => [field, body[field]]));
    result = await api('/api/config/domain', {method: 'POST', body: JSON.stringify({domain, values})});
    persistedConfigSnapshot = cloneConfig(result.config);
  }
  return result;
}

async function api(path, options = {}) {
  if (path === '/api/config' && String(options.method || 'GET').toUpperCase() === 'POST') return saveLegacyConfigByDomain(JSON.parse(options.body || '{}'));
  const response = await fetch(path, {headers: {'Content-Type': 'application/json'}, ...options});
  const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : {};
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  if (path === '/api/config' && String(options.method || 'GET').toUpperCase() === 'GET') persistedConfigSnapshot = cloneConfig(payload);
  if (payload.config) persistedConfigSnapshot = cloneConfig(payload.config);
  return payload;
}

async function saveConfigDomain(domain, values) {
  const result = await api('/api/config/domain', {method: 'POST', body: JSON.stringify({domain, values})});
  state.config = result.config || await api('/api/config');
  return result;
}
function saveCommandConfig() { return saveConfigDomain('commands', {adb_commands: state.config.adb_commands || {}, adb_command_categories: state.config.adb_command_categories || []}); }
function selectedAdbSerial() { return state.adbSerial || ''; }
function withAdbSerial(body = {}) { return {...body, serial: selectedAdbSerial()}; }
function apiPathWithSerial(path) { const separator = path.includes('?') ? '&' : '?'; return path + separator + 'serial=' + encodeURIComponent(selectedAdbSerial()); }

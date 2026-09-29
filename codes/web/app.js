// 无框架前端的全局状态：logs 必须保存当前 EventSource，停止/切换规则时要关闭它。
const state = { config: null, apks: [], resources: [], logs: null, logRule: {}, logCount: 0, page: 'home', adbSerial: localStorage.getItem('glacien.adb.serial') || '', adbSelectionRequired: false, offline: { files: [], results: [], rendered: 0, skipped: 0, worker: null, scanning: false, totalBytes: 0, sources: [] }, audio: {files:[], selected:'', previewUrl:''}, deviceLogs: { sources: {}, files: [], result: null, pulling: false }, captures: { screenshot:null, recording:null, recordingState:'idle', scrcpyAvailable:false, timer:null, capability:'screenshot', displays:[], continuous:null, compareItems:[], library:{kind:'all',offset:0,items:[],hasMore:false} }, deviceFiles: { tab: 'captures', path: '/sdcard', parent: '', entries: [], loading: false, previewRequest: 0 }, adbOperationTab: 'commands', offlinePreset: { loadedName: '', baseline: '' }, logPreset: { loadedName: '', baseline: '' }, command: { loadedName: '', baseline: '', result: null } };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let persistedConfigSnapshot = null;
const configDomainFields = {
  app:['port'], adb:['sdk_root'], apk_center:['apk_sources','apk_push_device_paths'],
  signing:['signing'], resources:['resource_device_paths'], processes:['process_package_keywords','app_launches'],
  broadcasts:['broadcasts'], live_logs:['log_filters'], offline_logs:['offline_filter_presets','offline_log_sources'],
  device_logs:['device_log_sources'], commands:['adb_commands','adb_command_categories'], captures:['scrcpy_path'],
  audio_processing:['ffmpeg_path','audio_sample_format','audio_sample_rate','audio_channels'], themes:['selected_theme'],
};
let desktopBridge=null;
function initializeDesktopBridge(){
  if(typeof QWebChannel==='undefined'||!window.qt?.webChannelTransport)return;
  new QWebChannel(window.qt.webChannelTransport,channel=>{desktopBridge=channel.objects.glacienDesktop||null;document.documentElement.classList.toggle('desktop-host',Boolean(desktopBridge));});
}
initializeDesktopBridge();
function cloneConfig(value){return JSON.parse(JSON.stringify(value))}
function sameConfigValue(left,right){return JSON.stringify(left)===JSON.stringify(right)}
async function saveLegacyConfigByDomain(body){
  if(!persistedConfigSnapshot)throw new Error('配置基线尚未加载，请刷新页面后重试');
  const knownFields=new Set(Object.values(configDomainFields).flat()),unknown=Object.keys(body).filter(key=>key!=='_meta'&&!knownFields.has(key));
  if(unknown.length)throw new Error('配置字段尚未登记稳定存储域：'+unknown.join('、'));
  const changed=Object.entries(configDomainFields).filter(([,fields])=>fields.some(field=>Object.prototype.hasOwnProperty.call(body,field)&&!sameConfigValue(body[field],persistedConfigSnapshot[field])));
  let result={ok:true,config:persistedConfigSnapshot};
  for(const [domain,fields] of changed){
    const values=Object.fromEntries(fields.filter(field=>Object.prototype.hasOwnProperty.call(body,field)).map(field=>[field,body[field]]));
    result=await api('/api/config/domain',{method:'POST',body:JSON.stringify({domain,values})});
    persistedConfigSnapshot=cloneConfig(result.config);
  }
  return result;
}

// 所有 JSON API 的统一错误处理入口。SSE 不使用此函数。
async function api(path, options = {}) {
  if(path==='/api/config'&&String(options.method||'GET').toUpperCase()==='POST'){
    return saveLegacyConfigByDomain(JSON.parse(options.body||'{}'));
  }
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : {};
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  if(path==='/api/config'&&String(options.method||'GET').toUpperCase()==='GET')persistedConfigSnapshot=cloneConfig(payload);
  if(payload.config)persistedConfigSnapshot=cloneConfig(payload.config);
  return payload;
}
async function saveConfigDomain(domain, values) {
  const result = await api('/api/config/domain', {method:'POST', body:JSON.stringify({domain, values})});
  state.config = result.config || await api('/api/config');
  return result;
}
function saveCommandConfig(){return saveConfigDomain('commands',{adb_commands:state.config.adb_commands||{},adb_command_categories:state.config.adb_command_categories||[]})}

function toast(message, error = false) {
  const el = $('#toast'); el.textContent = message; el.className = `toast visible${error ? ' error' : ''}`;
  clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => el.className = 'toast', 3400);
}

async function copyTextToClipboard(text) {
  const textarea = document.createElement('textarea');
  const previousFocus = document.activeElement;
  textarea.value = String(text);
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try { copied = Boolean(document.execCommand?.('copy')); } catch (error) { copied = false; }
  textarea.remove();
  previousFocus?.focus?.();
  if (copied) return true;
  if (!navigator.clipboard?.writeText) return false;
  try { await navigator.clipboard.writeText(String(text)); return true; } catch (error) { return false; }
}

function escapeHtml(value) {
  const node = document.createElement('span'); node.textContent = value ?? ''; return node.innerHTML;
}

function formatSize(bytes) {
  if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const p = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / 1024 ** p).toFixed(p ? 1 : 0)} ${units[p]}`;
}

function audioRequestBody(){
  return {id:state.audio.selected,sample_format:$('#audioSampleFormat').value,sample_rate:Number($('#audioSampleRate').value),channels:Number($('#audioChannels').value),mode:$('#audioMode').value,channel:Number($('#audioChannel').value||1)};
}
function renderAudioFiles(){
  const root=$('#audioFileList');if(!root)return;
  if(!state.audio.files.length){root.innerHTML='<p class="page-description">尚未导入 PCM 文件。</p>';return;}
  root.innerHTML=state.audio.files.map(file=>`<div class="audio-file-row ${file.id===state.audio.selected?'active':''}" onclick="selectPcm('${file.id}')"><div><b>${escapeHtml(file.name)}</b><small>${formatSize(file.size)}</small></div><button class="audio-file-delete" type="button" title="删除" onclick="event.stopPropagation();deletePcm('${file.id}')">删除</button></div>`).join('');
}
function selectPcm(id){state.audio.selected=id;renderAudioFiles();audioParametersChanged();}
function audioModeChanged(){
  const channels=Math.max(1,Math.min(32,Number($('#audioChannels').value)||1));
  $('#audioChannelField').hidden=$('#audioMode').value!=='channel';
  $('#audioChannel').innerHTML=Array.from({length:channels},(_,index)=>`<option value="${index+1}">通道 ${index+1}</option>`).join('');
  audioParametersChanged();
}
async function audioParametersChanged(){
  const file=state.audio.files.find(item=>item.id===state.audio.selected),button=$('#audioPreviewButton');
  button.disabled=!file;$('#audioSelectionStatus').textContent=file?file.name:'请先选择文件';
  if(!file){$('#audioDuration').textContent='选择文件后计算预计时长。';return;}
  try{const result=await api('/api/audio/estimate',{method:'POST',body:JSON.stringify(audioRequestBody())});$('#audioDuration').textContent=`预计时长 ${result.duration_seconds.toFixed(3)} 秒 · ${formatSize(file.size)}${result.trailing_bytes?` · 尾部有 ${result.trailing_bytes} 字节不完整采样帧`:''}`;}catch(error){$('#audioDuration').textContent=error.message;}
  if(state.audio.previewUrl){URL.revokeObjectURL?.(state.audio.previewUrl);state.audio.previewUrl='';}
  $('#audioPlayer').removeAttribute('src');$('#audioPlayer').load();
}
async function loadAudioPage(){
  try{
    const [status,result]=await Promise.all([api('/api/audio/status'),api('/api/audio/files')]);
    $('#ffmpegStatus').textContent=status.available?'FFmpeg 已就绪':'未检测到 FFmpeg';
    $('#ffmpegPath').textContent=status.available?`${status.version} · ${status.path}`:(status.error||'请安装 FFmpeg，或配置 ffmpeg 可执行文件绝对路径。');
    $('#audioFfmpegInput').value=status.configured_path||'';
    state.audio.files=result.items||[];
    if(state.audio.selected&&!state.audio.files.some(file=>file.id===state.audio.selected))state.audio.selected='';
    if(!state.audio.selected&&state.audio.files.length)state.audio.selected=state.audio.files[0].id;
    if(state.config){$('#audioSampleFormat').value=state.config.audio_sample_format||'s16le';$('#audioSampleRate').value=String(state.config.audio_sample_rate||48000);$('#audioChannels').value=state.config.audio_channels||2;}
    renderAudioFiles();audioModeChanged();
  }catch(error){toast(error.message,true);}
}
async function configureFfmpeg(){
  const path=$('#audioFfmpegInput').value.trim();
  try{const result=await api('/api/audio/ffmpeg/path',{method:'POST',body:JSON.stringify({path})});state.config.ffmpeg_path=result.configured_path||'';toast(result.available?(path?'FFmpeg 配置已保存':'已恢复 FFmpeg 自动探测'):'已清除路径，但自动探测仍未找到 FFmpeg',!result.available);await loadAudioPage();}catch(error){toast(error.message,true);}
}
async function uploadPcm(files){
  const input=$('#audioUpload');if(!files?.length)return;const data=new FormData();data.append('file',files[0]);
  try{const response=await fetch('/api/audio/upload',{method:'POST',body:data});const result=await response.json();if(!response.ok)throw new Error(result.error||'上传失败');state.audio.selected=result.file.id;toast('PCM 文件已导入');await loadAudioPage();}catch(error){toast(error.message,true);}finally{input.value='';}
}
async function generatePcmPreview(){
  if(!state.audio.selected)return;const button=$('#audioPreviewButton');button.disabled=true;button.textContent='正在生成预览…';
  try{const result=await api('/api/audio/preview',{method:'POST',body:JSON.stringify(audioRequestBody())});const player=$('#audioPlayer');player.src=result.url;player.load();await player.play().catch(()=>{});toast(`已生成 ${result.duration_seconds.toFixed(3)} 秒播放预览`);state.config.audio_sample_format=$('#audioSampleFormat').value;state.config.audio_sample_rate=Number($('#audioSampleRate').value);state.config.audio_channels=Number($('#audioChannels').value);}catch(error){toast(error.message,true);}finally{button.textContent='生成播放预览';button.disabled=!state.audio.selected;}
}
async function deletePcm(id){if(!confirm('确认删除这个 PCM 文件？'))return;try{await api('/api/audio/delete',{method:'POST',body:JSON.stringify({id})});if(state.audio.selected===id)state.audio.selected='';toast('PCM 文件已删除');await loadAudioPage();}catch(error){toast(error.message,true);}}

function selectedAdbSerial() { return state.adbSerial || ''; }
function withAdbSerial(body = {}) { return {...body, serial: selectedAdbSerial()}; }
function apiPathWithSerial(path) { const separator = path.includes('?') ? '&' : '?'; return path + separator + 'serial=' + encodeURIComponent(selectedAdbSerial()); }
function pageMeta(id) { return ({ home:['WORKBENCH','首页'], 'adb-overview':['ADB WORKSPACE','ADB 概览'], apks:['DEPLOYMENT CENTER','部署中心'], processes:['RUNTIME','进程管理'], logs:['LOGCAT STREAM','实时日志'], 'offline-logs':['LOCAL FILE FILTER','离线日志分析'], 'audio-processing':['PCM AUDIO PLAYER','音频处理'], 'device-tools':['DEVICE UTILITIES','设备工具'], commands:['ADB COMMANDS','ADB 命令'], settings:['LOCAL CONFIGURATION','设置'] })[id]; }
const navGroupStorageKey='glacien.nav.groups';
const themeStorageKey='glacien.theme';
const themeColorPattern=/^(#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?[(][^;{}]+[)]|hsla?[(][^;{}]+[)])$/i;
const deprecatedThemeCssVariables=['--highlight-violet','--highlight-cyan','--highlight-green','--highlight-yellow','--highlight-orange','--highlight-red','--on-highlight'];
let themeCatalog={schemaVersion:1,defaultTheme:'glacien',guide:{},tokenGuide:{},themes:{glacien:{name:'Glacien 深紫',description:'默认主题',mode:'dark',preview:[],colors:{}}}};
function validateThemeCatalog(value){
  if(!value||value.schemaVersion!==1||!value.tokenGuide||!value.themes)throw new Error('themes.json 结构无效');
  const tokens=Object.entries(value.tokenGuide).filter(([,item])=>item&&/^--[a-z0-9-]+$/i.test(item.cssVariable||''));
  if(!tokens.length)throw new Error('themes.json 没有有效颜色令牌');
  const catalogThemes={};
  for(const [id,item] of Object.entries(value.themes)){
    if(!/^[a-z0-9][a-z0-9_-]*$/i.test(id)||!item||typeof item.colors!=='object')continue;
    const colors={};
    for(const [token] of tokens){const color=String(item.colors[token]||'').trim();if(themeColorPattern.test(color))colors[token]=color;}
    if(Object.keys(colors).length)catalogThemes[id]={name:String(item.name||id),description:String(item.description||''),mode:item.mode==='light'?'light':'dark',preview:Array.isArray(item.preview)?item.preview.slice(0,3):[],colors};
  }
  const defaultTheme=Object.prototype.hasOwnProperty.call(catalogThemes,value.defaultTheme)?value.defaultTheme:Object.keys(catalogThemes)[0];
  if(!defaultTheme)throw new Error('themes.json 没有可用主题');
  const fallbackColors={};
  for(const [token] of tokens){const color=String(value.fallbackColors?.[token]||'').trim();if(themeColorPattern.test(color))fallbackColors[token]=color;}
  const userThemes=Array.isArray(value.userThemes)?value.userThemes.filter(id=>Object.prototype.hasOwnProperty.call(catalogThemes,id)):[];
  const selectedTheme=Object.prototype.hasOwnProperty.call(catalogThemes,value.selectedTheme)?value.selectedTheme:'';
  return {schemaVersion:1,guide:value.guide||{},tokenGuide:Object.fromEntries(tokens),themes:catalogThemes,defaultTheme,fallbackColors,userThemes,selectedTheme};
}
async function loadThemeCatalog(){try{themeCatalog=validateThemeCatalog(await api('/api/themes'));}catch(error){console.error('主题配置加载失败，使用 CSS 默认主题：',error);}const legacyTheme=localStorage.getItem(themeStorageKey)||'';applyTheme(themeCatalog.selectedTheme||legacyTheme||themeCatalog.defaultTheme,false,false);if(!themeCatalog.selectedTheme&&legacyTheme&&Object.prototype.hasOwnProperty.call(themeCatalog.themes,legacyTheme))persistThemeSelection(legacyTheme,false)}
function activeTheme(){const name=document.documentElement.dataset.theme;return Object.prototype.hasOwnProperty.call(themeCatalog.themes,name)?name:themeCatalog.defaultTheme}
function resolvedThemeColors(name){
  const defaultColors=themeCatalog.themes[themeCatalog.defaultTheme]?.colors||{},selectedColors=themeCatalog.themes[name]?.colors||{};
  const resolved={...(themeCatalog.fallbackColors||{}),...defaultColors,...selectedColors};
  for(const [token,guide] of Object.entries(themeCatalog.tokenGuide)){
    const fallbackToken=guide?.fallbackToken;
    if(!selectedColors[token]&&fallbackToken&&selectedColors[fallbackToken])resolved[token]=selectedColors[fallbackToken];
  }
  return resolved;
}
async function persistThemeSelection(selected,showError=true){try{await api('/api/config/domain',{method:'POST',body:JSON.stringify({domain:'themes',values:{selected_theme:selected}})});themeCatalog.selectedTheme=selected}catch(error){if(showError)toast('主题偏好保存失败：'+error.message,true)}}
function applyTheme(name,notify=true,persist=true){const selected=Object.prototype.hasOwnProperty.call(themeCatalog.themes,name)?name:themeCatalog.defaultTheme,root=document.documentElement,theme=themeCatalog.themes[selected];for(const variable of deprecatedThemeCssVariables)root.style.removeProperty(variable);for(const [token,color] of Object.entries(resolvedThemeColors(selected))){const variable=themeCatalog.tokenGuide[token]?.cssVariable;if(variable)root.style.setProperty(variable,color)}root.dataset.theme=selected;root.dataset.themeMode=theme.mode;root.style.colorScheme=theme.mode;localStorage.setItem(themeStorageKey,selected);if(persist)persistThemeSelection(selected);updateThemeButton();if(state.featureConfigKind==='theme-picker')renderThemePicker();if(notify)toast('已切换到“'+theme.name+'”')}
function updateThemeButton(){const label=$('#themeButtonLabel'),theme=themeCatalog.themes[activeTheme()];if(label&&theme)label.textContent='主题 · '+theme.name}
function themePreviewColors(id,theme){const colors=resolvedThemeColors(id);return (theme.preview||[]).map(token=>colors[token]).filter(Boolean).slice(0,3)}
function isUserTheme(id){return themeCatalog.userThemes?.includes(id)}
function themeCard(id,theme){
  const selected=id===activeTheme(),swatches=themePreviewColors(id,theme).map(color=>'<i style="background:'+escapeHtml(color)+'"></i>').join('');
  const deleteButton=isUserTheme(id)?'<button class="button danger theme-delete" type="button" data-theme-id="'+escapeHtml(id)+'" onclick="deleteTheme(this.dataset.themeId)">删除</button>':'';
  return '<article class="theme-card'+(selected?' selected':'')+'"><button class="theme-card-select" type="button" data-theme-id="'+escapeHtml(id)+'" onclick="applyTheme(this.dataset.themeId)"><span class="theme-swatches">'+swatches+'</span><span class="theme-card-copy"><b>'+escapeHtml(theme.name)+'</b><small>'+escapeHtml(theme.description)+'</small></span><em>'+(selected?'当前使用':isUserTheme(id)?'用户主题':'内置主题')+'</em></button><div class="theme-card-actions"><button class="button subtle theme-export" type="button" data-theme-id="'+escapeHtml(id)+'" onclick="exportTheme(this.dataset.themeId)">导出 JSON</button>'+deleteButton+'</div></article>'
}
function renderThemePicker(){const body=$('#configModalBody');if(!body)return;body.innerHTML='<div class="theme-picker"><div class="theme-picker-heading"><p class="page-description">内置主题随程序提供。导入的主题保存在用户数据目录，可继续导出修改或交给 Agent 重新设计。</p><div class="theme-picker-actions"><label class="button primary upload-button">导入主题 JSON<input id="themeImport" type="file" accept="application/json,.json" onchange="importTheme(this.files)"></label><button class="button subtle" type="button" onclick="exportTheme(activeTheme())">导出当前主题</button></div></div><div class="theme-grid">'+Object.entries(themeCatalog.themes).map(([id,theme])=>themeCard(id,theme)).join('')+'</div></div>'}
function exportTheme(id){const theme=themeCatalog.themes[id];if(!theme)return toast('主题不存在',true);const output={schemaVersion:themeCatalog.schemaVersion,guide:{...themeCatalog.guide,exportNote:'这是可直接导入的单主题配置。导入前请修改 themes 下的主题 ID；内置主题 ID 不允许覆盖。'},defaultTheme:id,fallbackColors:themeCatalog.fallbackColors||{},tokenGuide:themeCatalog.tokenGuide,themes:{[id]:{...theme,colors:resolvedThemeColors(id)}}};downloadSharedBlobV2(output,'glacien-theme-'+id+'.json');toast('已导出主题：'+theme.name)}
async function importTheme(files){
  const input=$('#themeImport'),file=files?.[0];
  if(!file)return;
  try{
    const document=JSON.parse(await file.text());
    let result=await api('/api/themes/import',{method:'POST',body:JSON.stringify({document,overwrite:false})});
    if(result.requires_confirmation){
      if(!confirm('用户主题“'+result.name+'”已存在，是否覆盖？'))return;
      result=await api('/api/themes/import',{method:'POST',body:JSON.stringify({document,overwrite:true})});
    }
    await loadThemeCatalog();
    applyTheme(result.id,false);
    renderThemePicker();
    toast((result.overwritten?'已覆盖':'已导入')+'主题：'+result.name);
  }catch(error){toast('导入主题失败：'+error.message,true)}finally{if(input)input.value=''}
}
async function deleteTheme(id){
  const theme=themeCatalog.themes[id];
  if(!theme||!isUserTheme(id))return toast('只能删除用户导入的主题',true);
  if(!confirm('确定删除用户主题“'+theme.name+'”吗？'))return;
  try{
    const wasActive=id===activeTheme();
    await api('/api/themes/delete',{method:'POST',body:JSON.stringify({id})});
    if(wasActive)localStorage.setItem(themeStorageKey,themeCatalog.defaultTheme);
    await loadThemeCatalog();
    renderThemePicker();
    toast('已删除主题：'+theme.name);
  }catch(error){toast('删除主题失败：'+error.message,true)}
}
async function openThemePicker(){openFeatureModal('theme-picker','切换界面主题','<p class="user-guide-loading">正在读取主题配置…</p>',{hideFooter:true});await loadThemeCatalog();renderThemePicker()}
function markdownInline(value){let text=escapeHtml(value);text=text.replace(/`([^`]+)`/g,'<code>$1</code>');return text.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')}
function renderMarkdown(markdown){const lines=String(markdown||'').replace(/\r\n?/g,'\n').split('\n'),output=[];let paragraph=[],list='',inCode=false,code=[];const flushParagraph=()=>{if(paragraph.length){output.push('<p>'+paragraph.map(markdownInline).join('<br>')+'</p>');paragraph=[]}};const closeList=()=>{if(list){output.push('</'+list+'>');list=''}};for(const raw of lines){const line=raw.trimEnd();if(line.startsWith('```')){flushParagraph();closeList();if(inCode){output.push('<pre><code>'+escapeHtml(code.join('\n'))+'</code></pre>');code=[]}inCode=!inCode;continue}if(inCode){code.push(raw);continue}if(!line.trim()){flushParagraph();closeList();continue}const heading=line.match(/^(#{1,3})\s+(.+)$/);if(heading){flushParagraph();closeList();const level=heading[1].length;output.push('<h'+level+'>'+markdownInline(heading[2])+'</h'+level+'>');continue}if(/^s*(---+|___+|\*\*\*+)s*$/.test(line)){flushParagraph();closeList();output.push('<hr>');continue}const unordered=line.match(/^\s*[-*+]\s+(.+)$/),ordered=line.match(/^\s*\d+[.)]\s+(.+)$/),nextList=unordered?'ul':ordered?'ol':'';if(nextList){flushParagraph();if(list&&list!==nextList)closeList();if(!list){list=nextList;output.push('<'+list+'>')}output.push('<li>'+markdownInline((unordered||ordered)[1])+'</li>');continue}closeList();paragraph.push(line.trim())}if(inCode)output.push('<pre><code>'+escapeHtml(code.join('\n'))+'</code></pre>');flushParagraph();closeList();return '<div class="markdown-body">'+output.join('')+'</div>'}
async function openUserGuide(){openFeatureModal('user-guide','用户须知','<p class="user-guide-loading">正在读取用户须知…</p>',{hideFooter:true});try{const result=await api('/api/user-guide');if(state.featureConfigKind==='user-guide')$('#configModalBody').innerHTML=renderMarkdown(result.markdown)}catch(error){if(state.featureConfigKind==='user-guide')$('#configModalBody').innerHTML='<p class="user-guide-error">'+escapeHtml(error.message)+'</p>'}}
function savedNavGroups(){try{const value=JSON.parse(localStorage.getItem(navGroupStorageKey)||'{}');return value&&typeof value==='object'?value:{}}catch(error){return {}}}
function restoreNavGroups(){const saved=savedNavGroups();for(const group of $$('.nav-group')){const name=group.dataset.navGroup;if(Object.prototype.hasOwnProperty.call(saved,name))group.classList.toggle('expanded',Boolean(saved[name]));}}
function toggleNavGroup(name,expanded){const group=$(`.nav-group[data-nav-group="${name}"]`);if(!group)return;group.classList.toggle('expanded',expanded===undefined?!group.classList.contains('expanded'):Boolean(expanded));const saved=savedNavGroups();saved[name]=group.classList.contains('expanded');localStorage.setItem(navGroupStorageKey,JSON.stringify(saved));}
function expandActiveNavGroup(id){const item=$(`.nav-item[data-page="${id}"]`),group=item?.closest('.nav-group');if(group&&!group.classList.contains('expanded'))toggleNavGroup(group.dataset.navGroup,true)}
function updateLogRuleToggleSummary(){}

function createWorkspaceTabs(items){
  const tabs=document.createElement('div');
  tabs.className='workspace-tabs';
  for(const item of items){
    const button=document.createElement('button');
    button.type='button';
    button.className='workspace-tab'+(item.active?' active':'');
    button.dataset.workspaceTab=item.id;
    button.textContent=item.label;
    button.addEventListener('click',item.onClick);
    tabs.append(button);
  }
  return tabs;
}

function createWorkspacePanel(id,visible=false){
  const panel=document.createElement('div');
  panel.id=id;
  panel.className='workspace-tab-panel'+(visible?' visible':'');
  return panel;
}

function moveStandalonePage(sourceId,target){
  const source=$('#'+sourceId);
  if(!source||!target)return;
  source.classList.remove('page','visible');
  target.append(source);
}

// 保留原功能 DOM 和控件 ID，只调整侧栏层级以及三个聚合页的展示位置。
function reorganizeFeaturePages(){
  const apkPage=$('#apks');
  if(apkPage&&!$('#apk-tab-resources')){
    const tabs=apkPage.querySelector('.apk-tabs');
    const button=document.createElement('button');
    button.type='button';
    button.className='apk-tab';
    button.dataset.apkTab='resources';
    button.textContent='资源部署';
    button.addEventListener('click',()=>switchApkTab('resources'));
    tabs.append(button);
    const panel=document.createElement('div');
    panel.id='apk-tab-resources';
    panel.className='apk-subpage';
    apkPage.append(panel);
    moveStandalonePage('resources',panel);
  }

  const commandPage=$('#commands');
  if(commandPage&&!$('#adb-operation-commands')){
    const heading=[...commandPage.children].find(child=>child.classList.contains('section-heading'));
    const contents=[...commandPage.children].filter(child=>child!==heading);
    const tabs=createWorkspaceTabs([
      {id:'commands',label:'自定义命令',active:true,onClick:()=>selectAdbOperationTab('commands')},
      {id:'broadcast',label:'发送广播',onClick:()=>selectAdbOperationTab('broadcast')}
    ]);
    const commands=createWorkspacePanel('adb-operation-commands',true);
    const broadcast=createWorkspacePanel('adb-operation-broadcast');
    contents.forEach(child=>commands.append(child));
    commandPage.append(tabs,commands,broadcast);
    moveStandalonePage('broadcast',broadcast);
  }

  const deviceTabs=$('#device-tools .device-tool-tabs');
  if(deviceTabs&&!$('#device-tool-logs')){
    const button=document.createElement('button');
    button.type='button';
    button.className='device-tool-tab';
    button.dataset.deviceToolTab='logs';
    button.textContent='日志 Pull';
    button.addEventListener('click',()=>selectDeviceToolTab('logs'));
    deviceTabs.append(button);
    const panel=document.createElement('div');
    panel.id='device-tool-logs';
    panel.className='device-tool-panel';
    $('#device-tools').append(panel);
    moveStandalonePage('device-logs',panel);
  }
}

function renderAdbAccess(access={},online=false){
  const rooted=online&&Boolean(access.rooted),remounted=online&&Boolean(access.remounted),root=$('#adbRootButton'),remount=$('#adbRemountButton'),reboot=$('#adbRebootButton'),clearDevice=$('#logDeviceClearButton');
  root.textContent=rooted?'已 Root':'ADB Root';root.disabled=!online||rooted;root.classList.toggle('ready',rooted);
  remount.textContent=remounted?'已 Remount':'ADB Remount';remount.disabled=!online||!rooted||remounted;remount.classList.toggle('ready',remounted);
  reboot.disabled=!online;
  if(clearDevice){clearDevice.dataset.deviceOnline=String(online);clearDevice.disabled=!online;}
}

async function runAdbAccessAction(action){
  const button=action==='root'?$('#adbRootButton'):$('#adbRemountButton'),label=action==='root'?'Root':'Remount';
  button.disabled=true;button.textContent=label+' 中…';
  try{
    const result=await api('/api/adb/'+action,{method:'POST',body:JSON.stringify(withAdbSerial())});
    toast(result.message||('ADB '+label+(result.ok?' 完成':' 失败')),!result.ok);
  }catch(error){toast(error.message,true);}finally{await refreshStatus();}
}

async function rebootAdbDevice(){
  const serial=selectedAdbSerial();
  if(!serial||!confirm('确认重启当前设备 '+serial+'？\n\n设备会暂时断开，正在运行的 Logcat 也会停止。'))return;
  if(state.logs)stopLogs();
  const button=$('#adbRebootButton');button.disabled=true;button.textContent='重启中…';
  try{
    const result=await api('/api/adb/reboot',{method:'POST',body:JSON.stringify(withAdbSerial())});
    toast(result.message||'设备正在重启',!result.ok);
    if(result.ok)setTimeout(refreshStatus,1000);
  }catch(error){toast(error.message,true);}finally{button.textContent='重启设备';await refreshStatus();}
}

function navigate(id) {
  if (state.page === 'logs' && id !== 'logs') {if(!confirmDiscardLogRuleChanges('离开实时日志页面'))return;restoreLoadedLogRule();}
  if (state.page === id) return;
  if (state.page === 'offline-logs' && id !== 'offline-logs' && !confirmDiscardOfflinePresetChanges(`离开离线日志页面`)) return;
  if (state.page === 'commands' && id !== 'commands' && !confirmDiscardAdbCommandChanges('离开 ADB 命令页面')) return;
  if(state.page==='commands'&&id!=='commands'&&state.featureConfigKind==='command-editor')closeFeatureConfig();
  if(state.page==='device-tools'&&id!=='device-tools')stopContinuousCapture();
  state.page = id; document.querySelectorAll('.page').forEach(x => x.classList.toggle('visible', x.id === id));
  document.querySelectorAll('.nav-item[data-page]').forEach(x => x.classList.toggle('active', x.dataset.page === id));
  expandActiveNavGroup(id);
  if(id==='apks')switchApkTab(state.apkTab||'local');
  if(id==='processes')loadProcesses();
  if(id==='logs')loadLogFilters();
  if(id==='device-tools')selectDeviceToolTab(state.deviceFiles.tab||'captures');
  if(id==='commands')selectAdbOperationTab(state.adbOperationTab||'commands');
  if(id==='settings')renderSettings();
  if(id==='audio-processing')loadAudioPage();
}

async function refreshStatus() {
  try {
    const status = await api(apiPathWithSerial('/api/status')); const d = status.device;
    if (d.requested_serial && !d.selected_serial && d.state === 'offline') {
      state.adbSerial = '';
      localStorage.removeItem('glacien.adb.serial');
      return refreshStatus();
    }
    if (d.selected_serial && d.selected_serial !== state.adbSerial) { state.adbSerial = d.selected_serial; localStorage.setItem('glacien.adb.serial', state.adbSerial); }
    state.adbSelectionRequired = d.state === 'selection_required';
    renderAdbDeviceSelector(d);
    const online = d.state === 'online';
    $('#devicePill').classList.toggle('online', online); $('#devicePill span').textContent = online ? `${d.details.model} · Android ${d.details.android}` : (d.state === 'missing' ? '未找到 adb' : d.state === 'selection_required' ? '请选择设备' : '设备未连接');
    $('#deviceName').textContent = online ? d.details.model : (d.state === 'missing' ? '未找到 Android Debug Bridge' : d.state === 'selection_required' ? '请选择要操作的设备' : '正在等待 Android 设备');
    $('#deviceDescription').textContent = online ? `序列号 ${d.details.serial} · 已通过 ADB 连接，所有设备操作都会固定发送到这台设备。` : d.message;
    const access=d.details.access||{};renderAdbAccess(access,online);
    const cards = online ? [['状态','已连接'],['系统',`Android ${d.details.android}`],['API',`Level ${d.details.api}`],['ADB',status.adb ? 'Ready' : 'Missing']] : [['状态', d.state === 'missing' ? '需要配置' : d.state === 'selection_required' ? '待选择' : '未连接'],['平台',status.platform],['ADB',status.adb ? '已就绪' : '缺失'],['设备',d.requested_serial||'—']];
    $('#statGrid').innerHTML = cards.map(([label, value]) => `<div class="stat-card"><label>${label}</label><b>${escapeHtml(value)}</b></div>`).join('');
  } catch (e) { toast(e.message, true); }
}
function deviceDisplayName(item) { return `${item.model || item.product || item.serial} · ${item.serial}`; }
function renderAdbDeviceSelector(deviceStatus) {
  const card = $('#deviceSelectorCard'), select = $('#deviceSelect'), hint = $('#deviceSelectorHint');
  if (!card || !select) return;
  const devices = deviceStatus.devices || [], online = devices.filter(item => item.state === 'device');
  card.hidden = online.length === 0;
  if (!online.length) {
    select.replaceChildren();
    hint.textContent = '当前没有已连接的 ADB 设备。';
    return;
  }
  const placeholder = deviceStatus.state === 'selection_required' ? '<option value="" selected disabled>请选择一台已授权设备</option>' : '';
  select.innerHTML = placeholder + online.map(item => `<option value="${escapeHtml(item.serial)}">${escapeHtml(deviceDisplayName(item))} · ${escapeHtml(item.state)}</option>`).join('');
  const selected = deviceStatus.selected_serial || state.adbSerial;
  if (selected && [...select.options].some(option => option.value === selected)) select.value = selected;
  else if (deviceStatus.state === 'selection_required') select.value = '';
  hint.textContent = online.length > 1 ? '检测到多台已授权设备。请选择一台；之后所有设备操作都会固定发送到它。' : '当前设备选择仅保存在此浏览器，不会写入或分享 settings 配置。';
}
async function selectAdbDevice(serial) {
  if (!serial || serial === state.adbSerial) return;
  if (state.logs) stopLogs();
  state.adbSerial = serial; localStorage.setItem('glacien.adb.serial', serial);
  try { await refreshAll(); toast('已切换设备：' + serial); } catch (error) { toast(error.message, true); }
}
// 设备轮询只刷新状态；仅在“重新连接”边沿刷新页面，不能重建正在运行的日志 SSE。
async function monitorDevice(){try{const previous=state.deviceState;await refreshStatus();const current=$('#devicePill').classList.contains('online')?'online':'offline';state.deviceState=current;if(previous&&previous!==current){toast(current==='online'?'设备已连接，已刷新当前页面':'设备已断开连接',current!=='online');if(current==='online')await refreshAll();}}catch(e){/* 定时检查失败不打断页面操作 */}}

async function loadApks() {
  const list = $('#apkList'); list.innerHTML = '<div class="artifact-row">正在扫描构建产物…</div>';
  try {
    state.apks = await api('/api/apks');
    list.innerHTML = state.apks.length ? state.apks.map((apk, i) => `<div class="artifact-row"><input class="check apk-check" type="checkbox" value="${escapeHtml(apk.path)}" onchange="updateApkSelection()"><span class="file-icon">APK</span><span class="artifact-main"><b>${escapeHtml(apk.name)}</b><span>${formatSize(apk.size)} · ${new Date(apk.modified).toLocaleString()}</span><span>包名：${escapeHtml(apk.package_name||'未识别')}</span><span class="checksum-value" id="md5-${i}">MD5：按“MD5”计算</span><span class="checksum-value" id="sha256-${i}">文件 SHA-256：按“SHA-256”计算</span><span class="checksum-value" id="cert-sha256-${i}">证书 SHA-256：按“证书 SHA-256”计算</span></span>${apk.signed_with?`<span class="tag">SIGNED: ${escapeHtml(apk.signed_with)}</span>`:'<span class="tag">未识别签名</span>'}<button class="row-action" onclick="showMd5(${i})">MD5</button><button class="row-action" onclick="showApkSha256(${i})">SHA-256</button><button class="row-action" onclick="showApkCertificateSha256(${i})">证书 SHA-256</button><button class="row-action" onclick="openApkPush(${i})">Push</button><button class="row-action danger-action" onclick="deleteApk(${i})">删除</button></div>`).join('') : '<div class="artifact-row"><span class="artifact-main"><b>没有找到 APK</b><span>请上传 APK 或从构建目录导入。</span></span></div>';
    updateApkSelection();
  } catch (e) { list.innerHTML = `<div class="artifact-row">${escapeHtml(e.message)}</div>`; }
}
async function showMd5(index){const apk=state.apks[index],target=$(`#md5-${index}`);if(!apk||!target)return;target.textContent='MD5：计算中…';try{const r=await api('/api/apks/md5',{method:'POST',body:JSON.stringify({file:apk.path})});target.textContent=`MD5：${r.md5}`;await navigator.clipboard?.writeText(r.md5);toast(`MD5 已计算并复制到剪贴板：${apk.name}`)}catch(e){target.textContent='MD5：计算失败';toast(e.message,true)}}
async function showApkSha256(index){const apk=state.apks[index],target=$(`#sha256-${index}`);if(!apk||!target)return;target.textContent='文件 SHA-256：计算中…';try{const result=await api('/api/apks/sha256',{method:'POST',body:JSON.stringify({file:apk.path})});target.textContent=`文件 SHA-256：${result.sha256}`;await navigator.clipboard?.writeText(result.sha256);toast(`文件 SHA-256 已计算并复制到剪贴板：${apk.name}`)}catch(error){target.textContent='文件 SHA-256：计算失败';toast(error.message,true)}}
async function showApkCertificateSha256(index){const apk=state.apks[index],target=$(`#cert-sha256-${index}`);if(!apk||!target)return;target.textContent='证书 SHA-256：计算中…';try{const result=await api('/api/apks/cert-sha256',{method:'POST',body:JSON.stringify({file:apk.path})});const text=certificateResultText(result.certificates);target.textContent=result.certificates.length===1?`证书 SHA-256：${result.certificates[0].sha256}`:`证书 SHA-256：${result.certificates.length} 个 signer`;showCertificateSha256Result(apk.name,result.certificates,'',result.warning);const copied=await copyCertificateText(text);toast(copied?`证书 SHA-256 已计算并复制到剪贴板：${apk.name}`:`证书 SHA-256 已计算，但自动复制失败：${apk.name}`,!copied)}catch(error){target.textContent='证书 SHA-256：计算失败';toast(error.message,true)}}
function certificateResultText(certificates){return certificates.flatMap(item=>[`Signer #${item.signer}`,item.sha256,item.dn,'']).join('\n').trim()}
async function copyCertificateText(text){return copyTextToClipboard(text)}
function showCertificateSha256Result(title,certificates,path='',warning=''){openFeatureModal('certificate-sha256','签名证书 SHA-256：'+title,'',{hideFooter:true});const root=document.createElement('div');root.className='process-sha256-results certificate-sha256-results';const hint=document.createElement('p');hint.className='page-description';hint.textContent='这是 APK 签名证书指纹，不是 APK 文件摘要。';root.append(hint);if(warning){const notice=document.createElement('p');notice.className='notice warning';notice.textContent=warning;root.append(notice)}if(path){const source=document.createElement('small');source.className='certificate-apk-path';source.textContent='APK：'+path;root.append(source)}for(const item of certificates){const card=document.createElement('section'),name=document.createElement('b'),digest=document.createElement('code'),dn=document.createElement('small');name.textContent='Signer #'+item.signer;digest.textContent=item.sha256;dn.textContent=item.dn||'未提供证书 DN';card.append(name,digest,dn);root.append(card)}const copy=document.createElement('button');copy.type='button';copy.className='button primary certificate-copy-button';copy.textContent='复制结果';copy.onclick=async()=>{const copied=await copyCertificateText(certificateResultText(certificates));toast(copied?'证书 SHA-256 已复制到剪贴板':'复制失败，请手动选择摘要复制',!copied)};root.append(copy);$('#configModalBody').replaceChildren(root)}
async function deleteApk(index){const apk=state.apks[index];if(!apk||!confirm(`确认删除 APK？\n\n${apk.name}\n\n此操作不可恢复。`))return;try{await api('/api/apks/delete',{method:'POST',body:JSON.stringify({file:apk.path})});toast(`已删除 ${apk.name}`);loadApks()}catch(e){toast(e.message,true)}}

function selectedApks() { return [...document.querySelectorAll('.apk-check:checked')].map(x => x.value); }
function updateApkSelection() { const count = selectedApks().length; $('#apkSelection').textContent = count ? `已选择 ${count} 个 APK` : '尚未选择 APK'; $('#installButton').disabled = !count; }

function apkPushPreview(){
  const directory=$('#apkPushDevicePath')?.value.trim().replace(/\/+$/,'')||'',name=directory.split('/').filter(Boolean).pop()||'',filename=name.toLowerCase().endsWith('.apk')?name:name+'.apk';
  const preview=$('#apkPushPreview');if(preview)preview.textContent=directory&&name?directory+'/'+filename:'请输入设备端绝对目录';
}
function openApkPush(index){
  const apk=state.apks[index];if(!apk)return;state.apkPushIndex=index;
  openFeatureModal('apk-push','Push APK','',{hideFooter:true});
  const root=document.createElement('div');root.className='apk-push-form';
  const file=document.createElement('div');file.className='apk-push-file';const fileLabel=document.createElement('span'),fileName=document.createElement('b');fileLabel.textContent='待安装 APK';fileName.textContent=apk.name;file.append(fileLabel,fileName);
  const savedByPackage=state.config?.apk_push_device_paths||{};
  const pathLabel=document.createElement('label');pathLabel.className='feature-field';const pathTitle=document.createElement('span'),pathInput=document.createElement('input'),pathHint=document.createElement('small');pathTitle.textContent='设备端目标目录';pathInput.id='apkPushDevicePath';pathInput.placeholder='/system/priv-app/VehicleControl';pathInput.value=(apk.package_name&&savedByPackage[apk.package_name])||'';pathInput.addEventListener('input',apkPushPreview);pathHint.textContent=apk.package_name?`按包名 ${apk.package_name} 单独记忆此路径`:'未识别 APK 包名，本次路径不会按包名保存';pathLabel.append(pathTitle,pathInput,pathHint);
  const preview=document.createElement('div');preview.className='apk-push-preview';const previewLabel=document.createElement('span'),previewValue=document.createElement('code');previewLabel.textContent='最终设备文件';previewValue.id='apkPushPreview';preview.append(previewLabel,previewValue);
  const reboot=document.createElement('label');reboot.className='apk-push-reboot';reboot.innerHTML='<input id="apkPushReboot" type="checkbox"> Push 成功后重启设备';root.append(file,pathLabel,preview,reboot);$('#configModalBody').replaceChildren(root);apkPushPreview();
  const footer=$('#configModal .config-dialog-footer');footer.hidden=false;footer.innerHTML='<button class="button subtle" id="apkPushCancel">取消</button><button class="button primary" id="apkPushExecute">执行</button>';$('#apkPushCancel').onclick=closeFeatureConfig;$('#apkPushExecute').onclick=executeApkPush;
}
async function executeApkPush(){
  const apk=state.apks[state.apkPushIndex],devicePath=$('#apkPushDevicePath').value.trim(),reboot=$('#apkPushReboot').checked,execute=$('#apkPushExecute'),cancel=$('#apkPushCancel');if(!apk||!devicePath)return toast('请填写设备端目标目录',true);
  execute.disabled=true;cancel.disabled=true;execute.textContent='Push 中…';if(reboot&&state.logs)stopLogs();
  try{
    const result=await api('/api/apks/push',{method:'POST',body:JSON.stringify(withAdbSerial({file:apk.path,device_path:devicePath,reboot}))});
    if(!result.push_ok)throw new Error(result.output||'APK Push 失败');const packageName=result.package_name||apk.package_name;if(packageName){state.config.apk_push_device_paths={...(state.config.apk_push_device_paths||{}),[packageName]:devicePath};await api('/api/config',{method:'POST',body:JSON.stringify(state.config)});state.config=await api('/api/config');}closeFeatureConfig();
    if(result.reboot&&!result.reboot.ok)toast('APK 已 Push，但设备重启失败：'+result.reboot.message,true);else toast('已 Push 到 '+result.remote_path+(reboot?'，设备正在重启':''));
  }catch(error){toast(error.message,true);execute.disabled=false;cancel.disabled=false;execute.textContent='执行';}
}

async function installSelected() {
  const files = selectedApks(); if (!files.length) return; $('#installButton').disabled = true; $('#installButton').textContent = '安装中…';
  try {
    const r = await api('/api/install', { method:'POST', body:JSON.stringify(withAdbSerial({ files })) });
    const failed = r.results.filter(x => !x.ok); toast(failed.length ? `${failed.length} 项安装失败：${failed[0].output}` : `已完成 ${r.results.length} 个 APK 的安装`, !!failed.length);
  } catch(e) { toast(e.message, true); } finally { $('#installButton').textContent = '安装所选项'; updateApkSelection(); }
}

function switchApkTab(tab){state.apkTab=tab;document.querySelectorAll('.apk-tab').forEach(x=>x.classList.toggle('active',x.dataset.apkTab===tab));document.querySelectorAll('.apk-subpage').forEach(x=>x.classList.toggle('visible',x.id===`apk-tab-${tab}`));if(tab==='local')loadApks();if(tab==='sign')loadSignPage();if(tab==='resources')loadResources()}

async function loadSignPage(){
  const list=$('#signList');list.innerHTML='<div class="artifact-row">正在读取 APK 与签名文件…</div>';
  try{
    const [apks,keys]=await Promise.all([api('/api/apks'),api('/api/keystores')]);
    $('#keystoreSelect').innerHTML=keys.map(k=>`<option value="${escapeHtml(k.name)}" ${k.available?'':'disabled'}>${escapeHtml(k.name)}${k.available?'':'（文件不存在）'}</option>`).join('');
    const selected=keys.find(k=>k.name===$('#keystoreSelect').value);$('#keystoreHint').textContent=selected?'已选择受管签名文件；只有多 key 文件才需要填写 Alias。':'请先上传并选择签名文件。';
    list.innerHTML=apks.length?apks.map(apk=>`<label class="artifact-row"><input class="check sign-check" type="checkbox" value="${escapeHtml(apk.path)}" onchange="updateSignSelection()"><span class="file-icon">APK</span><span class="artifact-main"><b>${escapeHtml(apk.name)}</b><span>${formatSize(apk.size)} · ${new Date(apk.modified).toLocaleString()}</span><span>${apk.signed_with?`已由受管签名文件 “${escapeHtml(apk.signed_with)}”生成`:'未识别为本工具生成的签名输出'}</span></span><span class="tag">${apk.signed_with?`SIGNED: ${escapeHtml(apk.signed_with)}`:'SOURCE APK'}</span></label>`).join(''):'<div class="artifact-row">没有可签名的 APK。</div>';updateSignSelection();
  }catch(e){list.innerHTML=`<div class="artifact-row">${escapeHtml(e.message)}</div>`}
}
function selectedSignApks(){return [...document.querySelectorAll('.sign-check:checked')].map(x=>x.value)}
function updateSignSelection(){const n=selectedSignApks().length;$('#signSelection').textContent=n?`已选择 ${n} 个 APK`:'尚未选择 APK';$('#signButton').disabled=!n||!$('#keystoreSelect').value}
async function signSelected(){const files=selectedSignApks(),keystore=$('#keystoreSelect').value,storePassword=$('#storePassword').value,keyPassword=$('#keyPassword').value,alias=$('#keystoreAlias').value.trim();if(!files.length||!keystore)return;if(!storePassword||!keyPassword)return toast('请输入 Keystore 密码和私钥密码',true);const button=$('#signButton');button.disabled=true;button.textContent='签名中…';try{const r=await api('/api/apks/sign',{method:'POST',body:JSON.stringify({files,keystore,alias,store_password:storePassword,key_password:keyPassword})});const failed=r.results.filter(x=>!x.ok);toast(failed.length?`${failed.length} 项签名失败：${failed[0].output}`:`已签名 ${r.results.length} 个 APK`,!!failed.length);$('#storePassword').value='';$('#keyPassword').value='';loadSignPage();}catch(e){toast(e.message,true)}finally{button.textContent='签名所选项';button.disabled=false}}

function selectedResources(){return[...document.querySelectorAll('.resource-check:checked')].map(x=>x.value)}
function updateResourceSelection(){const n=selectedResources().length;const b=$('#pushResourcesButton');b.disabled=!n;b.textContent=n?`推送 ${n} 项`:'推送所选项'}

async function stopProcess(packageName) {
  if(!confirm(`确认强制停止 ${packageName}？`))return; try{const r=await api('/api/processes/stop',{method:'POST',body:JSON.stringify(withAdbSerial({package:packageName}))});toast(r.ok?`${packageName} 已停止`:r.output,!r.ok);loadProcesses();}catch(e){toast(e.message,true)}
}
async function launchProcess(packageName){try{const r=await api('/api/processes/launch',{method:'POST',body:JSON.stringify(withAdbSerial({package:packageName}))});toast(r.ok?`已拉起 ${packageName}`:`拉起失败：${r.output}`,!r.ok);setTimeout(loadProcesses,800)}catch(e){toast(e.message,true)}}
function updateProcessLaunchPreview(){const command=$('#launchCommand')?.value.trim()||'';const preview=$('#processLaunchPreview');if(preview)preview.textContent='adb shell '+(command||'<设备端拉起命令>')}
function openProcessLaunchConfig(packageName){const config=state.config.app_launches?.[packageName]||{};state.featureProcessPackage=packageName;openFeatureModal('process-launch',`配置拉起：${packageName}`,configInput('设备端拉起命令','launchCommand',config.command||'',`am start -n ${packageName}/.MainActivity`)+`<div class="launch-examples"><b>完整执行预览</b><pre><code id="processLaunchPreview"></code></pre><p>只填写 <code>adb shell</code> 后面的内容，支持 <code>am start</code> 或 <code>am start-activity</code>。参数值包含空格时请使用引号。</p></div><button class="button danger" onclick="deleteProcessLaunchConfig()">删除拉起配置</button>`);$('#launchCommand').addEventListener('input',updateProcessLaunchPreview);updateProcessLaunchPreview();}
async function deleteProcessLaunchConfig(){const packageName=state.featureProcessPackage;if(!packageName)return;if(!state.config.app_launches?.[packageName])return closeFeatureConfig();if(!confirm(`确认删除 ${packageName} 的拉起配置？`))return;delete state.config.app_launches[packageName];await api('/api/config',{method:'POST',body:JSON.stringify(state.config)});state.config=await api('/api/config');closeFeatureConfig();loadProcesses();toast('拉起配置已删除')}

function addBroadcastExtra(item={type:'string',key:'',value:''}){const row=document.createElement('div');row.className='broadcast-extra';row.innerHTML=`<select class="broadcast-extra-type"><option value="string">String</option><option value="int">Int</option><option value="long">Long</option><option value="bool">Boolean</option><option value="float">Float</option></select><input class="broadcast-extra-key" placeholder="key"><input class="broadcast-extra-value" placeholder="value"><button class="icon-button" title="移除">×</button>`;row.querySelector('.broadcast-extra-type').value=item.type;row.querySelector('.broadcast-extra-key').value=item.key;row.querySelector('.broadcast-extra-value').value=item.value;row.querySelectorAll('input,select').forEach(x=>x.addEventListener('input',updateBroadcastPreview));row.querySelector('button').onclick=()=>{row.remove();updateBroadcastPreview()};$('#broadcastExtras').append(row);updateBroadcastPreview()}
function broadcastData(){return {name:$('#broadcastName').value.trim(),action:$('#broadcastAction').value.trim(),package:$('#broadcastPackage').value.trim(),extras:[...document.querySelectorAll('.broadcast-extra')].map(row=>({type:row.querySelector('.broadcast-extra-type').value,key:row.querySelector('.broadcast-extra-key').value.trim(),value:row.querySelector('.broadcast-extra-value').value})).filter(x=>x.key||x.value)}}
function updateBroadcastPreview(){const data=broadcastData();let output=`adb shell am broadcast -a ${data.action||'<ACTION>'}`;if(data.package)output+=` -p ${data.package}`;for(const extra of data.extras){const flag={string:'--es',int:'--ei',long:'--el',bool:'--ez',float:'--ef'}[extra.type];output+=` ${flag} ${extra.key||'<key>'} ${extra.value||'<value>'}`;}$('#broadcastPreview').textContent=output}
async function loadBroadcasts(){try{const presets=await api('/api/broadcasts');const select=$('#broadcastPreset'),current=select.value;select.innerHTML='<option value="">新广播</option>'+Object.keys(presets).map(name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');if(presets[current])select.value=current;if(!$('#broadcastExtras').children.length)addBroadcastExtra();updateBroadcastPreview()}catch(e){toast(e.message,true)}}
function loadBroadcastPreset(){const preset=activeBroadcasts()[$('#broadcastPreset').value];$('#broadcastExtras').innerHTML='';if(preset){$('#broadcastName').value=$('#broadcastPreset').value;$('#broadcastAction').value=preset.action||'';$('#broadcastPackage').value=preset.package||'';(preset.extras||[]).forEach(addBroadcastExtra)}else{$('#broadcastName').value='';$('#broadcastAction').value='';$('#broadcastPackage').value='';addBroadcastExtra()}updateBroadcastPreview()}
function activeBroadcasts(){return state.config?.broadcasts||{}}
async function saveBroadcastPreset(){const data=broadcastData();if(!data.name)return toast('请填写预设名称',true);if(!data.action)return toast('请填写 Action',true);state.config.broadcasts={...(state.config.broadcasts||{}),[data.name]:{action:data.action,package:data.package,extras:data.extras}};try{await api('/api/config',{method:'POST',body:JSON.stringify(state.config)});state.config=await api('/api/config');await loadBroadcasts();$('#broadcastPreset').value=data.name;toast(`广播预设“${data.name}”已保存`)}catch(e){toast(e.message,true)}}
async function sendBroadcast(){const data=broadcastData();if(!data.action)return toast('请填写 Action',true);try{const r=await api('/api/broadcasts/send',{method:'POST',body:JSON.stringify(withAdbSerial(data))});toast(r.ok?`广播已发送：${r.output||'OK'}`:`发送失败：${r.output}`,!r.ok)}catch(e){toast(e.message,true)}}

const logColors=['violet','cyan','green','yellow','orange','red'];
const logViewDefaults={fontSize:13,highlightOpacity:100};
function autoScrollEnabled(){return localStorage.getItem('glacien.log.autoScroll') !== 'false'}
function updateAutoScroll(value){localStorage.setItem('glacien.log.autoScroll',value);const enabled=value==='true',toggle=$('#logAutoScroll');if(toggle)toggle.checked=enabled;if(enabled){const out=$('#logOutput');out.scrollTop=out.scrollHeight;}}
function applyLogViewSettings(){const fontSize=Number(localStorage.getItem('glacien.log.fontSize')||logViewDefaults.fontSize),opacity=Number(localStorage.getItem('glacien.log.highlightOpacity')||logViewDefaults.highlightOpacity);document.documentElement.style.setProperty('--log-font-size',`${fontSize}px`);document.documentElement.style.setProperty('--log-highlight-opacity',`${opacity/100}`);const font=$('#logFontSize'),alpha=$('#logHighlightOpacity');if(font){font.value=fontSize;$('#logFontSizeValue').textContent=`${fontSize}px`;}if(alpha){alpha.value=opacity;$('#logHighlightOpacityValue').textContent=`${opacity}%`;}}
function updateLogFontSize(value){localStorage.setItem('glacien.log.fontSize',value);applyLogViewSettings()}
function updateLogHighlightOpacity(value){localStorage.setItem('glacien.log.highlightOpacity',value);applyLogViewSettings()}
function words(value){return [...new Set(value.replaceAll(String.fromCharCode(13),',').replaceAll(String.fromCharCode(10),',').split(',').map(x=>x.trim()).filter(Boolean))]}
function activeLogFilters(){return state.config?.log_filters||{}}
function logRulePayload(){
  const name=$('#logRuleName')?.value.trim()||'',processName=$('#logProcessName')?.value.trim()||'',raw=$('#logRuleTerms')?.value||'',highlights={};let filters=[],error='';
  if(raw.trim()){try{filters=parseLogFilterExpression(raw)}catch(exception){error=exception.message}}
  for(const input of document.querySelectorAll('#logRulePanel [data-color]')){const terms=words(input.value);if(terms.length)highlights[input.dataset.color]=terms;}
  return {name,process_name:processName,filters,highlights,error,raw:error?raw:''};
}
function logRuleSignature(payload=logRulePayload()){return JSON.stringify(payload)}
function logRuleDirty(){return Boolean(state.logPreset.baseline)&&logRuleSignature()!==state.logPreset.baseline}
function refreshLogRuleState(){
  const label=$('#logRuleDraftState');if(!label)return;const payload=logRulePayload(),dirty=logRuleDirty();label.className='log-rule-draft-state '+(payload.error?'error':dirty?'dirty':'saved');
  label.textContent=payload.error?'表达式有误':dirty?(state.logPreset.loadedName?'已修改，未保存':'未保存的新方案'):(state.logPreset.loadedName?'已保存':'新方案');
  updateLogRuleToggleSummary();
}
function setLogRuleBaseline(name){state.logPreset={loadedName:name||'',baseline:logRuleSignature()};refreshLogRuleState()}
function restoreLoadedLogRule(){const name=state.logPreset.loadedName;if(name&&activeLogFilters()[name]){$('#logPreset').value=name;fillLogEditor(name);}else{$('#logPreset').value='';fillLogEditor();}setLogRuleBaseline(name)}
function confirmDiscardLogRuleChanges(action){return !logRuleDirty()||confirm('当前实时日志过滤方案有未保存修改。'+action+'将丢弃这些修改，是否继续？')}
function quoteLogFilterTerm(term){const slash=String.fromCharCode(92);return term.includes('|')||term.includes('&')||term.includes('"')||term.includes(slash)||term.includes(' ')||term.includes('(')||term.includes(')')?'"'+term.replaceAll(slash,slash+slash).replaceAll('"',slash+'"')+'"':term}
function normalizeRealtimeFilters(rule={}){if(Array.isArray(rule.filters))return rule.filters.map(filter=>({mode:filter.mode,terms:[...(filter.terms||[])]})).filter(filter=>filter.terms.length);const filters=[];if(rule.include_any?.length)filters.push({mode:'include_any',terms:[...rule.include_any]});if(rule.include_all?.length)filters.push({mode:'include_all',terms:[...rule.include_all]});return filters}
function formatLogFilterExpression(filters){return filters.map(filter=>{const operator=filter.mode==='include_all'?' & ':' | ',body=filter.terms.map(quoteLogFilterTerm).join(operator);if(filter.mode==='exclude_any')return '!('+body+')';if(filter.mode==='include_all'&&filter.terms.length===1)return 'all('+body+')';return '('+body+')'}).join(' & ')}
function splitLogExpression(source,topLevel){const parts=[];let token='',depth=0,quoted=false,escaped=false;const slash=String.fromCharCode(92);for(let index=0;index<source.length;index+=1){const char=source[index];if(escaped){token+=char;escaped=false;continue}if(quoted&&char===slash){token+=char;escaped=true;continue}if(char==='"'){quoted=!quoted;token+=char;continue}if(!quoted&&char==='('){depth+=1;token+=char;continue}if(!quoted&&char===')'){depth-=1;if(depth<0)throw new Error('括号不匹配');token+=char;continue}const isOperator=!quoted&&depth===0&&(char==='|'||char==='&');if(isOperator){if(topLevel&&char!=='&')throw new Error('条件之间请使用 &');if(source[index+1]===char)throw new Error('任一使用 |，所有使用 &');const value=token.trim();if(!value)throw new Error('运算符两侧都必须填写条件');parts.push({value,operator:char});token='';continue}token+=char}if(quoted)throw new Error('双引号没有闭合');if(depth!==0)throw new Error('括号不匹配');const value=token.trim();if(!value)throw new Error('表达式末尾缺少条件');parts.push({value,operator:''});return parts}
function parseLogTerms(source){const parts=splitLogExpression(source,false),operators=[...new Set(parts.map(part=>part.operator).filter(Boolean))];if(operators.length>1)throw new Error('单条条件不能混用 | 和 &');const slash=String.fromCharCode(92),terms=parts.map(part=>{let value=part.value.trim();if(value.startsWith('"')){if(!value.endsWith('"')||value.length<2)throw new Error('双引号没有闭合');value=value.slice(1,-1);let result='',escaped=false;for(const char of value){if(escaped){result+=char;escaped=false}else if(char===slash)escaped=true;else result+=char}if(escaped)throw new Error('表达式末尾不能是转义符');value=result}if(!value)throw new Error('关键词不能为空');return value});return {mode:operators[0]==='&'?'include_all':'include_any',terms:[...new Set(terms)]}}
function parseLogFilterExpression(value){const source=String(value||'').trim();if(!source)throw new Error('请输入过滤表达式');if(!source.includes('(')&&!source.includes(')')){const parsed=parseLogTerms(source);return [{mode:parsed.mode,terms:parsed.terms}]}const clauses=splitLogExpression(source,true),filters=[];for(const clause of clauses){let text=clause.value.trim(),exclude=false,forceAll=false;if(text.startsWith('!(')&&text.endsWith(')')){exclude=true;text=text.slice(2,-1)}else if(text.startsWith('all(')&&text.endsWith(')')){forceAll=true;text=text.slice(4,-1)}else if(text.startsWith('(')&&text.endsWith(')'))text=text.slice(1,-1);else if(clauses.length>1)throw new Error('多条条件必须使用括号分组');const parsed=parseLogTerms(text);if(exclude&&parsed.mode==='include_all')throw new Error('排除任一请使用 |');filters.push({mode:exclude?'exclude_any':forceAll?'include_all':parsed.mode,terms:parsed.terms})}return filters}
function logFilterRegex(term){const slash=String.fromCharCode(92);return String(term).split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,match=>slash+match)).join('.*')}
function shellQuote(value){return "'"+String(value).replaceAll("'","'\"'\"'")+"'"}
function logFilterCommandStage(tool,pattern,exclude=false){if(tool==='rg')return 'rg -i '+(exclude?'-v ':'')+'-e '+shellQuote(pattern);return 'grep -Ei '+(exclude?'-v ':'')+'-- '+shellQuote(pattern)}
function formatLogFilterCommand(filters,tool){const stages=[];for(const filter of filters){const patterns=filter.terms.map(logFilterRegex);if(filter.mode==='include_all'){patterns.forEach(pattern=>stages.push(logFilterCommandStage(tool,pattern)));continue}stages.push(logFilterCommandStage(tool,patterns.join('|'),filter.mode==='exclude_any'));}return stages.join(' | ')}
async function copyLogFilterCommand(scope,tool){let filters;try{filters=scope==='offline'?parseOfflineExpression():logFilterDraft()}catch(error){return toast('请先修正过滤表达式：'+error.message,true)}if(!filters.length)return toast('请先填写筛选条件',true);const copied=await copyTextToClipboard(formatLogFilterCommand(filters,tool));toast(copied?(tool==='rg'?'rg':'grep')+' 筛选命令已复制，可接在 adb logcat 或 cat 输出后':'复制失败，请确认系统允许应用访问剪贴板',!copied)}
function logFilterDraft(){return parseLogFilterExpression($('#logRuleTerms').value)}
function createLogFilterRow(filter={},options={}){const row=document.createElement('div');row.className='log-condition-row '+(options.extraClass||'');const mode=document.createElement('select');mode.className='log-condition-mode';mode.innerHTML='<option value="include_any">包含任一</option><option value="include_all">包含全部</option><option value="exclude_any">排除任一</option>';mode.value=filter.mode||'include_any';const input=document.createElement('input');input.className='log-condition-terms';input.value=Array.isArray(filter.terms)?filter.terms.join(', '):filter.terms||'';input.placeholder='关键词，逗号分隔；* 匹配任意字符';const remove=document.createElement('button');remove.type='button';remove.className='icon-button log-condition-remove';remove.textContent='×';remove.title='移除条件';mode.onchange=input.oninput=options.onChange||null;remove.onclick=()=>options.onRemove?.(row);row.append(mode,input,remove);return row}
function createLogHighlightSection(id,title,description,content){const section=document.createElement('section');section.id=id;section.className='log-highlight-section';const header=document.createElement('div');header.className='log-highlight-header';const label=document.createElement('span'),heading=document.createElement('b'),hint=document.createElement('small');heading.textContent=title;hint.textContent=description;label.append(heading,hint);header.append(label);content.classList.add('log-highlight-content');section.append(header);return section}
function realtimeFilterRow(filter={mode:'include_any',terms:[]}){return createLogFilterRow(filter,{extraClass:'realtime-filter-row',onChange:syncRealtimeFiltersFromRows,onRemove:row=>{row.remove();if(!$$('.realtime-filter-row').length)addRealtimeFilter();else syncRealtimeFiltersFromRows()}})}
function renderRealtimeFilterRows(filters){const rows=$('#realtimeFilterRows');if(!rows)return;rows.replaceChildren();(filters.length?filters:[{mode:'include_any',terms:[]}]).forEach(filter=>rows.append(realtimeFilterRow(filter)))}
function realtimeFilterRows(){return $$('.realtime-filter-row').map(row=>({mode:row.querySelector('.log-condition-mode').value,terms:words(row.querySelector('.log-condition-terms').value)})).filter(filter=>filter.terms.length)}
function syncRealtimeFiltersFromRows(){const filters=realtimeFilterRows();$('#logRuleTerms').value=filters.length?formatLogFilterExpression(filters):'';updateLogFilterEditor(false)}
function addRealtimeFilter(filter){const rows=$('#realtimeFilterRows');if(!rows)return;rows.append(realtimeFilterRow(filter));rows.lastElementChild.querySelector('input').focus();syncRealtimeFiltersFromRows()}
function updateLogFilterEditor(renderRows=true){
  const expression=$('#logRuleTerms'),error=$('#logFilterExpressionError'),status=$('#logFilterExpressionStatus'),summary=$('#logFilterBasicSummary'),count=$('#logFilterKeywordCount');if(!expression)return;
  if(!expression.value.trim()){const empty=[];if(error){error.textContent='';error.hidden=true;}if(status)status.textContent='尚未填写表达式';if(summary)summary.textContent='添加条件后即可保存方案';if(count)count.textContent='0 条条件';if(renderRows)renderRealtimeFilterRows(empty);refreshLogRuleState();return empty;}
  try{const filters=logFilterDraft(),termsCount=filters.reduce((sum,filter)=>sum+filter.terms.length,0);if(error){error.textContent='';error.hidden=true;}if(status)status.textContent='已解析 '+filters.length+' 条条件 · '+termsCount+' 个关键词';if(summary)summary.textContent='所有条件依次生效，后加条件继续缩小结果';if(count)count.textContent=filters.length+' 条条件';if(renderRows)renderRealtimeFilterRows(filters);refreshLogRuleState();return filters;}catch(exception){if(error){error.textContent=exception.message;error.hidden=false;}if(status)status.textContent='表达式未通过校验';if(summary)summary.textContent='表达式有误，请切换到表达式模式修正';if(count)count.textContent='语法错误';refreshLogRuleState();return null;}
}
function showLogFilterMode(mode){
  if(mode==='basic'&&!updateLogFilterEditor())return;
  state.logFilterEditorMode=mode;const basic=$('#logFilterBasicMode'),advanced=$('#logFilterExpressionMode');if(basic)basic.hidden=mode!=='basic';if(advanced)advanced.hidden=mode!=='expression';$$('.log-filter-mode-button').forEach(button=>button.classList.toggle('active',button.dataset.mode===mode));
}
function ensureLogFilterDualEditor(){
  const terms=$('#logRuleTerms'),mode=$('#logMatchMode'),ruleMain=$('.rule-main'),name=$('#logRuleName');if(!terms||$('#logFilterEditor'))return;mode.hidden=true;terms.rows=3;terms.placeholder='例如：(word | key) & !(heartbeat)';terms.addEventListener('input',updateLogFilterEditor);
  const nameField=document.createElement('label');nameField.className='log-rule-name-field';const nameLabel=document.createElement('span');nameLabel.textContent='规则名称';name.before(nameField);nameField.append(nameLabel,name);
  const processField=document.createElement('label');processField.className='log-process-field';processField.innerHTML='<span>进程过滤（可选）</span><input id="logProcessName" placeholder="完整进程名，例如 com.example.app:service"><small>开始监听时解析当前 PID；目标进程重启后请重新开始监听。</small>';
  const editor=document.createElement('section');editor.id='logFilterEditor';editor.className='log-filter-builder log-filter-editor';editor.innerHTML='<header class="log-filter-builder-header log-filter-editor-header"><div><b>筛选条件</b><small>每条条件都必须满足；后加条件继续缩小结果</small></div><div class="log-filter-mode-tabs"><button class="log-filter-mode-button active" data-mode="basic" type="button">基础模式</button><button class="log-filter-mode-button" data-mode="expression" type="button">表达式模式</button></div></header><div id="logFilterBasicMode" class="log-filter-builder-body log-filter-basic"><div class="log-filter-basic-meta"><span class="log-filter-match-badge" id="logFilterKeywordCount">0 条条件</span><span id="logFilterBasicSummary">添加条件后即可保存方案</span></div><div id="realtimeFilterRows" class="log-condition-rows realtime-filter-rows"></div><button class="button subtle realtime-filter-add" type="button">＋ 添加条件</button></div><div id="logFilterExpressionMode" class="log-filter-builder-body log-filter-expression" hidden><label><span>QUERY</span></label><div class="log-filter-expression-help"><span><code>(a | b)</code> 包含任一</span><span><code>(a &amp; b)</code> 包含全部</span><span><code>!(a | b)</code> 排除任一</span><span>条件之间用 <code>&amp;</code></span></div><div class="log-filter-copy-actions"><button class="button subtle" type="button" onclick="copyLogFilterCommand(\'realtime\',\'grep\')">复制为 grep</button><button class="button subtle" type="button" onclick="copyLogFilterCommand(\'realtime\',\'rg\')">复制为 rg</button></div><p id="logFilterExpressionStatus" class="log-filter-expression-status"></p><p id="logFilterExpressionError" class="log-filter-expression-error" hidden></p></div>';
  ruleMain.append(processField,editor);$('#logFilterExpressionMode label').append(terms);$$('.log-filter-mode-button').forEach(button=>button.onclick=()=>showLogFilterMode(button.dataset.mode));$('.realtime-filter-add').onclick=()=>addRealtimeFilter();
  const colors=$('.color-grid');if(colors&&!$('#logHighlightSection')){const section=createLogHighlightSection('logHighlightSection','高亮规则','可选：为日志内容中的任意字符串设置颜色',colors);colors.before(section);section.append(colors);}
  const actions=$('.rule-actions');if(actions&&!$('#logRuleDraftState')){const draft=document.createElement('span');draft.id='logRuleDraftState';draft.className='log-rule-draft-state';actions.prepend(draft);}name.addEventListener('input',refreshLogRuleState);processField.querySelector('input').addEventListener('input',refreshLogRuleState);$$('#logs [data-color]').forEach(input=>input.addEventListener('input',refreshLogRuleState));
  showLogFilterMode('basic');
}
function logKeywordRow(value=''){const row=document.createElement('div');row.className='log-keyword-row';const input=document.createElement('input');input.className='log-keyword-input';input.value=value;input.placeholder='输入一个完整关键词';const remove=document.createElement('button');remove.className='icon-button';remove.type='button';remove.textContent='×';remove.title='删除关键词';remove.onclick=()=>row.remove();row.append(input,remove);return row;}
function addLogKeyword(value=''){const rows=$('#logKeywordRows');if(!rows)return;const row=logKeywordRow(value);rows.append(row);row.querySelector('input').focus();}
function openLogKeywordManager(){
  const draft=updateLogFilterEditor();if(!draft)return toast('请先修正过滤表达式',true);
  openFeatureModal('log-keywords','管理整体过滤关键词','',{hideFooter:true});const root=document.createElement('div');root.className='log-keyword-manager';
  const mode=document.createElement('label');mode.className='feature-field';mode.innerHTML='<span>匹配方式</span><select id="logKeywordMode"><option value="include_any">任意关键词匹配（OR）</option><option value="include_all">所有关键词匹配（AND）</option></select>';mode.querySelector('select').value=draft.mode;
  const hint=document.createElement('p');hint.className='page-description';hint.textContent='每个输入框是一条完整关键词，可以包含空格和符号。';const rows=document.createElement('div');rows.id='logKeywordRows';rows.className='log-keyword-rows';draft.terms.forEach(term=>rows.append(logKeywordRow(term)));const add=document.createElement('button');add.className='button subtle';add.type='button';add.textContent='添加关键词';add.onclick=()=>addLogKeyword();root.append(mode,hint,rows,add);$('#configModalBody').replaceChildren(root);
  const footer=$('#configModal .config-dialog-footer');footer.hidden=false;footer.innerHTML='<button class="button subtle" id="logKeywordCancel">取消</button><button class="button primary" id="logKeywordApply">应用</button>';$('#logKeywordCancel').onclick=closeFeatureConfig;$('#logKeywordApply').onclick=applyLogKeywordManager;
}
function applyLogKeywordManager(){
  const terms=[...new Set($$('.log-keyword-input').map(input=>input.value.trim()).filter(Boolean))];if(!terms.length)return toast('请至少添加一个关键词',true);const mode=$('#logKeywordMode').value;$('#logRuleTerms').value=formatLogFilterExpression(mode,terms);$('#logMatchMode').value=mode;closeFeatureConfig();updateLogFilterEditor();showLogFilterMode('basic');
}
function fillLogEditor(name=''){const rule=activeLogFilters()[name]||{},filters=normalizeRealtimeFilters(rule);$('#logRuleName').value=name;if($('#logProcessName'))$('#logProcessName').value=rule.process_name||'';$('#logRuleTerms').value=filters.length?formatLogFilterExpression(filters):'';const grouped=Object.fromEntries(logColors.map(color=>[color,[]]));for(const group of rule.highlights||[]){if(grouped[group.color])grouped[group.color].push(...(group.terms||[]));}document.querySelectorAll('#logRulePanel .color-input input').forEach(input=>input.value=(grouped[input.dataset.color]||[]).join(', '));updateLogFilterEditor();setLogRuleBaseline(name);}
async function loadLogFilters(){try{const filters=await api('/api/log-filters');const select=$('#logPreset'),current=select.value;select.innerHTML='<option value="">全部日志</option>'+Object.keys(filters).map(name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');select.value=Object.prototype.hasOwnProperty.call(filters,current)?current:'';fillLogEditor(select.value);}catch(e){toast(e.message,true)}}
function ensureLogExportButtons(){if($('#logViewControls'))return;const controls=document.createElement('div');controls.id='logViewControls';controls.className='log-view-controls';controls.innerHTML='<label>字体 <input id="logFontSize" type="range" min="11" max="22" step="1" oninput="updateLogFontSize(this.value)"><b id="logFontSizeValue">13px</b></label><label>高亮背景 <input id="logHighlightOpacity" type="range" min="10" max="100" step="5" oninput="updateLogHighlightOpacity(this.value)"><b id="logHighlightOpacityValue">100%</b></label><button class="button subtle" id="logExportButton" onclick="exportLogs()" disabled>导出结果</button>';$('#logStatus').before(controls);applyLogViewSettings();}
function ensurePresetDeleteButtons(){const logControls=$('#logPreset')?.parentElement;if(logControls&&!$('#deleteLogPresetButton')){const b=document.createElement('button');b.id='deleteLogPresetButton';b.className='button danger subtle-delete';b.textContent='删除方案';b.onclick=deleteLogPreset;logControls.insertBefore(b,$('#logToggle'));}const broadcastControls=$('#broadcastPreset')?.parentElement;if(broadcastControls&&!$('#deleteBroadcastPresetButton')){const b=document.createElement('button');b.id='deleteBroadcastPresetButton';b.className='button danger subtle-delete';b.textContent='删除预设';b.onclick=deleteBroadcastPreset;broadcastControls.insertBefore(b,broadcastControls.querySelector('.button.primary'));}}
function wrapLogSchemeField(control,labelText){if(!control||control.closest('.log-scheme-field'))return control?.closest('.log-scheme-field');const label=document.createElement('label');label.className='log-scheme-field';const title=document.createElement('span');title.textContent=labelText;control.before(label);label.append(title,control);return label}
function enhanceRealtimeSchemeLayout(){
  const panel=$('#logRulePanel'),main=panel?.querySelector('.rule-main'),controls=$('#liveLogSchemeControls'),select=$('#logPreset'),name=$('#logRuleName');if(!panel||!main||!controls||!select||!name||$('#realtimeSchemeBar'))return;
  const bar=document.createElement('section');bar.id='realtimeSchemeBar';bar.className='log-scheme-bar';const selectField=wrapLogSchemeField(select,'选择方案'),nameField=name.closest('.log-rule-name-field');if(nameField){nameField.classList.add('log-scheme-field');nameField.querySelector('span').textContent='方案名称';}
  const newButton=[...controls.querySelectorAll('button')].find(button=>button.textContent.includes('新建')),deleteButton=$('#deleteLogPresetButton');if(newButton)newButton.textContent='新建方案';if(deleteButton)deleteButton.textContent='删除方案';const startButton=$('#logToggle'),clearButton=$('#logDisplayClearButton');if(clearButton){clearButton.title='清空显示';clearButton.setAttribute('aria-label','清空显示')}panel.querySelector('.rule-header')?.remove();$('#logRuleHint')?.remove();main.before(bar);if(selectField)bar.append(selectField);if(newButton)bar.append(newButton);if(nameField)bar.append(nameField);if(deleteButton)bar.append(deleteButton);
  if(startButton)startButton.classList.add('log-action-button');if(clearButton)clearButton.classList.add('log-action-button');
}
function ensureLogRuleToggle(){const panel=$('.log-rule-panel');if(panel)panel.id='logRulePanel'}
function ensureAutoScrollToggle(){if($('#logAutoScroll'))return;const label=document.createElement('label');label.className='auto-scroll-toggle';label.innerHTML=`<input id="logAutoScroll" type="checkbox"> 自动滚动`;const toggle=label.querySelector('input');toggle.addEventListener('change',()=>updateAutoScroll(toggle.checked?'true':'false'));$('#logViewControls').append(label);updateAutoScroll(autoScrollEnabled()?'true':'false');}
function selectLogPreset(){if(state.logs){stopLogs();}fillLogEditor($('#logPreset').value);}
function newLogPreset(){if(state.logs)stopLogs();$('#logPreset').value='';fillLogEditor();$('#logRuleName').focus();}
async function saveLogPreset(){const name=$('#logRuleName').value.trim(),mode=$('#logMatchMode').value,terms=words($('#logRuleTerms').value);if(!name)return toast('请填写方案名称',true);if(!terms.length)return toast('请至少填写一条过滤条件',true);const highlights=[];for(const input of document.querySelectorAll('#logRulePanel .color-input input')){const colorTerms=words(input.value);if(colorTerms.length)highlights.push({terms:colorTerms,color:input.dataset.color});}if(state.logs)stopLogs();state.config.log_filters={...(state.config.log_filters||{}),[name]:{[mode]:terms,highlights}};try{await api('/api/config',{method:'POST',body:JSON.stringify(state.config)});state.config=await api('/api/config');await loadLogFilters();$('#logPreset').value=name;fillLogEditor(name);$('#logStatus').textContent='过滤方案已保存';toast(`过滤方案“${name}”已保存`);}catch(e){toast(e.message,true)}}
function toggleLogs() { state.logs ? stopLogs() : startLogs(); }
function startLogs() {
  const preset=$('#logPreset').value; state.logCount=0;$('#logOutput').innerHTML='<span class="log-hint">正在连接 adb logcat…</span>';$('#logStatus').textContent='正在建立实时 Logcat 连接…';const source=new EventSource(`/api/logs?preset=${encodeURIComponent(preset)}&serial=${encodeURIComponent(selectedAdbSerial())}`); state.logs=source; $('#logToggle').textContent='停止';
  source.onopen=()=>{$('#logStatus').textContent='SSE 已连接，正在等待匹配的 Logcat 日志…';};source.addEventListener('ready',event=>{state.logRule=JSON.parse(event.data).rule||{};$('#logStatus').textContent=`已连接 ADB Logcat，等待匹配日志。当前规则：${JSON.stringify(state.logRule)}`;}); source.onmessage=(event)=>{try{appendLog(JSON.parse(event.data));state.logCount+=1;$('#logStatus').textContent=`已连接 ADB Logcat，已接收 ${state.logCount} 条匹配日志。`;}catch(error){console.error(error);toast(`日志渲染失败：${error.message}`,true);}}; source.onerror=()=>{if(state.logs){toast('Logcat 连接已断开',true);$('#logStatus').textContent='连接中断。请确认设备在线后重新开始。';stopLogs();}};
}
function stopLogs(){if(state.logs)state.logs.close();state.logs=null;$('#logToggle').textContent='开始';if($('#logStatus'))$('#logStatus').textContent='已停止接收 Logcat。';}
function clearLogs(){
  state.logCount=0;
  $('#logOutput').innerHTML='';
  $('#logStatus').textContent=state.logs?'页面显示已清空，实时监听仍在继续。':'页面显示已清空。';
}
async function clearDeviceLogs(){
  if(!selectedAdbSerial())return toast('请先选择在线设备',true);
  if(!confirm('确认清空当前设备的全部 Logcat 缓冲区？\n\n页面日志也会清空；如果正在监听，将在清理完成后自动重新开始。'))return;
  const button=$('#logDeviceClearButton'),wasListening=Boolean(state.logs);
  if(wasListening)stopLogs(true);else state.logSessionId=(state.logSessionId||0)+1;
  button.disabled=true;button.textContent='清空中…';
  try{
    const result=await api('/api/logs/clear',{method:'POST',body:JSON.stringify(withAdbSerial())});
    state.logCount=0;$('#logOutput').innerHTML='<span class="log-hint">设备 Logcat 缓冲区已清空，等待新日志。</span>';$('#logStatus').textContent=result.message||'设备 Logcat 缓冲区已清空。';toast(result.message||'设备 Logcat 缓冲区已清空');
    if(wasListening)await startLogs();
  }catch(error){$('#logStatus').textContent='清空失败：'+error.message;toast(error.message,true)}
  finally{button.disabled=button.dataset.deviceOnline!=='true';button.textContent='清空日志'}
}
async function exportLogs(filtered){try{const r=await api('/api/logs/export',{method:'POST',body:JSON.stringify(withAdbSerial({preset:$('#logPreset').value,filtered}))});toast(`已保存 ${r.lines} 行：${r.path}`);}catch(e){toast(e.message,true)}}
function logHighlights(){const configured=(state.logRule.highlights||[]).flatMap(item=>(item.terms||[]).filter(Boolean).map(term=>({term,color:item.color||'yellow'})));if(configured.length)return configured;return(state.logRule.highlight||[]).filter(Boolean).map(term=>({term,color:'yellow'}));}
function logSeverityClass(line){const text=String(line||'');if(/\[(?:error|err|fatal)\]|\sE\s|\b(?:fatal|exception|crash)\b/i.test(text))return 'error';if(/\[(?:warn|warning)\]|\sW\s|\bwarn(?:ing)?\b/i.test(text))return 'warn';return ''}
function appendLog(line){const out=$('#logOutput'),el=document.createElement('span');el.className=`log-line ${logSeverityClass(line)}`;const highlights=logHighlights(),lower=line.toLowerCase();let position=0;while(position<line.length){let hit=-1,chosen=null;for(const item of highlights){const index=lower.indexOf(item.term.toLowerCase(),position);if(index!==-1&&(hit===-1||index<hit||(index===hit&&item.term.length>chosen.term.length))){hit=index;chosen=item;}}if(hit===-1){el.append(document.createTextNode(line.slice(position)));break;}if(hit>position)el.append(document.createTextNode(line.slice(position,hit)));const mark=document.createElement('mark');mark.className=`highlight-${chosen.color}`;mark.textContent=line.slice(hit,hit+chosen.term.length);el.append(mark);position=hit+chosen.term.length;}out.appendChild(el);while(out.childNodes.length>1300)out.removeChild(out.firstChild);if(autoScrollEnabled())out.scrollTop=out.scrollHeight;}

// 离线日志完全由浏览器 File API 读取；不把用户选择的目录、文件或日志正文发送到后端。
const offlinePageSize=1000;
function offlineTextFile(bytes){return !bytes.includes(0) && !(bytes[0]===0x1f&&bytes[1]===0x8b);}
function offlineHighlightTerms(){return [...document.querySelectorAll('[data-offline-color]')].flatMap(input=>words(input.value).map(term=>({term,color:input.dataset.offlineColor})));}
function offlineHighlightCaseSensitive(){return localStorage.getItem('glacien.offlineLog.highlightCaseSensitive')==='true'}
function updateOfflineHighlightCaseSensitive(enabled,track=true){localStorage.setItem('glacien.offlineLog.highlightCaseSensitive',String(enabled));const toggle=$('#offlineHighlightCaseSensitive');if(toggle)toggle.checked=enabled;if(track)markOfflinePresetDirty();renderOfflineLogOutput();}
function ensureOfflineHighlightCaseToggle(){if($('#offlineHighlightCaseSensitive'))return;const controls=$('.offline-log-view-controls');if(!controls)return;const label=document.createElement('label');label.className='offline-highlight-case-toggle';label.innerHTML='<input id="offlineHighlightCaseSensitive" type="checkbox"> 颜色区分大小写';const toggle=label.querySelector('input');toggle.addEventListener('change',()=>updateOfflineHighlightCaseSensitive(toggle.checked));controls.append(label);}
function updateOfflineLogFontSize(value){localStorage.setItem('glacien.offlineLog.fontSize',value);applyOfflineLogViewSettings()}
function updateOfflineLogHighlightOpacity(value){localStorage.setItem('glacien.offlineLog.highlightOpacity',value);applyOfflineLogViewSettings()}
function applyOfflineLogViewSettings(){const size=Number(localStorage.getItem('glacien.offlineLog.fontSize')||13),opacity=Number(localStorage.getItem('glacien.offlineLog.highlightOpacity')||100);document.documentElement.style.setProperty('--offline-log-font-size',`${size}px`);document.documentElement.style.setProperty('--offline-log-highlight-opacity',`${opacity/100}`);const font=$('#offlineLogFontSize'),alpha=$('#offlineLogHighlightOpacity'),caseToggle=$('#offlineHighlightCaseSensitive');if(font){font.value=size;$('#offlineLogFontSizeValue').textContent=`${size}px`;}if(alpha){alpha.value=opacity;$('#offlineLogHighlightOpacityValue').textContent=`${opacity}%`;}if(caseToggle)caseToggle.checked=offlineHighlightCaseSensitive();}
function offlineLineHtml(text){const highlights=offlineHighlightTerms(),caseSensitive=offlineHighlightCaseSensitive(),target=caseSensitive?text:text.toLowerCase();let output='',position=0;while(position<text.length){let hit=-1,chosen=null;for(const item of highlights){const term=caseSensitive?item.term:item.term.toLowerCase(),index=target.indexOf(term,position);if(index!==-1&&(hit===-1||index<hit||(index===hit&&term.length>chosen.term.length))){hit=index;chosen={...item,term};}}if(hit===-1){output+=escapeHtml(text.slice(position));break;}if(hit>position)output+=escapeHtml(text.slice(position,hit));output+=`<mark class="highlight-${chosen.color}">${escapeHtml(text.slice(hit,hit+chosen.term.length))}</mark>`;position=hit+chosen.term.length;}return output;}
// 参考日志检索常见的 filter chips：每条条件独立描述匹配方式，
// 多条条件始终 AND。用户先筛时间，再追加关键词，就是连续缩小同一结果集。
function offlineFilterRow(filter={mode:'include_any',terms:''}){return createLogFilterRow(filter,{extraClass:'offline-filter-row',onChange:markOfflinePresetDirty,onRemove:row=>removeOfflineFilter(row.querySelector('.log-condition-remove'))})}
function setupOfflineControls(){const panel=$('.offline-filter-panel');if(!panel)return;const names={violet:'紫色',cyan:'青色',green:'绿色',yellow:'黄色',orange:'橙色',red:'红色'},colors=logColors.map(color=>`<label class="color-input ${color}"><span>${names[color]}</span><input data-offline-color="${color}" placeholder="上色关键词，逗号分隔" oninput="markOfflinePresetDirty();renderOfflineLogOutput()"></label>`).join('');panel.innerHTML='<div class="offline-source-mode"><label>扫描方式<select id="offlineSourceMode" onchange="selectOfflineSourceMode()"><option value="server">高速本地目录（rg）</option><option value="browser">浏览器文件夹（兼容模式）</option></select></label><div id="offlineServerSourceControls"><label>高速目录来源<select id="offlineServerSource"></select></label><button class="button subtle" type="button" onclick="openOfflineSourceConfig()">配置目录</button></div><div id="offlineBrowserSourceControls" hidden><span>使用页面顶部“选择日志文件夹”按钮</span></div></div><div class="offline-preset-bar"><label>过滤方案<select id="offlinePresetSelect" onchange="loadOfflineFilterPreset()"><option value="" disabled>选择已保存方案…</option></select></label><input id="offlinePresetName" placeholder="方案名称，例如：21点59分语音异常" oninput="markOfflinePresetDirty()"><button class="button subtle" type="button" onclick="saveOfflineFilterPreset()">保存方案</button><button class="button danger" id="offlinePresetDeleteButton" type="button" onclick="deleteOfflineFilterPreset()" disabled>删除</button><span class="offline-preset-state" id="offlinePresetState">未选择方案</span></div><div class="offline-filter-heading"><div><b>筛选条件</b><span>每条条件都必须满足；后加条件只会缩小结果。</span></div><button class="button subtle" type="button" onclick="addOfflineFilter()">添加条件</button></div><div id="offlineFilterRows"></div><div class="offline-filter-actions"><button class="button primary" id="offlineFilterButton" onclick="filterOfflineLogs()" disabled>过滤</button><label>另存为文件名<input id="offlineExportName" value="filtered_logs" placeholder="例如：speech_error"></label><button class="button subtle" id="offlineExportButton" onclick="downloadOfflineLogs()" disabled>另存过滤结果</button></div><div class="offline-display-toolbar"><b>显示设置</b><label>字体 <input id="offlineLogFontSize" type="range" min="11" max="22" step="1" oninput="updateOfflineLogFontSize(this.value)"><em id="offlineLogFontSizeValue">13px</em></label><label>高亮背景 <input id="offlineLogHighlightOpacity" type="range" min="10" max="100" step="5" oninput="updateOfflineLogHighlightOpacity(this.value)"><em id="offlineLogHighlightOpacityValue">100%</em></label><label class="offline-highlight-case-toggle"><input id="offlineHighlightCaseSensitive" type="checkbox" onchange="updateOfflineHighlightCaseSensitive(this.checked)"> 颜色区分大小写</label></div><div class="offline-color-grid">'+colors+'</div>';addOfflineFilter();refreshOfflineFilterPresets();refreshOfflinePresetState();refreshOfflineLogSources();selectOfflineSourceMode();enhanceOfflineSchemeSelector();}
function enhanceOfflineFilterBuilder(){
  const panel=$('.offline-filter-panel'),source=$('.offline-source-mode'),presets=$('.offline-preset-bar'),actions=$('.offline-filter-actions'),display=$('.offline-display-toolbar'),heading=$('.offline-filter-heading'),rows=$('#offlineFilterRows'),colors=$('.offline-color-grid');if(!panel||!source||!presets||!heading||!rows||$('#offlineRulePanel'))return;
  panel.classList.add('offline-filter-workspace');source.classList.add('offline-context-card');
  const rulePanel=document.createElement('section');rulePanel.id='offlineRulePanel';rulePanel.className='offline-rule-panel';presets.before(rulePanel);presets.classList.add('log-scheme-bar');const presetLabel=presets.querySelector('label');if(presetLabel?.firstChild)presetLabel.firstChild.textContent='选择方案';const presetName=$('#offlinePresetName');if(presetName&&!presetName.closest('.log-scheme-field'))wrapLogSchemeField(presetName,'方案名称');const deleteButton=$('#offlinePresetDeleteButton');if(deleteButton)deleteButton.textContent='删除方案';rulePanel.append(presets);
  const builder=document.createElement('section');builder.id='offlineFilterBuilder';builder.className='log-filter-builder offline-filter-builder';heading.classList.add('log-filter-builder-header');const title=heading.querySelector('div'),addButton=heading.querySelector('.button'),tabs=document.createElement('div');tabs.className='log-filter-mode-tabs offline-filter-mode-tabs';tabs.innerHTML='<button class="log-filter-mode-button active" data-mode="basic" type="button">基础模式</button><button class="log-filter-mode-button" data-mode="expression" type="button">表达式模式</button>';if(title)title.after(tabs);if(addButton){addButton.textContent='＋ 添加条件';addButton.classList.add('offline-basic-only','offline-filter-add');addButton.classList.remove('subtle')}rows.classList.add('log-filter-builder-body','log-condition-rows');const expression=document.createElement('div');expression.id='offlineFilterExpressionMode';expression.className='log-filter-builder-body log-filter-expression';expression.hidden=true;expression.innerHTML='<label><span>QUERY</span><textarea id="offlineFilterExpression" rows="3" placeholder="例如：all(21:59) &amp; (ASR | TTS) &amp; !(heartbeat)"></textarea></label><div class="log-filter-expression-help"><span><code>(a | b)</code> 包含任一</span><span><code>(a &amp; b)</code> 包含全部</span><span><code>!(a | b)</code> 排除任一</span><span>条件之间用 <code>&amp;</code></span></div><div class="log-filter-copy-actions"><button class="button subtle" type="button" onclick="copyLogFilterCommand(\'offline\',\'grep\')">复制为 grep</button><button class="button subtle" type="button" onclick="copyLogFilterCommand(\'offline\',\'rg\')">复制为 rg</button></div><p id="offlineFilterExpressionStatus" class="log-filter-expression-status"></p><p id="offlineFilterExpressionError" class="log-filter-expression-error" hidden></p>';rulePanel.append(builder);builder.append(heading,rows,addButton,expression);tabs.querySelectorAll('button').forEach(button=>button.onclick=()=>showOfflineFilterMode(button.dataset.mode));expression.querySelector('textarea').addEventListener('input',updateOfflineExpressionState);
  addButton?.classList.add('subtle');
  if(colors&&!$('#offlineHighlightSection')){const highlights=createLogHighlightSection('offlineHighlightSection','高亮规则','可选：为筛选结果设置颜色',colors);rulePanel.append(highlights);highlights.append(colors);}
  const saveButton=[...presets.querySelectorAll('button')].find(button=>button.textContent.includes('保存')),presetState=$('#offlinePresetState');
  if(saveButton&&presetState){const saveActions=document.createElement('div');saveActions.className='rule-actions offline-rule-actions';saveButton.className='button primary';saveActions.append(presetState,saveButton);rulePanel.append(saveActions);}
  if(display){display.classList.add('log-display-card');const title=display.querySelector('b');if(title)title.textContent='显示设置';}
  if(actions)actions.classList.add('offline-execution-card');
  const filterButton=$('#offlineFilterButton'),exportButton=$('#offlineExportButton');if(filterButton)filterButton.textContent='开始过滤';if(exportButton)exportButton.textContent='导出结果';
  // 过滤、导出属于扫描执行上下文，不占用结果区的垂直空间。
  if(actions){const divider=document.createElement('span');divider.className='offline-run-divider';divider.setAttribute('aria-hidden','true');source.append(divider,actions);}
  panel.append(source,rulePanel);if(display)panel.append(display);
}
function showOfflineFilterMode(mode){
  const rows=$('#offlineFilterRows'),expression=$('#offlineFilterExpressionMode'),add=$('.offline-basic-only');if(!rows||!expression)return;
  if(mode==='expression'){$('#offlineFilterExpression').value=formatLogFilterExpression(offlineFilterRows().map(({mode,terms})=>({mode,terms})));updateOfflineExpressionState(false);}
  else{let filters;try{filters=parseOfflineExpression()}catch(error){toast('请先修正过滤表达式：'+error.message,true);return;}rows.replaceChildren();(filters.length?filters:[{mode:'include_any',terms:[]}]).forEach(filter=>rows.append(offlineFilterRow(filter)));}
  setLogBuilderMode('offline',mode);
}
function setLogBuilderMode(scope,mode){if(scope!=='offline')return;const rows=$('#offlineFilterRows'),expression=$('#offlineFilterExpressionMode'),add=$('.offline-basic-only');if(!rows||!expression)return;rows.hidden=mode!=='basic';expression.hidden=mode!=='expression';if(add)add.hidden=mode!=='basic';$$('.offline-filter-mode-tabs .log-filter-mode-button').forEach(button=>button.classList.toggle('active',button.dataset.mode===mode));}
function parseOfflineExpression(){const value=$('#offlineFilterExpression')?.value.trim()||'';return value?parseLogFilterExpression(value):[]}
function updateOfflineExpressionState(markDirty=true){const status=$('#offlineFilterExpressionStatus'),error=$('#offlineFilterExpressionError');try{const filters=parseOfflineExpression(),count=filters.reduce((sum,filter)=>sum+filter.terms.length,0);status.textContent=filters.length?'已解析 '+filters.length+' 条条件 · '+count+' 个关键词':'尚未填写表达式';error.hidden=true;error.textContent='';if(markDirty)markOfflinePresetDirty();return filters}catch(exception){status.textContent='表达式未通过校验';error.hidden=false;error.textContent=exception.message;if(markDirty)markOfflinePresetDirty();return null}}
function addOfflineFilter(filter){const rows=$('#offlineFilterRows');rows.append(offlineFilterRow(filter));rows.lastElementChild.querySelector('.log-condition-mode').value=filter?.mode||'include_any';markOfflinePresetDirty();}
function removeOfflineFilter(button){const rows=$$('#offlineFilterRows .offline-filter-row');if(rows.length===1){rows[0].querySelector('.log-condition-terms').value='';markOfflinePresetDirty();return;}button.closest('.offline-filter-row').remove();markOfflinePresetDirty();}
function offlineFilterRows(){const expression=$('#offlineFilterExpressionMode');if(expression&&!expression.hidden){try{return parseOfflineExpression().map((filter,index)=>({...filter,index:index+1}))}catch(error){return []}}return $$('#offlineFilterRows .offline-filter-row').map((row,index)=>({index:index+1,mode:row.querySelector('.log-condition-mode').value,terms:words(row.querySelector('.log-condition-terms').value)})).filter(filter=>filter.terms.length);}
function offlineFilterValues(){return offlineFilterRows().map(filter=>({...filter,terms:filter.terms.map(word=>word.toLowerCase())}));}
function offlineFilterDescription(filters){return filters.map(filter=>`${filter.index}.${{include_any:'包含任一',include_all:'包含全部',exclude_any:'排除任一'}[filter.mode]}：${filter.terms.join('、')}`).join('；');}
function offlineFilterPresets(){return state.config?.offline_filter_presets||{}}
function offlineHighlightConfig(){const highlights={};for(const input of $$('[data-offline-color]')){const terms=words(input.value);if(terms.length)highlights[input.dataset.offlineColor]=terms;}return {highlights,highlight_case_sensitive:offlineHighlightCaseSensitive()};}
function offlinePresetPayload(){return {filters:offlineFilterRows().map(({mode,terms})=>({mode,terms})),...offlineHighlightConfig()};}
function offlinePresetSignature(payload=offlinePresetPayload()){const canonical={filters:(payload.filters||[]).map(({mode,terms})=>({mode,terms:[...(terms||[])]})),highlights:{},highlight_case_sensitive:Boolean(payload.highlight_case_sensitive)};for(const color of logColors){const terms=payload.highlights?.[color]||[];if(terms.length)canonical.highlights[color]=[...terms];}return JSON.stringify(canonical);}
function offlinePresetDirty(){const loaded=state.offlinePreset.loadedName,current=offlinePresetSignature();if(loaded)return current!==state.offlinePreset.baseline||$('#offlinePresetName').value.trim()!==loaded;return Boolean($('#offlinePresetName').value.trim()||current!==JSON.stringify({filters:[],highlights:{},highlight_case_sensitive:false}));}
function refreshOfflinePresetState(){const label=$('#offlinePresetState');if(!label)return;const loaded=state.offlinePreset.loadedName,dirty=offlinePresetDirty();label.className='log-rule-draft-state offline-preset-state '+(dirty?'dirty':'saved');label.textContent=loaded?(dirty?'已修改，未保存':'已保存'):(dirty?'未保存的新方案':'未选择方案');}
function markOfflinePresetDirty(){refreshOfflinePresetState();}
function setOfflinePresetBaseline(name){state.offlinePreset={loadedName:name||'',baseline:offlinePresetSignature()};refreshOfflinePresetState();}
function unbindOfflinePreset(){state.offlinePreset={loadedName:'',baseline:JSON.stringify({filters:[],highlights:{},highlight_case_sensitive:false})};refreshOfflinePresetState();}
function restoreOfflinePreset(name){const preset=normalizeOfflinePreset(offlineFilterPresets()[name]);$('#offlineFilterRows').innerHTML='';(preset.filters.length?preset.filters:[{mode:'include_any',terms:[]}]).forEach(addOfflineFilter);if($('#offlineFilterExpression'))$('#offlineFilterExpression').value=formatLogFilterExpression(preset.filters);applyOfflineHighlightConfig(preset);$('#offlinePresetSelect').value=name;$('#offlinePresetName').value=name;$('#offlinePresetDeleteButton').disabled=false;setLogBuilderMode('offline','basic');setOfflinePresetBaseline(name);}
function resetOfflinePresetEditor(){const empty={filters:[],highlights:{},highlight_case_sensitive:false};$('#offlineFilterRows').innerHTML='';addOfflineFilter();if($('#offlineFilterExpression'))$('#offlineFilterExpression').value='';applyOfflineHighlightConfig(empty);$('#offlinePresetSelect').value='';$('#offlinePresetName').value='';$('#offlinePresetDeleteButton').disabled=true;setLogBuilderMode('offline','basic');state.offlinePreset={loadedName:'',baseline:offlinePresetSignature(empty)};refreshOfflinePresetState();}
function discardOfflinePresetChanges(){const name=state.offlinePreset.loadedName;if(name&&offlineFilterPresets()[name])restoreOfflinePreset(name);else resetOfflinePresetEditor();}
function confirmDiscardOfflinePresetChanges(action){if(!offlinePresetDirty())return true;if(!confirm(`当前离线过滤方案有未保存修改。${action}将丢弃这些修改，是否继续？`))return false;discardOfflinePresetChanges();return true;}
function applyOfflineHighlightConfig(config={}){const highlights=config?.highlights||{};for(const input of $$('[data-offline-color]'))input.value=(highlights[input.dataset.offlineColor]||[]).join(', ');updateOfflineHighlightCaseSensitive(Boolean(config?.highlight_case_sensitive),false);}
function normalizeOfflinePreset(raw){const modes=new Set(['include_any','include_all','exclude_any']),source=Array.isArray(raw)?{filters:raw}:raw||{},filters=Array.isArray(source.filters)?source.filters:[],highlights={};for(const color of logColors){const terms=Array.isArray(source.highlights?.[color])?source.highlights[color].map(term=>String(term).trim()).filter(Boolean):[];if(terms.length)highlights[color]=terms;}return {filters:filters.map(item=>({mode:modes.has(item?.mode)?item.mode:'include_any',terms:Array.isArray(item?.terms)?item.terms.map(term=>String(term).trim()).filter(Boolean):[]})).filter(item=>item.terms.length),highlights,highlight_case_sensitive:Boolean(source.highlight_case_sensitive)};}
function refreshOfflineFilterPresets(selected=''){const select=$('#offlinePresetSelect'),remove=$('#offlinePresetDeleteButton');if(!select)return;const presets=offlineFilterPresets(),current=selected||select.value;select.innerHTML='<option value="" disabled>选择已保存方案…</option>'+Object.keys(presets).sort().map(name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');select.value=Object.prototype.hasOwnProperty.call(presets,current)?current:'';if(remove)remove.disabled=!select.value;}
function loadOfflineFilterPreset(){const name=$('#offlinePresetSelect').value;if(!name){if(!confirmDiscardOfflinePresetChanges('取消当前方案选择')){$('#offlinePresetSelect').value=state.offlinePreset.loadedName;return;}resetOfflinePresetEditor();return;}if(name!==state.offlinePreset.loadedName&&!confirmDiscardOfflinePresetChanges(`切换到方案“${name}”`)){$('#offlinePresetSelect').value=state.offlinePreset.loadedName;return;}restoreOfflinePreset(name);$('#offlineResultStatus').textContent=`已导入过滤方案“${name}”，选择日志来源后点击“开始过滤”。`}
async function saveOfflineFilterPreset(){const name=$('#offlinePresetName').value.trim(),expression=$('#offlineFilterExpressionMode');if(expression&&!expression.hidden){try{parseOfflineExpression()}catch(error){return toast('请先修正过滤表达式：'+error.message,true)}}const payload=offlinePresetPayload();if(!name)return toast('请填写方案名称',true);if(!payload.filters.length)return toast('请至少填写一条筛选条件',true);const updating=Object.prototype.hasOwnProperty.call(offlineFilterPresets(),name);state.config.offline_filter_presets={...offlineFilterPresets(),[name]:payload};try{await api('/api/config',{method:'POST',body:JSON.stringify(state.config)});state.config=await api('/api/config');$('#offlinePresetName').value=name;refreshOfflineFilterPresets(name);setOfflinePresetBaseline(name);toast(updating?'过滤方案“'+name+'”已更新':'过滤方案“'+name+'”已保存');}catch(error){toast(error.message,true)}}
async function deleteOfflineFilterPreset(){const name=$('#offlinePresetSelect').value;if(!name)return;if(!confirm(`确认删除过滤方案“${name}”？`))return;delete state.config.offline_filter_presets[name];try{await api('/api/config',{method:'POST',body:JSON.stringify(state.config)});state.config=await api('/api/config');$('#offlinePresetName').value='';refreshOfflineFilterPresets();setOfflinePresetBaseline('');toast(`过滤方案“${name}”已删除`);}catch(error){toast(error.message,true)}}
function formatOfflineProgress(bytes){return formatSize(bytes||0)}
function ensureOfflineCancelButton(){if($('#offlineCancelButton'))return;const clear=[...document.querySelectorAll('#offline-logs .button')].find(button=>button.textContent.includes('清空来源'));if(!clear)return;const button=document.createElement('button');button.id='offlineCancelButton';button.className='button subtle';button.textContent='停止扫描';button.hidden=true;button.onclick=stopOfflineScan;clear.before(button);}
function relocateOfflineBrowserControls(){const browser=$('#offlineBrowserSourceControls'),root=$('#offline-logs');if(!browser||!root)return;const legacyIntro=[...root.querySelectorAll(':scope>.page-description')].find(item=>item.textContent.includes('日志只在浏览器本地读取'));legacyIntro?.remove();browser.innerHTML='<span>浏览器模式仅在本地读取，不上传服务端，并跳过 NUL/gzip 二进制文件。</span><label class="button subtle upload-button">选择日志文件<input id="offlineFileInput" type="file" multiple onchange="loadOfflineLogFolder(this.files)"></label>';const folderControl=$('#offlineFolderInput')?.closest('label');const clear=[...root.querySelectorAll('.button')].find(button=>button.textContent.includes('清空来源'));if(folderControl)browser.append(folderControl);if(clear)browser.append(clear);const serverOption=$('#offlineSourceMode option[value="server"]'),browserOption=$('#offlineSourceMode option[value="browser"]'),serverLabel=$('#offlineServerSourceControls label'),configButton=$('#offlineServerSourceControls button');if(serverOption)serverOption.textContent='高速本地来源（rg）';if(browserOption)browserOption.textContent='浏览器文件/文件夹（兼容模式）';if(serverLabel?.firstChild)serverLabel.firstChild.textContent='高速日志来源';if(configButton)configButton.textContent='配置来源';}
async function refreshOfflineRgCapability(){
  const mode=$('#offlineSourceMode');if(!mode)return;
  try{const result=await api('/api/offline-logs/status');state.offline.rgAvailable=Boolean(result.available);state.offline.rgPath=result.path||'';const option=mode.querySelector('option[value="server"]');if(option){option.disabled=!state.offline.rgAvailable;option.textContent=state.offline.rgAvailable?'高速本地来源（rg，可用）':'高速本地来源（未安装 rg）'}if(!state.offline.rgAvailable&&mode.value==='server')mode.value='browser';selectOfflineSourceMode()}catch(error){state.offline.rgAvailable=false;state.offline.rgPath='';selectOfflineSourceMode()}
}
function updateOfflineSourceControlAvailability(){const server=offlineSourceMode()==='server',browser=$('#offlineBrowserSourceControls'),serverControls=$('#offlineServerSourceControls'),file=$('#offlineFileInput'),folder=$('#offlineFolderInput'),source=$('#offlineServerSource'),cancel=$('#offlineCancelButton');if(browser)browser.hidden=server;if(serverControls)serverControls.hidden=!server;if(file)file.disabled=server;if(folder)folder.disabled=server;if(source)source.disabled=!server;if(serverControls){for(const button of serverControls.querySelectorAll('button'))button.disabled=!server;}if(browser){for(const button of browser.querySelectorAll('button'))button.disabled=server;}if(cancel){cancel.hidden=!state.offline.scanning||server;cancel.disabled=server||!state.offline.scanning;}}
function setOfflineScanControls(scanning){state.offline.scanning=scanning;updateOfflineSourceControlAvailability();const ready=offlineSourceMode()==='server'?Boolean($('#offlineServerSource')?.value):Boolean(state.offline.files.length);$('#offlineFilterButton').disabled=scanning||!ready;}
async function refreshOfflineLogSources(){try{state.offline.sources=await api('/api/offline-log-sources');const select=$('#offlineServerSource'),current=select?.value;if(!select)return;const available=state.offline.sources.filter(item=>item.available);select.innerHTML='<option value="">选择高速日志来源…</option>'+state.offline.sources.map(item=>`<option value="${escapeHtml(item.name)}" ${item.available?'':'disabled'}>${escapeHtml(item.name)}${item.available?`（${item.kind==='file'?'文件':'文件夹'}）`:`（${escapeHtml(item.error||'来源不可用')}）`}</option>`).join('');if(available.some(item=>item.name===current))select.value=current;else if(available.length===1)select.value=available[0].name;select.onchange=()=>setOfflineScanControls(false);setOfflineScanControls(false);}catch(error){toast(error.message,true)}}
function offlineSourceMode(){return $('#offlineSourceMode')?.value||'browser'}
function selectOfflineSourceMode(){if(state.offline.scanning)stopOfflineScan();const server=offlineSourceMode()==='server',available=state.offline.rgAvailable,path=state.offline.rgPath;$('#offlineSourceStatus').textContent=server?`原生 rg 可用${path?'：'+path:''}；选择已保存的日志文件或文件夹，点击“过滤”高速扫描。`:available?`原生 rg 可用${path?'：'+path:''}；也可直接选择日志文件或文件夹，本地读取且不上传服务端，并跳过 NUL/gzip 二进制文件。`:'未检测到原生 rg，当前使用浏览器兼容模式；日志仅在本地读取且不上传服务端，并跳过 NUL/gzip 二进制文件。';setOfflineScanControls(false);}
function offlineSourceRow(name='',path=''){return `<div class="offline-source-form-row"><label><span>来源名称</span><input class="offline-source-name" value="${escapeHtml(name)}" placeholder="例如：E68 runlog"></label><label><span>日志文件或文件夹</span><span class="offline-source-path-control"><input class="offline-source-path" value="${escapeHtml(path)}" placeholder="请选择文件或文件夹，浏览器版也可填写绝对路径"><span class="offline-source-actions"><button class="button subtle" type="button" onclick="chooseOfflineSourceFile(this)">选择文件</button><button class="button subtle" type="button" onclick="chooseOfflineSourceDirectory(this)">选择文件夹</button></span></span></label><button class="button danger subtle-delete" type="button" onclick="removeOfflineSourceRow(this)">移除</button></div>`}
function offlineSourceEditor(sources){const rows=Object.entries(sources||{}).map(([name,path])=>offlineSourceRow(name,path)).join('')||offlineSourceRow();return `<div class="offline-source-editor"><p class="page-description">桌面版可直接选择日志文件或文件夹。目录来源会检测压缩日志并在确认后安全解压；单独的压缩文件请改为选择其所在文件夹。</p><div id="offlineSourceRows">${rows}</div><div><button class="button subtle" type="button" onclick="addOfflineSourceRow()">添加来源</button></div></div>`}
function addOfflineSourceRow(){$('#offlineSourceRows').insertAdjacentHTML('beforeend',offlineSourceRow());}
async function chooseOfflineSourceDirectory(button){const row=button.closest('.offline-source-form-row'),input=row.querySelector('.offline-source-path');if(!desktopBridge?.choose_directory)return toast('桌面目录选择器不可用，请填写绝对路径',true);button.disabled=true;button.textContent='选择中…';try{const selected=await new Promise(resolve=>desktopBridge.choose_directory(input.value.trim(),resolve));if(!selected)return;input.value=selected;const name=row.querySelector('.offline-source-name');if(!name.value.trim())name.value=selected.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||'离线日志';}finally{button.disabled=false;button.textContent='选择目录';}}
async function chooseOfflineSourceFile(button){const row=button.closest('.offline-source-form-row'),input=row.querySelector('.offline-source-path');if(!desktopBridge?.choose_file)return toast('桌面文件选择器不可用，请填写绝对路径',true);button.disabled=true;button.textContent='选择中…';try{const selected=await new Promise(resolve=>desktopBridge.choose_file(input.value.trim(),resolve));if(!selected)return;input.value=selected;const name=row.querySelector('.offline-source-name');if(!name.value.trim())name.value=selected.split(/[\\/]/).pop()||'离线日志';}finally{button.disabled=false;button.textContent='选择文件';}}
async function confirmAndExtractOfflineArchives(source){const status=await api('/api/offline-logs/archives?source='+encodeURIComponent(source)),archives=status.archives||[];if(!archives.length)return null;const preview=archives.slice(0,8).join('\n'),more=archives.length>8?`\n…另有 ${archives.length-8} 个`:'';if(!confirm(`目录“${source}”发现 ${archives.length} 个压缩日志。\n\n确认后将解压到各压缩包所在目录，并在成功后删除原压缩包。已有同名目标时会跳过，不覆盖也不删除原包。\n\n${preview}${more}\n\n是否继续？`))return {cancelled:true,archives:archives.length};return api('/api/offline-logs/extract',{method:'POST',body:JSON.stringify({source,confirmed:true})});}
function removeOfflineSourceRow(button){const rows=$$('#offlineSourceRows .offline-source-form-row');if(rows.length===1){rows[0].querySelector('.offline-source-name').value='';rows[0].querySelector('.offline-source-path').value='';return;}button.closest('.offline-source-form-row').remove();}
function readOfflineSourcesForm(){const sources={};for(const row of $$('#offlineSourceRows .offline-source-form-row')){const name=row.querySelector('.offline-source-name').value.trim(),path=row.querySelector('.offline-source-path').value.trim(),windowsAbsolute=path.length>=3&&/^[A-Za-z]:$/.test(path.slice(0,2))&&(path[2]==='/'||path[2]==='\\');if(!name&&!path)continue;if(!name)throw new Error('请填写日志来源名称');if(!path)throw new Error(`${name} 必须使用绝对路径`);if(!path.startsWith('/')&&!windowsAbsolute)throw new Error(`${name} 必须使用绝对路径`);if(sources[name])throw new Error(`日志来源名称重复：${name}`);sources[name]=path;}return sources;}
function openOfflineSourceConfig(){openFeatureModal('offline-sources','高速日志来源',offlineSourceEditor(state.config.offline_log_sources));}
async function saveOfflineSourceConfig(){try{const sources=readOfflineSourcesForm();await saveConfigDomain('offline_logs',{offline_log_sources:sources});let extracted=0,skipped=0,cancelled=0;for(const source of Object.keys(sources)){const result=await confirmAndExtractOfflineArchives(source);if(!result)continue;if(result.cancelled){cancelled+=result.archives;continue;}extracted+=result.extracted||0;skipped+=(result.skipped||[]).length;}closeFeatureConfig();await refreshOfflineLogSources();const detail=extracted||skipped||cancelled?`；已解压替换 ${extracted} 个，跳过 ${skipped} 个，取消 ${cancelled} 个`:'';toast('高速日志来源已保存'+detail,Boolean(skipped));}catch(error){toast(error.message,true)}}
function loadOfflineLogFolder(files){cancelOfflineScan();const list=[...files].sort((a,b)=>(a.webkitRelativePath||a.name).localeCompare(b.webkitRelativePath||b.name));const totalBytes=list.reduce((sum,file)=>sum+file.size,0);state.offline={...state.offline,files:list.map(file=>({name:file.webkitRelativePath||file.name,file,size:file.size})),results:[],rendered:0,skipped:0,worker:null,scanning:false,totalBytes};$('#offlineSourceStatus').textContent=`已选择 ${list.length} 个文件 · ${formatOfflineProgress(totalBytes)}。选择条件后点击“过滤”开始分块扫描。`;$('#offlineResultStatus').textContent='选择来源不会读取完整日志；点击“过滤”后才开始扫描。';$('#offlineLogOutput').innerHTML='<span class="log-hint">日志来源已准备好，等待手动过滤。</span>';$('#offlineExportButton').disabled=true;$('#offlineLoadMore').hidden=true;setOfflineScanControls(false);}
function clearOfflineLogs(){cancelOfflineScan();state.offline={files:[],results:[],rendered:0,skipped:0,worker:null,scanning:false,totalBytes:0,rgAvailable:state.offline.rgAvailable,rgPath:state.offline.rgPath,sources:state.offline.sources||[]};if($('#offlineFileInput'))$('#offlineFileInput').value='';if($('#offlineFolderInput'))$('#offlineFolderInput').value='';selectOfflineSourceMode();$('#offlineResultStatus').textContent='设置条件后点击“过滤”，显示所有来源文件中的匹配日志。';$('#offlineLogOutput').innerHTML='<span class="log-hint">尚未选择日志来源。</span>';$('#offlineExportButton').disabled=true;$('#offlineLoadMore').hidden=true;setOfflineScanControls(false);}
function cancelOfflineScan(){if(state.offline?.worker){state.offline.worker.postMessage({type:'cancel'});state.offline.worker.terminate();state.offline.worker=null;}if(state.offline)state.offline.scanning=false;}
function stopOfflineScan(){if(!state.offline.scanning)return;cancelOfflineScan();setOfflineScanControls(false);$('#offlineSourceStatus').textContent='扫描已停止。';$('#offlineResultStatus').textContent=`已停止扫描，保留 ${state.offline.results.length} 条已命中日志。`;renderOfflineLogOutput(true);}
function updateOfflineScanProgress(progress){const percent=progress.totalBytes?Math.min(100,Math.round(progress.bytes/progress.totalBytes*100)):0;$('#offlineSourceStatus').textContent=`正在扫描 ${progress.filesDone}/${progress.filesTotal} 个文件 · ${formatOfflineProgress(progress.bytes)}/${formatOfflineProgress(progress.totalBytes)} · ${percent}%${progress.skipped?` · 跳过 ${progress.skipped} 个二进制文件`:''}`;$('#offlineResultStatus').textContent=`已命中 ${state.offline.results.length} 条日志，扫描仍在继续…`;}
function wildcardTermMatches(term,target){const lower=term.toLowerCase(),parts=lower.split('*');if(parts.length===1)return target.includes(lower);let pos=0;for(let i=0;i<parts.length;i++){const part=parts[i];if(!part)continue;const idx=target.indexOf(part,pos);if(idx<0)return false;if(i===0&&!lower.startsWith('*')&&idx!==0)return false;pos=idx+part.length}if(!lower.endsWith('*')&&parts[parts.length-1]){if(!target.endsWith(parts[parts.length-1]))return false}return true}
function offlineLineMatches(line,filter){const target=line.toLowerCase();if(filter.mode==='include_all')return filter.terms.every(term=>wildcardTermMatches(term,target));if(filter.mode==='exclude_any')return !filter.terms.some(term=>wildcardTermMatches(term,target));return filter.terms.some(term=>wildcardTermMatches(term,target));}
async function filterOfflineLogs(){const filters=offlineFilterValues();if(!filters.length)return toast('请至少填写一条筛选条件',true);if(offlineSourceMode()==='server'){const source=$('#offlineServerSource').value;if(!source)return toast('请选择高速日志来源',true);const button=$('#offlineFilterButton');button.disabled=true;button.textContent='rg 扫描中…';try{$('#offlineLogOutput').innerHTML='<span class="log-hint">正在使用原生 rg 高速扫描日志…</span>';const result=await api('/api/offline-logs/query',{method:'POST',body:JSON.stringify({source,filters})});state.offline.results=result.results||[];state.offline.rendered=0;$('#offlineSourceStatus').textContent=`高速扫描完成：${result.source} · ${result.elapsed_seconds}s`; renderOfflineLogOutput(true);}catch(error){toast(error.message,true);$('#offlineLogOutput').innerHTML='<span class="log-hint">高速扫描失败。</span>';}finally{button.disabled=false;button.textContent='过滤';}return;}if(!state.offline.files.length)return toast('请先选择日志文件或文件夹',true);cancelOfflineScan();state.offline.results=[];state.offline.rendered=0;state.offline.skipped=0;const worker=new Worker('/offline_log_worker.js');state.offline.worker=worker;setOfflineScanControls(true);$('#offlineLogOutput').innerHTML='<span class="log-hint">正在后台分块扫描日志，可随时停止。</span>';worker.onerror=error=>{cancelOfflineScan();setOfflineScanControls(false);toast(`离线日志 Worker 失败：${error.message}`,true);};worker.onmessage=event=>{const data=event.data;if(data.type==='matches'){state.offline.results.push(...data.matches);return;}if(data.type==='progress'){state.offline.skipped=data.skipped||0;updateOfflineScanProgress(data);return;}if(data.type==='error'){cancelOfflineScan();setOfflineScanControls(false);toast(`离线日志扫描失败：${data.message}`,true);return;}if(data.type==='cancelled'){state.offline.worker=null;setOfflineScanControls(false);$('#offlineResultStatus').textContent=`已停止扫描，保留 ${state.offline.results.length} 条已命中日志。`;renderOfflineLogOutput(true);return;}if(data.type==='done'){state.offline.worker=null;state.offline.skipped=data.skipped||0;setOfflineScanControls(false);$('#offlineSourceStatus').textContent=`扫描完成 ${data.filesDone}/${data.filesTotal} 个文件 · ${formatOfflineProgress(data.bytes)}${data.skipped?` · 跳过 ${data.skipped} 个二进制文件`:''}`;renderOfflineLogOutput(true);}};worker.postMessage({type:'scan',files:state.offline.files,filters,totalBytes:state.offline.totalBytes});}
function renderOfflineLogOutput(reset=true){if(reset)state.offline.rendered=0;const output=$('#offlineLogOutput'),start=state.offline.rendered,end=Math.min(start+offlinePageSize,state.offline.results.length);if(reset)output.innerHTML='';for(const item of state.offline.results.slice(start,end)){const row=document.createElement('span');row.className=`log-line ${logSeverityClass(item.text)}`;row.innerHTML=`<small class="offline-source">${escapeHtml(item.file)}:${item.line}</small>${offlineLineHtml(item.text)}`;output.appendChild(row);}state.offline.rendered=end;const files=new Set(state.offline.results.map(item=>item.file)).size,description=offlineFilterDescription(offlineFilterValues()),loadMore=$('#offlineLoadMore'),complete=state.offline.rendered>=state.offline.results.length;$('#offlineResultStatus').textContent=`${state.offline.results.length} 条匹配日志，来自 ${files} 个文件；${description}；当前显示 ${end} 条。`;$('#offlineExportButton').disabled=!state.offline.results.length;loadMore.hidden=complete;loadMore.disabled=complete;if(!state.offline.results.length)output.innerHTML='<span class="log-hint">没有匹配日志。</span>';}
function downloadOfflineLogs(){if(!state.offline.results.length)return;let name=$('#offlineExportName').value.trim()||'filtered_logs';name=name.replace(/[\\/:*?"<>|]+/g,'_');if(!name.toLowerCase().endsWith('.log'))name+='.log';const filters=offlineFilterValues(),header=['# Glacien offline log filter',...filters.map(filter=>`# ${filter.index}. ${{include_any:'Include any',include_all:'Include all',exclude_any:'Exclude any'}[filter.mode]}: ${filter.terms.join(', ')}`),`# Matches: ${state.offline.results.length}`,''];let currentFile='';const body=[];for(const item of state.offline.results){if(item.file!==currentFile){currentFile=item.file;body.push('',`# Source: ${currentFile}`);}body.push(item.text);}const url=URL.createObjectURL(new Blob([[...header,...body].join('\n')+'\n'],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();URL.revokeObjectURL(url);toast(`已另存 ${state.offline.results.length} 条日志：${name}`);}

async function refreshAll(){await refreshStatus();if(state.page==='apks')switchApkTab(state.apkTab||'local');if(state.page==='processes')loadProcesses();}

// 设备日志 Pull：设备路径只由已保存日志源决定，浏览器只提交来源名称和文件名。
function deviceLogSourceName(){return $('#deviceLogSource')?.value||''}
async function refreshDeviceLogSources(){
  const select=$('#deviceLogSource');if(!select)return;
  try{const current=select.value;state.deviceLogs.sources=await api('/api/device-log-sources');const names=Object.keys(state.deviceLogs.sources);select.innerHTML=names.length?names.map(name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join(''):'<option value="">尚未配置日志源</option>';select.value=names.includes(current)?current:(names[0]||'');$('#deviceLogScanButton').disabled=!select.value;}catch(error){toast(error.message,true)}
}
function hideDeviceLogRevealButton(){const button=$('#deviceLogRevealButton');if(button){button.hidden=true;button.dataset.folderId=''}}
function resetDeviceLogResults(){state.deviceLogs.files=[];state.deviceLogs.result=null;hideDeviceLogRevealButton();$('#deviceLogList').innerHTML='<div class="device-log-empty">日志源已切换，请重新扫描。</div>';$('#deviceLogStatus').textContent='请选择是否设置时间段，然后扫描设备目录。';updateDeviceLogSelection()}
function clearDeviceLogTimeFilter(){$('#deviceLogStart').value='';$('#deviceLogEnd').value='';}
function deviceLogRequest(){return withAdbSerial({source:deviceLogSourceName(),start:$('#deviceLogStart').value,end:$('#deviceLogEnd').value})}
function deviceLogTimeText(item){if(!item.time_start)return '时间未知';const start=new Date(item.time_start).toLocaleString(),end=item.time_end&&item.time_end!==item.time_start?new Date(item.time_end).toLocaleString():'';return end?start+' — '+end:start}
function renderDeviceLogList(){
  const list=$('#deviceLogList'),files=state.deviceLogs.files||[];if(!files.length){const filtered=state.deviceLogs.result?.time_filter_applied&&state.deviceLogs.result?.time_filter_available;list.innerHTML=`<div class="device-log-empty">${filtered?'没有符合时间范围的日志文件。':'目录中没有符合规则的日志文件。'}</div>`;updateDeviceLogSelection();return;}
  list.innerHTML=files.map((item,index)=>{const checked=state.deviceLogs.result?.time_filter_applied&&item.suggested?' checked':'',warning=item.time_warning?`<span class="device-log-warning">${escapeHtml(item.time_warning)}</span>`:'',confidence={high:'高可信度',low:'低可信度',unknown:'时间未知'}[item.time_confidence]||'时间未知';return `<label class="device-log-row"><input class="check device-log-check" type="checkbox" data-index="${index}"${checked} onchange="updateDeviceLogSelection()"><span class="file-icon">GZ</span><span class="device-log-main"><b>${escapeHtml(item.name)}</b><span>${formatSize(item.size)} · 设备修改时间 ${new Date(item.mtime*1000).toLocaleString()}</span><span>识别时间：${escapeHtml(deviceLogTimeText(item))} · ${escapeHtml(item.time_source)} · ${confidence}</span>${warning}</span>${item.suggested?'<span class="tag">时间命中</span>':''}</label>`}).join('');updateDeviceLogSelection();
}
function updateDeviceLogSelection(){const checks=$$('.device-log-check'),selected=checks.filter(item=>item.checked);$('#deviceLogSelection').textContent='已选择 '+selected.length+' 个文件';$('#deviceLogPullButton').disabled=!selected.length||state.deviceLogs.pulling;const all=$('#deviceLogSelectAll');if(all){all.checked=Boolean(checks.length)&&selected.length===checks.length;all.indeterminate=selected.length>0&&selected.length<checks.length}}
function toggleAllDeviceLogs(checked){$$('.device-log-check').forEach(item=>item.checked=checked);updateDeviceLogSelection()}
async function scanDeviceLogs(){
  if(!deviceLogSourceName())return toast('请先配置并选择日志源',true);const start=$('#deviceLogStart').value,end=$('#deviceLogEnd').value;if(start&&end&&end<start)return toast('结束时间不能早于开始时间',true);
  const button=$('#deviceLogScanButton');hideDeviceLogRevealButton();button.disabled=true;button.textContent='扫描中…';$('#deviceLogStatus').textContent='正在读取设备日志目录…';
  try{const result=await api('/api/device-logs/scan',{method:'POST',body:JSON.stringify(deviceLogRequest())});state.deviceLogs.result=result;state.deviceLogs.files=result.files||[];let summary=`共 ${result.count} 个文件`;if(result.time_filter_applied&&result.time_filter_available)summary=`从 ${result.total_count} 个文件中筛出 ${result.count} 个时间匹配项`;else if(result.time_filter_applied)summary=`共 ${result.count} 个文件，未识别到可靠文件时间，请手动勾选`;$('#deviceLogStatus').textContent=`${result.source} · ${result.device_directory} · ${summary}`;renderDeviceLogList()}catch(error){state.deviceLogs.files=[];$('#deviceLogList').innerHTML='<div class="device-log-empty">扫描失败。</div>';$('#deviceLogStatus').textContent=error.message;toast(error.message,true)}finally{button.disabled=!deviceLogSourceName();button.textContent='扫描目录'}
}
async function pullSelectedDeviceLogs(){
  const files=$$('.device-log-check:checked').map(input=>state.deviceLogs.files[Number(input.dataset.index)]?.name).filter(Boolean);if(!files.length)return toast('请至少选择一个日志文件',true);
  const button=$('#deviceLogPullButton');state.deviceLogs.pulling=true;button.disabled=true;button.textContent='Pull 中…';
  try{const result=await api('/api/device-logs/pull',{method:'POST',body:JSON.stringify({...deviceLogRequest(),files,extract:Boolean($('#deviceLogExtract').checked)})});$('#deviceLogStatus').textContent=`已 Pull ${result.files} 个文件到 ${result.folder}${result.extracted.length?'，并解压 '+result.extracted.length+' 个 gzip 文件':''}`;const reveal=$('#deviceLogRevealButton');reveal.dataset.folderId=result.folder_id;reveal.hidden=false;toast('设备日志 Pull 完成：'+result.folder)}catch(error){hideDeviceLogRevealButton();$('#deviceLogStatus').textContent='Pull 失败：'+error.message;toast(error.message,true)}finally{state.deviceLogs.pulling=false;button.textContent='Pull 所选日志';updateDeviceLogSelection()}
}
async function revealDeviceLogPullFolder(){const button=$('#deviceLogRevealButton'),folderId=button?.dataset.folderId;if(!folderId)return;button.disabled=true;try{const result=await api('/api/device-logs/reveal',{method:'POST',body:JSON.stringify({folder_id:folderId})});toast(result.ok?'已打开 Pull 文件夹：'+result.directory:'打开文件夹失败：'+(result.error||result.directory),!result.ok)}catch(error){toast(error.message,true)}finally{button.disabled=false}}

function selectDeviceToolTab(tab){
  if(tab!=='captures')stopContinuousCapture();
  state.deviceFiles.tab=tab;
  $$('.device-tool-tab').forEach(button=>button.classList.toggle('active',button.dataset.deviceToolTab===tab));
  $$('.device-tool-panel').forEach(panel=>panel.classList.toggle('visible',panel.id===`device-tool-${tab}`));
  if(tab==='files')loadDeviceFiles();
  if(tab==='captures'){refreshCaptureOverview();refreshCaptureTools();}
  if(tab==='logs')refreshDeviceLogSources();
}
function selectAdbOperationTab(tab){
  if(tab==='broadcast'&&state.adbOperationTab==='commands'&&!confirmDiscardAdbCommandChanges('切换到发送广播'))return;
  if(tab==='broadcast'&&state.featureConfigKind==='command-editor')closeFeatureConfig();
  state.adbOperationTab=tab;
  $$('.workspace-tab[data-workspace-tab]').forEach(button=>button.classList.toggle('active',button.dataset.workspaceTab===tab));
  $$('.workspace-tab-panel').forEach(panel=>panel.classList.toggle('visible',panel.id===`adb-operation-${tab}`));
  if(tab==='commands')refreshAdbCommandPresets();
  if(tab==='broadcast')loadBroadcasts();
}
function deviceFilePath(){return $('#deviceFilePath')?.value.trim()||state.deviceFiles.path||'/sdcard'}
function deviceFileRequest(path=deviceFilePath()){return apiPathWithSerial(`/api/device-files/list?path=${encodeURIComponent(path)}`)}
function deviceFileBreadcrumbs(path){
  const root=$('#deviceFileBreadcrumbs');if(!root)return;const parts=path.split('/').filter(Boolean),items=[`<button type="button" class="device-file-root" onclick="loadDeviceFiles('/')">设备根目录 /</button>`];let current='';
  for(const part of parts){current+='/'+part;items.push(`<span>/</span><button type="button" data-path="${escapeHtml(current)}" onclick="loadDeviceFiles(this.dataset.path)">${escapeHtml(part)}</button>`)}
  root.innerHTML=items.join('');
}
function renderDeviceFiles(){
  const list=$('#deviceFileList'),items=state.deviceFiles.entries;if(!list)return;deviceFileBreadcrumbs(state.deviceFiles.path);$('#deviceFilePath').value=state.deviceFiles.path;$('#deviceFileUpButton').disabled=!state.deviceFiles.parent;
  if(!items.length){list.innerHTML='<div class="device-file-empty">当前目录为空。</div>';updateDeviceFileSelection();return;}
  list.innerHTML=items.map((item,index)=>{const directory=item.type==='directory',icon=directory?'DIR':'FILE',action=directory?`onclick="openDeviceDirectory(${index})"`:`onclick="openDeviceFilePreview(${index})"`,size=Number.isFinite(Number(item.size))?formatSize(Number(item.size)):'大小未知',modified=Number.isFinite(Number(item.modified))?new Date(Number(item.modified)*1000).toLocaleString():'时间未知',pullLabel=directory?'Pull (zip)':'Pull';return `<div class="device-file-row${directory?' directory':''}"><input class="check device-file-check" type="checkbox" data-index="${index}" onchange="updateDeviceFileSelection()"><button class="device-file-main" type="button" ${action}><span class="file-icon">${icon}</span><span><b>${escapeHtml(item.name)}</b><small>${directory?'目录':size} · ${modified} · ${escapeHtml(item.permissions||'权限未知')}</small></span></button><span class="device-file-actions"><button class="button subtle" type="button" onclick="pullDeviceFile(${index},this)">${pullLabel}</button><button class="button danger" type="button" onclick="deleteDeviceFile(${index})">删除</button></span></div>`}).join('');updateDeviceFileSelection();
}
function deviceFileCreateFields(includeContent=false){return `<div class="device-file-create-form"><p class="page-description">创建位置：<code>${escapeHtml(state.deviceFiles.path)}</code></p><label class="feature-field"><span>${includeContent?'文件名':'文件夹名'}</span><input id="deviceFileCreateName" maxlength="255" spellcheck="false" placeholder="${includeContent?'例如 config.json':'例如 logs'}"></label>${includeContent?'<label class="feature-field"><span>UTF-8 文本内容（可留空，最多 1 MiB）</span><textarea id="deviceFileCreateContent" class="device-file-content-editor" spellcheck="false" placeholder="输入文本内容…"></textarea></label>':''}</div>`}
function prepareDeviceFileCreateModal(){const button=$('#configModal .config-dialog-footer .primary');if(button)button.textContent='创建';$('#deviceFileCreateName')?.focus()}
function openCreateDeviceDirectory(){openFeatureModal('device-file-create-directory','新建文件夹',deviceFileCreateFields(false));prepareDeviceFileCreateModal()}
function openCreateDeviceFile(){openFeatureModal('device-file-create-file','新建文本文件',deviceFileCreateFields(true));prepareDeviceFileCreateModal()}
async function submitDeviceFileCreate(kind,overwrite=false){const name=$('#deviceFileCreateName')?.value.trim()||'';if(!name)return toast(`请输入${kind==='directory'?'文件夹':'文件'}名`,true);const content=kind==='file'?$('#deviceFileCreateContent')?.value||'':'';const button=$('#configModal .config-dialog-footer .primary');button.disabled=true;button.textContent='创建中…';try{const endpoint=kind==='directory'?'create-directory':'create-file',body=withAdbSerial({directory:state.deviceFiles.path,name,content,overwrite}),result=await api('/api/device-files/'+endpoint,{method:'POST',body:JSON.stringify(body)});if(result.requires_confirmation){button.disabled=false;button.textContent='创建';if(confirm(`设备中已存在同名文件：\n${result.remote_path}\n\n确认覆盖？`))return submitDeviceFileCreate(kind,true);return}closeFeatureConfig();await loadDeviceFiles(state.deviceFiles.path);toast(`已创建${kind==='directory'?'文件夹':'文件'}：${name}`)}catch(error){toast(error.message,true);button.disabled=false;button.textContent='创建'}}
async function openDeviceFilePreview(index){const item=state.deviceFiles.entries[index];if(!item||item.type!=='file')return;const request=++state.deviceFiles.previewRequest;openFeatureModal('device-file-preview','文件预览','<div class="device-file-preview-loading">正在读取文件预览…</div>',{hideFooter:true});try{const result=await api('/api/device-files/preview',{method:'POST',body:JSON.stringify(withAdbSerial({path:item.path}))});if(request!==state.deviceFiles.previewRequest||state.featureConfigKind!=='device-file-preview')return;const meta=`${escapeHtml(result.name)} · ${formatSize(result.size)}${result.truncated?' · 仅预览前 256 KiB':''}`;$('#configModalBody').innerHTML=`<div class="device-file-preview"><p class="device-file-preview-meta">${meta}</p>${result.previewable?`<pre>${escapeHtml(result.content)}</pre>`:`<div class="device-file-binary"><b>${escapeHtml(result.detected_type||'二进制文件')}</b><span>此文件不是可安全显示的 UTF-8 文本，未加载完整内容。</span></div>`}<div class="device-file-preview-actions"><button class="button subtle" type="button" onclick="closeFeatureConfig()">关闭</button><button class="button primary" type="button" onclick="pullDeviceFile(${index},this)">Pull 文件</button></div></div>`}catch(error){if(request===state.deviceFiles.previewRequest&&state.featureConfigKind==='device-file-preview')$('#configModalBody').innerHTML='<p class="user-guide-error">'+escapeHtml(error.message)+'</p>'}}
function selectedDeviceFileItems(){return $$('.device-file-check:checked').map(input=>state.deviceFiles.entries[Number(input.dataset.index)]).filter(Boolean)}
function updateDeviceFileSelection(){const checks=$$('.device-file-check'),selected=checks.filter(input=>input.checked),all=$('#deviceFileSelectAll');if(all){all.checked=checks.length>0&&selected.length===checks.length;all.indeterminate=selected.length>0&&selected.length<checks.length;all.disabled=!checks.length}const count=$('#deviceFileSelectionCount');if(count)count.textContent=`已选择 ${selected.length} 项`;const pull=$('#deviceFileBatchPullButton'),remove=$('#deviceFileBatchDeleteButton');if(pull)pull.disabled=!selected.length;if(remove)remove.disabled=!selected.length}
function toggleAllDeviceFiles(checked){for(const input of $$('.device-file-check'))input.checked=checked;updateDeviceFileSelection()}
function openDeviceDirectory(index){const item=state.deviceFiles.entries[index];if(item?.type==='directory')loadDeviceFiles(item.path)}
async function loadDeviceFiles(path=deviceFilePath()){
  const button=$('#deviceFileRefreshButton'),status=$('#deviceFileStatus');if(state.deviceFiles.loading)return;state.deviceFiles.loading=true;button.disabled=true;button.textContent='读取中…';status.textContent='正在读取设备目录…';$('#deviceFileList').innerHTML='<div class="device-file-empty">正在读取设备目录…</div>';
  try{const result=await api(deviceFileRequest(path));state.deviceFiles.path=result.path;state.deviceFiles.parent=result.parent;state.deviceFiles.entries=result.entries||[];status.textContent=`${result.path} · ${state.deviceFiles.entries.length} 项${result.limited?`（仅显示前 ${result.limit} 项）`:''}`;renderDeviceFiles()}catch(error){state.deviceFiles.entries=[];$('#deviceFileList').innerHTML='<div class="device-file-empty">'+escapeHtml(error.message)+'</div>';status.textContent='读取失败：'+error.message;updateDeviceFileSelection();toast(error.message,true)}finally{state.deviceFiles.loading=false;button.disabled=false;button.textContent='刷新'}
}
function openDeviceFileParent(){if(state.deviceFiles.parent)loadDeviceFiles(state.deviceFiles.parent)}
async function pullDeviceFile(index,button){
  const item=state.deviceFiles.entries[index];if(!item)return;const directory=item.type==='directory';button.disabled=true;button.textContent='Pull 中…';
  try{const result=await api('/api/device-files/pull',{method:'POST',body:JSON.stringify(withAdbSerial({path:item.path}))});const link=document.createElement('a');link.href=result.url;link.download=result.name;document.body.append(link);link.click();link.remove();toast(`已 Pull ${result.name}（${formatSize(result.size)}）`+(directory?'，文件夹已打包为 zip':''))}catch(error){toast(error.message,true)}finally{button.disabled=false;button.textContent=directory?'Pull (zip)':'Pull'}
}
async function pullSelectedDeviceFiles(){
  const items=selectedDeviceFileItems(),button=$('#deviceFileBatchPullButton');if(!items.length)return;button.disabled=true;button.textContent='批量 Pull 中…';
  try{const result=await api('/api/device-files/pull-batch',{method:'POST',body:JSON.stringify(withAdbSerial({paths:items.map(item=>item.path)}))});const link=document.createElement('a');link.href=result.url;link.download=result.name;document.body.append(link);link.click();link.remove();toast(`已 Pull ${result.count} 项并打包为 ${result.name}（${formatSize(result.size)}）`)}catch(error){toast(error.message,true)}finally{button.textContent='批量 Pull';updateDeviceFileSelection()}
}
async function deleteDeviceFile(index){
  const item=state.deviceFiles.entries[index];if(!item)return;const directory=item.type==='directory';const message=directory?`确认递归删除设备文件夹及其全部内容？\n\n${item.path}\n\n目录下所有文件都会被删除，且不可恢复。`:`确认删除设备文件？\n\n${item.path}\n\n此操作不可恢复。`;if(!confirm(message))return;
  try{const result=await api('/api/device-files/delete',{method:'POST',body:JSON.stringify(withAdbSerial({path:item.path,confirmed:true}))});if(result.requires_confirmation)return;toast((result.type==='directory'?'已删除文件夹 ':'已删除 ')+result.name);await loadDeviceFiles()}catch(error){toast(error.message,true)}
}
async function deleteSelectedDeviceFiles(){
  const items=selectedDeviceFileItems();if(!items.length)return;const directories=items.filter(item=>item.type==='directory').length;
  if(!confirm(`确认删除选中的 ${items.length} 项？${directories?`\n\n其中包含 ${directories} 个文件夹，文件夹及其全部内容都会被递归删除。`:''}\n\n此操作不可恢复。`))return;
  const button=$('#deviceFileBatchDeleteButton');button.disabled=true;button.textContent='删除中…';
  try{const result=await api('/api/device-files/delete-batch',{method:'POST',body:JSON.stringify(withAdbSerial({paths:items.map(item=>item.path),confirmed:true}))});await loadDeviceFiles();if(result.failed_count)toast(`批量删除完成：成功 ${result.deleted_count} 项，失败 ${result.failed_count} 项。${result.failures[0]?.message||''}`,true);else toast(`已删除 ${result.deleted_count} 项`)}catch(error){toast(error.message,true)}finally{button.textContent='批量删除';updateDeviceFileSelection()}
}
async function uploadDeviceFile(files){
  const file=files?.[0],input=$('#deviceFileUpload');if(!file)return;const path=deviceFilePath(),submit=overwrite=>submitDeviceFileUpload(path,file,'',overwrite);
  input.disabled=true;try{let result=await submit(false);if(result.requires_confirmation){if(!confirm(`设备中已存在同名文件：\n${result.remote_path}\n\n确认覆盖？`))return;result=await submit(true)}toast('已上传到 '+result.remote_path);await loadDeviceFiles(path)}catch(error){toast(error.message,true)}finally{input.value='';input.disabled=false}
}
async function submitDeviceFileUpload(directory,file,relativePath='',overwrite=true){
  const form=new FormData();form.append('directory',directory);form.append('serial',selectedAdbSerial());form.append('overwrite',String(overwrite));if(relativePath)form.append('relative_path',relativePath);form.append('file',file,file.name);
  const response=await fetch('/api/device-files/upload',{method:'POST',body:form}),payload=await response.json();if(!response.ok)throw new Error(payload.error||`Request failed (${response.status})`);return payload;
}
async function uploadDeviceFolder(files){
  const items=[...(files||[])],input=$('#deviceFolderUpload'),label=$('#deviceFolderUploadLabel'),labelText=label?.querySelector('span'),status=$('#deviceFileStatus');if(!items.length)return;
  const path=deviceFilePath(),totalSize=items.reduce((sum,file)=>sum+file.size,0),root=items[0].webkitRelativePath.split('/')[0]||'所选文件夹';
  if(!confirm(`确认上传文件夹到当前设备目录？\n\n${path}/${root}\n${items.length} 个文件，共 ${formatSize(totalSize)}\n\n同路径文件将被覆盖；设备端已有的其他文件不会删除。空目录无法由浏览器识别。`)){input.value='';return}
  input.disabled=true;label.classList.add('disabled');const failures=[];let succeeded=0;
  try{
    for(let index=0;index<items.length;index++){
      const file=items[index],relativePath=file.webkitRelativePath||`${root}/${file.name}`;labelText.textContent=`上传中 ${index+1}/${items.length}`;status.textContent=`正在上传 ${relativePath}（${index+1} / ${items.length}）`;
      try{await submitDeviceFileUpload(path,file,relativePath,true);succeeded++}catch(error){failures.push(`${relativePath}：${error.message}`)}
    }
    await loadDeviceFiles(path);
    if(failures.length){toast(`文件夹上传完成：成功 ${succeeded}，失败 ${failures.length}。${failures.slice(0,3).join('；')}`,true)}else toast(`已上传文件夹 ${root}：${succeeded} 个文件`);
  }finally{input.value='';input.disabled=false;label.classList.remove('disabled');labelText.textContent='上传文件夹'}
}
function captureFileUrl(file){return file?.url?file.url+'&v='+encodeURIComponent(file.modified||Date.now()):''}
function selectCaptureCapability(capability){state.captures.capability=capability;$$('.capture-capability-tab').forEach(button=>button.classList.toggle('active',button.dataset.captureCapability===capability));$$('.capture-capability-panel').forEach(panel=>panel.classList.toggle('visible',panel.dataset.capturePanel===capability));if(capability!=='screenshot')stopContinuousCapture();if(capability==='mirror'||capability==='recording')loadScrcpyStatus();if(capability==='recording')updateRecordingMode();if(capability==='compare')loadScreenshotCompareOptions()}
function selectedCaptureDisplay(){return state.captures.displays.find(item=>item.logical_id===$('#captureDisplaySelect')?.value)||null}
function selectedCapturePhysicalDisplay(){const display=selectedCaptureDisplay();if(display&&!display.physical_id)throw new Error(`当前设备未提供 ${display.name} 的物理 Display ID，不能用于截图或录屏`);return display?.physical_id||''}
function selectCaptureDisplay(){const selected=selectedCaptureDisplay(),status=$('#captureDisplayStatus');if(status)status.textContent=selected?`${selected.name} · ${selected.width||'?'} × ${selected.height||'?'} · 逻辑 ID ${selected.logical_id}`:'默认主屏'}
async function loadCaptureDisplays(){const select=$('#captureDisplaySelect'),button=$('#captureDisplayRefresh'),status=$('#captureDisplayStatus');if(!select)return;button.disabled=true;status.textContent='正在读取屏幕…';const previous=select.value;try{const result=await api(apiPathWithSerial('/api/captures/displays'));state.captures.displays=result.items||[];select.innerHTML='<option value="">默认主屏</option>'+state.captures.displays.map(item=>`<option value="${escapeHtml(item.logical_id)}">${escapeHtml(item.name)} · ${item.width||'?'} × ${item.height||'?'} · ID ${escapeHtml(item.logical_id)}</option>`).join('');if(state.captures.displays.some(item=>item.logical_id===previous))select.value=previous;selectCaptureDisplay()}catch(error){state.captures.displays=[];select.innerHTML='<option value="">默认主屏</option>';status.textContent='读取屏幕失败：'+error.message}finally{button.disabled=false}}
async function refreshCaptureTools(){await Promise.all([loadCaptureDisplays(),loadScrcpyStatus()]);if(state.captures.capability==='compare')await loadScreenshotCompareOptions()}
async function loadScrcpyStatus(){const status=$('#scrcpyPathStatus'),badge=$('#scrcpyState'),button=$('#scrcpyLaunchButton'),input=$('#scrcpyPath');if(!status)return;try{const result=await api('/api/captures/scrcpy/status');state.captures.scrcpyAvailable=Boolean(result.available);input.value=result.configured_path||'';badge.textContent=result.available?'可用':'未找到';button.disabled=!result.available;status.textContent=result.available?`当前路径：${result.path}${result.source==='auto'?'（自动检测）':'（自定义）'}`:'未自动找到 scrcpy，请安装后填写可执行文件绝对路径。'}catch(error){state.captures.scrcpyAvailable=false;badge.textContent='检测失败';button.disabled=true;status.textContent=error.message}finally{updateRecordingMode()}}
async function saveScrcpyPath(){const path=$('#scrcpyPath').value.trim();try{const result=await api('/api/captures/scrcpy/path',{method:'POST',body:JSON.stringify({path})});state.config.scrcpy_path=result.configured_path||'';await loadScrcpyStatus();toast('scrcpy 路径已保存')}catch(error){toast(error.message,true)}}
async function clearScrcpyPath(){$('#scrcpyPath').value='';await saveScrcpyPath()}
async function launchScrcpy(){const button=$('#scrcpyLaunchButton'),display=selectedCaptureDisplay();button.disabled=true;button.textContent='启动中…';try{const result=await api('/api/captures/scrcpy/launch',{method:'POST',body:JSON.stringify(withAdbSerial({display_id:display?.logical_id||''}))});toast('scrcpy 已启动：'+result.path)}catch(error){toast(error.message,true)}finally{button.disabled=false;button.textContent='启动投屏'}}
function renderScreenshot(file){state.captures.screenshot=file;const result=$('#screenshotResult');if(!result)return;result.classList.remove('capture-result-empty');$('#screenshotFileName').textContent=file.name;$('#screenshotFileMeta').textContent=formatSize(file.size)+' · '+new Date(file.modified).toLocaleString();$('#screenshotPreviewButton').disabled=false;$('#screenshotCopyButton').disabled=false;$('#screenshotDeleteButton').disabled=false;$('#screenshotCoverButton').disabled=false;const cover=$('#screenshotCoverImage');cover.src=captureFileUrl(file);cover.hidden=false;$('#screenshotCoverFallback').hidden=true;const download=$('#screenshotDownload');download.href=file.url;download.download=file.name;download.classList.remove('disabled-link')}
async function requestScreenshot(){return api('/api/captures/screenshot',{method:'POST',body:JSON.stringify(withAdbSerial({display_id:selectedCapturePhysicalDisplay()}))})}
async function captureScreenshot(){const button=$('#captureScreenshotButton');button.disabled=true;button.textContent='截图中…';try{const result=await requestScreenshot();renderScreenshot(result.file);openCapturePreview(result.file);toast('截图已保存：'+result.file.name)}catch(error){toast(error.message,true)}finally{button.disabled=false;button.textContent='截图'}}
function stopContinuousCapture(){const session=state.captures.continuous;if(!session)return;session.stopped=true;if(session.timeout)clearTimeout(session.timeout);state.captures.continuous=null;const start=$('#continuousCaptureStart'),stop=$('#continuousCaptureStop'),status=$('#continuousCaptureStatus');if(start)start.disabled=false;if(stop)stop.disabled=true;if(status&&session.completed<session.total)status.textContent=`已停止 · 保存 ${session.completed} 张`}
async function startContinuousCapture(){if(state.captures.continuous)return;const interval=Number($('#continuousCaptureInterval').value),total=Number($('#continuousCaptureCount').value),session={interval,total,completed:0,stopped:false,timeout:null};state.captures.continuous=session;$('#continuousCaptureStart').disabled=true;$('#continuousCaptureStop').disabled=false;$('#continuousCaptureStatus').textContent=`0 / ${total}`;const run=async()=>{if(session.stopped||state.captures.continuous!==session)return;try{const result=await requestScreenshot();session.completed+=1;renderScreenshot(result.file);if(session.stopped||state.captures.continuous!==session)return;$('#continuousCaptureStatus').textContent=`${session.completed} / ${total}`;if(session.completed>=total){state.captures.continuous=null;$('#continuousCaptureStart').disabled=false;$('#continuousCaptureStop').disabled=true;$('#continuousCaptureStatus').textContent=`已完成 · 保存 ${total} 张`;toast(`连续截图完成：${total} 张`);return}session.timeout=setTimeout(run,interval*1000)}catch(error){if(session.stopped)return;stopContinuousCapture();$('#continuousCaptureStatus').textContent='失败：'+error.message;toast(error.message,true)}};await run()}
async function copyScreenshot(){const file=state.captures.screenshot;if(!file)return toast('请先截图',true);try{if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined')throw new Error('浏览器不支持复制图片');const response=await fetch(file.url),blob=await response.blob();await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);toast('截图已复制到剪贴板')}catch(error){toast('截图已保存，但复制失败：'+error.message,true)}}
async function revealCapture(kind){const file=kind==='screenshot'?state.captures.screenshot:state.captures.recording;if(!file)return toast('尚无可打开的文件',true);try{const result=await api('/api/captures/reveal',{method:'POST',body:JSON.stringify({id:file.id})});if(result.ok)return toast((kind==='screenshot'?'已打开截图目录：':'已打开录屏目录：')+result.directory);let copied=false;try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(result.directory);copied=true}}catch(error){}toast('系统文件窗口未能打开。目录：'+result.directory+(copied?'（路径已复制）':''),true)}catch(error){toast(error.message,true)}}
async function openRecordingInSystemPlayer(file){if(!file)return toast('尚无可播放的录屏',true);try{await api('/api/captures/record/open',{method:'POST',body:JSON.stringify({id:file.id})});toast('已交给系统播放器打开：'+file.name)}catch(error){toast(error.message,true)}}
function captureKind(file){return file.type==='image/png'?'screenshot':'recording'}
async function openCapturePreview(file){if(!file)return toast('尚无可预览的文件',true);if(captureKind(file)==='recording')return openRecordingInSystemPlayer(file);try{const probe=await fetch(file.url,{headers:{Range:'bytes=0-0'}});if(!probe.ok)throw new Error('捕获文件不存在')}catch(error){resetScreenshotResult();toast(error.message,true);return}openFeatureModal('capture-preview','截图预览','',{hideFooter:true});const root=document.createElement('div');root.className='capture-modal-preview';const media=document.createElement('div');media.className='capture-modal-media';const image=document.createElement('img');image.src=captureFileUrl(file);image.alt=file.name;media.append(image);const meta=document.createElement('div');meta.className='capture-modal-meta';const copy=document.createElement('div'),name=document.createElement('b'),details=document.createElement('small');name.textContent=file.name;details.textContent=new Date(file.modified).toLocaleString()+' · '+formatSize(file.size);copy.append(name,details);const actions=document.createElement('div');actions.className='capture-modal-actions';const copyButton=document.createElement('button');copyButton.type='button';copyButton.className='button subtle';copyButton.textContent='复制截图';copyButton.onclick=()=>copyCaptureLibraryImage(file);const download=document.createElement('a');download.className='button subtle capture-download';download.href=file.url;download.download=file.name;download.textContent='下载';const library=document.createElement('button');library.type='button';library.className='button subtle';library.textContent='返回媒体库';library.onclick=()=>openCaptureLibrary('screenshot');const remove=document.createElement('button');remove.type='button';remove.className='button danger';remove.textContent='删除';remove.onclick=()=>deleteCaptureLibraryFile(file);actions.append(copyButton,download,library,remove);meta.append(copy,actions);root.append(media,meta);$('#configModalBody').replaceChildren(root)}
function showScreenshotCoverFallback(){const cover=$('#screenshotCoverImage');if(cover)cover.hidden=true;const fallback=$('#screenshotCoverFallback');if(fallback)fallback.hidden=false}
function resetScreenshotResult(){state.captures.screenshot=null;const result=$('#screenshotResult');if(!result)return;result.classList.add('capture-result-empty');$('#screenshotFileName').textContent='尚未截图';$('#screenshotFileMeta').textContent='截图完成后自动打开预览弹窗';$('#screenshotPreviewButton').disabled=true;$('#screenshotCopyButton').disabled=true;$('#screenshotDeleteButton').disabled=true;$('#screenshotCoverButton').disabled=true;const cover=$('#screenshotCoverImage');cover.removeAttribute('src');cover.hidden=true;$('#screenshotCoverFallback').hidden=false;const link=$('#screenshotDownload');link.removeAttribute('href');link.classList.add('disabled-link')}
function showRecordingCoverFallback(){const cover=$('#recordingCoverImage');if(cover)cover.hidden=true;const fallback=$('#recordingCoverFallback');if(fallback)fallback.hidden=false}
function resetRecordingResult(){state.captures.recording=null;const result=$('#recordingResult');if(!result)return;result.classList.add('capture-result-empty');$('#recordingFileName').textContent='尚未录屏';$('#recordingFileMeta').textContent='录制完成后可使用系统默认播放器播放';$('#recordingPlayButton').disabled=true;$('#recordingDeleteButton').disabled=true;$('#recordingCoverButton').disabled=true;const cover=$('#recordingCoverImage');cover.removeAttribute('src');cover.hidden=true;$('#recordingCoverFallback').hidden=false;const link=$('#recordingDownload');link.removeAttribute('href');link.classList.add('disabled-link')}
async function refreshLatestCapture(kind){const result=await api(`/api/captures/files?kind=${encodeURIComponent(kind)}&offset=0&limit=1`),file=result.items[0];if(kind==='screenshot'){file?renderScreenshot(file):resetScreenshotResult()}else{file?renderRecording(file):resetRecordingResult()}return file}
async function refreshCaptureOverview(){try{await Promise.all([refreshLatestCapture('screenshot'),refreshLatestCapture('recording')]);await refreshRecordingStatus()}catch(error){toast(error.message,true)}}
async function openCaptureLibrary(kind='all'){state.captures.library={kind,offset:0,items:[],hasMore:false,total:0,selected:new Set()};openFeatureModal('capture-library','媒体库','<div class="capture-library-loading">正在读取媒体文件…</div>',{hideFooter:true});await loadCaptureLibrary(false)}
async function setCaptureLibraryKind(kind){state.captures.library={kind,offset:0,items:[],hasMore:false,total:0,selected:new Set()};await loadCaptureLibrary(false)}
async function loadCaptureLibrary(append=false){const library=state.captures.library;if(!append)library.offset=0;try{const result=await api(`/api/captures/files?kind=${encodeURIComponent(library.kind)}&offset=${library.offset}&limit=50`);library.items=append?[...library.items,...result.items]:result.items;library.offset=library.items.length;library.hasMore=result.has_more;library.total=result.total;renderCaptureLibrary()}catch(error){$('#configModalBody').innerHTML='<div class="capture-library-empty">'+escapeHtml(error.message)+'</div>'}}
function captureLibrarySelection(){const selected=state.captures.library.selected;if(selected instanceof Set)return selected;state.captures.library.selected=new Set();return state.captures.library.selected}
function renderCaptureLibrary(){const library=state.captures.library,selected=captureLibrarySelection(),body=$('#configModalBody');if(!body)return;const loadedIds=new Set(library.items.map(item=>item.id));for(const id of [...selected])if(!loadedIds.has(id))selected.delete(id);const root=document.createElement('div');root.className='capture-library';const toolbar=document.createElement('div');toolbar.className='capture-library-toolbar';toolbar.innerHTML='<div><button class="capture-filter '+(library.kind==='all'?'active':'')+'" onclick="setCaptureLibraryKind(\'all\')">全部</button><button class="capture-filter '+(library.kind==='screenshot'?'active':'')+'" onclick="setCaptureLibraryKind(\'screenshot\')">截图</button><button class="capture-filter '+(library.kind==='recording'?'active':'')+'" onclick="setCaptureLibraryKind(\'recording\')">录屏</button></div><span>共 '+library.total+' 个文件 · 已选 '+selected.size+' 个</span><button class="button subtle" type="button" onclick="toggleAllCaptureLibraryFiles()">'+(library.items.length&&library.items.every(item=>selected.has(item.id))?'取消全选':'全选当前')+'</button><button class="button danger" type="button" onclick="deleteSelectedCaptureFiles()" '+(selected.size?'':'disabled')+'>删除所选</button><button class="button subtle" type="button" onclick="loadCaptureLibrary(false)">刷新</button>';root.append(toolbar);const grid=document.createElement('div');grid.className='capture-library-grid';if(!library.items.length)grid.innerHTML='<div class="capture-library-empty">媒体库为空。</div>';for(const file of library.items)grid.append(captureLibraryItem(file));root.append(grid);if(library.hasMore){const more=document.createElement('button');more.type='button';more.className='button subtle capture-library-more';more.textContent='加载更多';more.onclick=()=>loadCaptureLibrary(true);root.append(more)}body.replaceChildren(root)}
async function loadScreenshotCompareOptions(){const before=$('#compareBefore'),after=$('#compareAfter');if(!before||!after)return;const beforeValue=before.value,afterValue=after.value;try{const result=await api('/api/captures/files?kind=screenshot&offset=0&limit=100');state.captures.compareItems=result.items||[];const options='<option value="">选择截图</option>'+state.captures.compareItems.map(file=>`<option value="${escapeHtml(file.id)}">${escapeHtml(file.name)} · ${new Date(file.modified).toLocaleString()}</option>`).join('');before.innerHTML=options;after.innerHTML=options;if(state.captures.compareItems.some(file=>file.id===beforeValue))before.value=beforeValue;if(state.captures.compareItems.some(file=>file.id===afterValue))after.value=afterValue;if(!before.value&&state.captures.compareItems[1])before.value=state.captures.compareItems[1].id;if(!after.value&&state.captures.compareItems[0])after.value=state.captures.compareItems[0].id;renderScreenshotComparison()}catch(error){toast(error.message,true)}}
function renderScreenshotComparison(){const before=state.captures.compareItems.find(file=>file.id===$('#compareBefore')?.value),after=state.captures.compareItems.find(file=>file.id===$('#compareAfter')?.value),view=$('#screenshotCompareView'),empty=$('#screenshotCompareEmpty');if(!view||!empty)return;if(!before||!after){view.hidden=true;empty.hidden=false;empty.textContent=state.captures.compareItems.length<2?'至少需要两张截图':'请选择两张截图';return}$('#compareBeforeImage').src=captureFileUrl(before);$('#compareAfterImage').src=captureFileUrl(after);empty.hidden=true;view.hidden=false;updateScreenshotComparison($('#compareSlider').value)}
function updateScreenshotComparison(value){const percentage=Math.min(100,Math.max(0,Number(value)||0));const layer=$('#compareAfterLayer'),divider=$('#compareDivider');if(layer)layer.style.clipPath=`inset(0 ${100-percentage}% 0 0)`;if(divider)divider.style.left=percentage+'%'}
function captureLibraryItem(file){const kind=captureKind(file),card=document.createElement('article');card.className='capture-library-item'+(captureLibrarySelection().has(file.id)?' selected':'');card.dataset.id=file.id;const selector=document.createElement('label');selector.className='capture-library-selector';const check=document.createElement('input');check.type='checkbox';check.checked=captureLibrarySelection().has(file.id);check.onchange=()=>toggleCaptureLibraryFile(file.id,check.checked);selector.append(check,document.createTextNode('选择'));const preview=document.createElement('button');preview.type='button';preview.className='capture-library-preview';preview.onclick=()=>openCapturePreview(file);if(kind==='screenshot'){const image=document.createElement('img');image.src=captureFileUrl(file);image.loading='lazy';image.alt=file.name;preview.append(image)}else if(file.cover){const image=document.createElement('img');image.src=captureFileUrl(file.cover);image.loading='lazy';image.alt=file.name+' 封面';preview.append(image);const play=document.createElement('span');play.className='capture-video-icon capture-video-icon-overlay';play.textContent='▶';preview.append(play)}else{preview.innerHTML='<span class="capture-video-icon">▶</span><small>使用系统播放器</small>'}const copy=document.createElement('div');copy.className='capture-library-copy';const title=document.createElement('b');title.textContent=file.name;const meta=document.createElement('small');meta.textContent=new Date(file.modified).toLocaleString()+' · '+formatSize(file.size);copy.append(title,meta);const actions=document.createElement('div');actions.className='capture-library-actions';if(kind==='screenshot'){const copyButton=document.createElement('button');copyButton.type='button';copyButton.className='button subtle';copyButton.textContent='复制';copyButton.onclick=()=>copyCaptureLibraryImage(file);actions.append(copyButton)}else{const open=document.createElement('button');open.type='button';open.className='button subtle';open.textContent='播放';open.onclick=()=>openRecordingInSystemPlayer(file);actions.append(open)}const download=document.createElement('a');download.className='button subtle capture-download';download.href=file.url;download.download=file.name;download.textContent='下载';const remove=document.createElement('button');remove.type='button';remove.className='button danger';remove.textContent='删除';remove.onclick=()=>deleteCaptureLibraryFile(file);actions.append(download,remove);card.append(selector,preview,copy,actions);return card}
function updateCaptureLibrarySelection(){const library=state.captures.library,selected=captureLibrarySelection(),items=library.items||[];$$('.capture-library-item').forEach(card=>{const checked=selected.has(card.dataset.id);card.classList.toggle('selected',checked);const input=card.querySelector('.capture-library-selector input');if(input)input.checked=checked});const toolbar=$('.capture-library-toolbar'),summary=toolbar?.querySelector(':scope > span'),selectAll=toolbar?.querySelector('button[onclick="toggleAllCaptureLibraryFiles()"]'),remove=toolbar?.querySelector('button[onclick="deleteSelectedCaptureFiles()"]');if(summary)summary.textContent=`共 ${library.total} 个文件 · 已选 ${selected.size} 个`;if(selectAll)selectAll.textContent=items.length&&items.every(item=>selected.has(item.id))?'取消全选':'全选当前';if(remove)remove.disabled=!selected.size}
function toggleCaptureLibraryFile(id,checked){const selected=captureLibrarySelection();checked?selected.add(id):selected.delete(id);updateCaptureLibrarySelection()}
function toggleAllCaptureLibraryFiles(){const library=state.captures.library,selected=captureLibrarySelection(),allSelected=library.items.length&&library.items.every(item=>selected.has(item.id));for(const item of library.items)allSelected?selected.delete(item.id):selected.add(item.id);updateCaptureLibrarySelection()}
function captureLibraryPositions(excluded=new Set()){return new Map($$('.capture-library-item').filter(card=>!excluded.has(card.dataset.id)).map(card=>[card.dataset.id,card.getBoundingClientRect()]))}
async function removeCaptureLibraryCards(ids){const removed=new Set(ids),before=captureLibraryPositions(removed),cards=$$('.capture-library-item').filter(card=>removed.has(card.dataset.id));cards.forEach(card=>card.classList.add('removing'));if(cards.length)await new Promise(resolve=>setTimeout(resolve,180));cards.forEach(card=>card.remove());state.captures.library.items=state.captures.library.items.filter(item=>!removed.has(item.id));state.captures.library.total=Math.max(0,state.captures.library.total-removed.size);state.captures.library.offset=state.captures.library.items.length;const grid=$('.capture-library-grid');if(grid&&!state.captures.library.items.length)grid.innerHTML='<div class="capture-library-empty">媒体库为空。</div>';for(const card of $$('.capture-library-item')){const previous=before.get(card.dataset.id);if(!previous)continue;const current=card.getBoundingClientRect(),x=previous.left-current.left,y=previous.top-current.top;if(!x&&!y)continue;card.style.transition='none';card.style.transform=`translate(${x}px,${y}px)`;requestAnimationFrame(()=>requestAnimationFrame(()=>{card.style.transition='transform 220ms ease';card.style.transform=''}))}updateCaptureLibrarySelection()}
async function deleteSelectedCaptureFiles(){const selected=[...captureLibrarySelection()];if(!selected.length)return;if(!confirm(`确认删除选中的 ${selected.length} 个媒体文件？\n\n此操作不可恢复。`))return;try{const result=await api('/api/captures/delete-batch',{method:'POST',body:JSON.stringify({ids:selected})}),deleted=result.results.filter(item=>item.ok).map(item=>item.id);state.captures.library.selected=new Set(result.results.filter(item=>!item.ok).map(item=>item.id));await removeCaptureLibraryCards(deleted);await Promise.all([refreshLatestCapture('screenshot'),refreshLatestCapture('recording')]);if(state.captures.capability==='compare')await loadScreenshotCompareOptions();toast(result.failed?`已删除 ${result.deleted} 个，失败 ${result.failed} 个`:`已删除 ${result.deleted} 个媒体文件`,Boolean(result.failed))}catch(error){toast(error.message,true)}}
async function copyCaptureLibraryImage(file){try{if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined')throw new Error('浏览器不支持复制图片');const response=await fetch(file.url),blob=await response.blob();await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);toast('截图已复制到剪贴板')}catch(error){toast('复制失败：'+error.message,true)}}
async function deleteCaptureFile(file,refreshLibrary=false){if(!file||!confirm('确认删除媒体文件？\n\n'+file.name+'\n\n此操作不可恢复。'))return;try{const result=await api('/api/captures/delete',{method:'POST',body:JSON.stringify({id:file.id})});await refreshLatestCapture(captureKind(file));if(state.featureConfigKind==='capture-preview')closeFeatureConfig();else if(refreshLibrary)await loadCaptureLibrary(false);toast(result.warning||('已删除 '+file.name),Boolean(result.warning))}catch(error){toast(error.message,true)}}
async function deleteCaptureLibraryFile(file){if(!file||!confirm('确认删除媒体文件？\n\n'+file.name+'\n\n此操作不可恢复。'))return;try{const result=await api('/api/captures/delete',{method:'POST',body:JSON.stringify({id:file.id})});captureLibrarySelection().delete(file.id);await removeCaptureLibraryCards([file.id]);await refreshLatestCapture(captureKind(file));if(state.captures.capability==='compare')await loadScreenshotCompareOptions();toast(result.warning||('已删除 '+file.name),Boolean(result.warning))}catch(error){toast(error.message,true)}}
function deleteRecentCapture(kind){return deleteCaptureFile(kind==='screenshot'?state.captures.screenshot:state.captures.recording)}
function captureDuration(value){const seconds=Math.max(0,Math.floor(Number(value)||0));return String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0')}
function stopCaptureTimer(){if(state.captures.timer){clearInterval(state.captures.timer);state.captures.timer=null}state.captures.polling=false}
function startCaptureTimer(startedAt){stopCaptureTimer();let ticks=0;const update=async()=>{$('#recordTimer').textContent=captureDuration(Date.now()/1000-startedAt);ticks+=1;if(ticks%3===0&&!state.captures.polling){state.captures.polling=true;try{applyRecordingStatus(await api('/api/captures/record/status'))}catch(error){toast(error.message,true)}finally{state.captures.polling=false}}};update();state.captures.timer=setInterval(update,1000)}
function selectedRecordingMode(){return $('#recordingMode')?.value||'android'}
function updateRecordingMode(){const mode=selectedRecordingMode(),scrcpy=mode!=='android',hint=$('#recordingModeHint'),bugreport=$('#recordBugreport'),bugreportLabel=$('#recordBugreportLabel'),start=$('#recordStartButton');const descriptions={android:'Android 原生 screenrecord，仅录制画面，不包含音频。',scrcpy_mic_camcorder:'scrcpy 摄像收音：使用设备麦克风采集环境声，效果接近手机拍视频；需要 Android 11 或更高版本。',scrcpy_voice_performance:'scrcpy 混合收音：尝试同时采集设备麦克风和设备播放声音；需要 Android 11 或更高版本，实际效果取决于设备音频实现。'};if(hint)hint.textContent=(descriptions[mode]||descriptions.android)+(scrcpy&&!state.captures.scrcpyAvailable?' 当前未找到 scrcpy，请先在“scrcpy 投屏”中安装或配置路径。':'');if(bugreport){bugreport.disabled=scrcpy;if(scrcpy)bugreport.checked=false}if(bugreportLabel)bugreportLabel.classList.toggle('disabled',scrcpy);if(start)start.disabled=state.captures.recordingState==='recording'||(scrcpy&&!state.captures.scrcpyAvailable)}
function renderRecording(file,duration=null){state.captures.recording=file;const result=$('#recordingResult');if(!result)return;result.classList.remove('capture-result-empty');$('#recordingFileName').textContent=file.name;const details=[formatSize(file.size)];if(duration!==null&&duration!==undefined)details.push(captureDuration(duration));details.push(new Date(file.modified).toLocaleString());$('#recordingFileMeta').textContent=details.join(' · ');$('#recordingPlayButton').disabled=false;$('#recordingDeleteButton').disabled=false;$('#recordingCoverButton').disabled=false;const cover=$('#recordingCoverImage');cover.hidden=!file.cover;cover.src=file.cover?captureFileUrl(file.cover):'';$('#recordingCoverFallback').hidden=Boolean(file.cover);const download=$('#recordingDownload');download.href=file.url;download.download=file.name;download.classList.remove('disabled-link')}
function applyRecordingStatus(status){const recording=status.state==='recording',start=$('#recordStartButton'),stop=$('#recordStopButton'),label=$('#recordState'),mode=$('#recordingMode');if(!start||!stop)return;state.captures.recordingState=status.state||'idle';if(status.recording_mode&&mode)mode.value=status.recording_mode;if(mode)mode.disabled=recording;stop.disabled=!recording;updateRecordingMode();label.textContent={idle:'未录制',recording:'录制中',completed:'录制完成',failed:'录制失败'}[status.state]||status.state;if(recording)startCaptureTimer(status.started_at);else stopCaptureTimer();if(status.file){renderRecording(status.file,status.duration);if(state.captures.lastAutoPreview!==status.file.id&&state.page==='device-tools'){state.captures.lastAutoPreview=status.file.id;openCapturePreview(status.file)}}if(status.error)toast(status.error,true)}
async function refreshRecordingStatus(){try{applyRecordingStatus(await api('/api/captures/record/status'))}catch(error){toast(error.message,true)}}
async function startScreenRecording(){const button=$('#recordStartButton'),mode=selectedRecordingMode(),display=selectedCaptureDisplay(),scrcpy=mode!=='android';if(scrcpy&&!state.captures.scrcpyAvailable)return toast('当前未找到 scrcpy，请先安装或配置 scrcpy 可执行文件',true);let physicalDisplayId='';try{physicalDisplayId=mode==='android'?selectedCapturePhysicalDisplay():(display?.physical_id||'')}catch(error){return toast(error.message,true)}const body=withAdbSerial({recording_mode:mode,filename:$('#recordFileName').value.trim(),size:$('#recordSize').value,bit_rate:Number($('#recordBitRate').value),time_limit:Number($('#recordTimeLimit').value),physical_display_id:physicalDisplayId,logical_display_id:display?.logical_id||'',bugreport:mode==='android'&&$('#recordBugreport').checked});button.disabled=true;button.textContent='启动中…';try{const status=await api('/api/captures/record/start',{method:'POST',body:JSON.stringify(body)});applyRecordingStatus(status);$('#recordFileName').value='';toast('屏幕录制已开始')}catch(error){toast(error.message,true)}finally{button.textContent='开始录制';updateRecordingMode()}}
async function stopScreenRecording(){const button=$('#recordStopButton');button.disabled=true;button.textContent='处理中…';try{const status=await api('/api/captures/record/stop',{method:'POST',body:'{}'});state.captures.lastAutoPreview=status.file?.id;applyRecordingStatus(status);openCapturePreview(status.file);toast('录屏已保存：'+status.file.name)}catch(error){toast(error.message,true);await refreshRecordingStatus()}finally{button.textContent='停止录制'}}
function deviceLogSourceRow(name='',source={}){const rule=source.time_rule||{},type=rule.type||'none';return `<section class="device-log-source-row"><div class="device-log-source-fields"><label><span>来源名称</span><input class="device-log-source-name" value="${escapeHtml(name)}" placeholder="例如：E68 Android 日志"></label><label><span>设备日志目录</span><input class="device-log-source-directory" value="${escapeHtml(source.device_directory||'')}" placeholder="/log/ivi"></label><label><span>文件匹配</span><input class="device-log-source-pattern" value="${escapeHtml(source.file_pattern||'*.gz')}" placeholder="*.gz"></label><label><span>归档类型</span><select class="device-log-source-archive"><option value="none"${source.archive_type==='none'?' selected':''}>不解压</option><option value="gzip"${source.archive_type!=='none'?' selected':''}>gzip</option></select></label><label><span>时间识别</span><select class="device-log-time-type" onchange="toggleDeviceLogTimeFields(this)"><option value="none"${type==='none'?' selected':''}>不识别时间</option><option value="mtime"${type==='mtime'?' selected':''}>设备文件修改时间</option><option value="filename_single"${type==='filename_single'?' selected':''}>文件名单时间</option><option value="filename_range"${type==='filename_range'?' selected':''}>文件名起止时间</option><option value="local_and_utc"${type==='local_and_utc'?' selected':''}>本地时间 + UTC</option></select></label><label class="device-log-time-field"><span>时间正则</span><input class="device-log-time-pattern" value="${escapeHtml(rule.pattern||'')}" placeholder="命名组：time，或 start/end，或 local/utc"></label><label class="device-log-time-field"><span>时区</span><input class="device-log-timezone" value="${escapeHtml(rule.timezone||'Asia/Shanghai')}"></label><label class="device-log-time-field"><span>时间含义</span><select class="device-log-time-meaning"><option value="instant"${rule.meaning==='instant'?' selected':''}>时间点</option><option value="archive_start"${rule.meaning==='archive_start'?' selected':''}>归档开始</option><option value="archive_end"${rule.meaning==='archive_end'?' selected':''}>归档结束</option><option value="time_range"${rule.meaning==='time_range'?' selected':''}>明确起止区间</option></select></label></div><button class="button danger subtle-delete" type="button" onclick="this.closest('.device-log-source-row').remove()">移除</button></section>`}
function toggleDeviceLogTimeFields(select){const row=select.closest('.device-log-source-row'),hidden=['none','mtime'].includes(select.value);row.querySelectorAll('.device-log-time-field').forEach(field=>field.hidden=hidden)}
function deviceLogSourceEditor(){const rows=Object.entries(state.config?.device_log_sources||{}).map(([name,source])=>deviceLogSourceRow(name,source)).join('')||deviceLogSourceRow();return `<div class="device-log-source-editor"><p class="page-description">基础扫描只需要来源名称、设备目录和文件匹配。时间识别完全可选；命名无法统一的平台可选择“不识别时间”并手动勾选文件。</p><div id="deviceLogSourceRows">${rows}</div><button class="button subtle" type="button" onclick="addDeviceLogSourceRow()">添加日志源</button></div>`}
function clarifyDeviceLogArchiveFields(){for(const select of $$('.device-log-source-archive')){const label=select.closest('label');if(label)label.title='归档类型只决定是否允许 Pull 后自动解压，不影响扫描和文件匹配';const plain=select.querySelector('option[value="none"]'),gzip=select.querySelector('option[value="gzip"]');if(plain)plain.textContent='普通文件（不解压）';if(gzip)gzip.textContent='gzip（可自动解压）'}}
function enableDeviceLogAutoTime(select,rule={}){const row=select.closest('.device-log-source-row'),legacy=['filename_single','filename_range','local_and_utc'].includes(rule.type);row.querySelector('.device-log-source-name').placeholder='例如：ANR 日志';row.querySelector('.device-log-source-directory').placeholder='/data/anr';select.replaceChildren(new Option('自动识别文件名（推荐）','filename_auto'),new Option('设备文件修改时间','mtime'),new Option('不识别时间','none'));select.value=legacy?'filename_auto':rule.type||'filename_auto';row.querySelector('.device-log-time-pattern')?.closest('label')?.remove();if(select.value==='filename_auto'&&(!rule.meaning||legacy))row.querySelector('.device-log-time-meaning').value='archive_end';toggleDeviceLogTimeFields(select)}
function openDeviceLogSourceConfig(){openFeatureModal('device-log-sources','管理设备日志源',deviceLogSourceEditor());const rules=Object.values(state.config?.device_log_sources||{}).map(source=>source.time_rule||{});$$('.device-log-time-type').forEach((select,index)=>enableDeviceLogAutoTime(select,rules[index]||{}));const note=$('.device-log-source-editor>.page-description');if(note)note.textContent='推荐使用“自动识别文件名”，无需填写正则；识别不到时文件仍会列出并可手动勾选。只有特殊厂商命名才需要高级规则。';clarifyDeviceLogArchiveFields()}
function addDeviceLogSourceRow(){$('#deviceLogSourceRows').insertAdjacentHTML('beforeend',deviceLogSourceRow());enableDeviceLogAutoTime($('#deviceLogSourceRows .device-log-source-row:last-child .device-log-time-type'))}
function readDeviceLogSources(){const result={};for(const row of $$('#deviceLogSourceRows .device-log-source-row')){const name=row.querySelector('.device-log-source-name').value.trim(),directory=row.querySelector('.device-log-source-directory').value.trim(),pattern=row.querySelector('.device-log-source-pattern').value.trim(),type=row.querySelector('.device-log-time-type').value;if(!name&&!directory)continue;if(!name||!directory)throw new Error('日志源名称和设备目录必须同时填写');if(result[name])throw new Error('日志源名称重复：'+name);const timeRule={type};if(type==='filename_auto'){timeRule.timezone=row.querySelector('.device-log-timezone').value.trim()||'Asia/Shanghai';timeRule.meaning=row.querySelector('.device-log-time-meaning').value;timeRule.minimum_year=2020}result[name]={device_directory:directory,file_pattern:pattern||'*',archive_type:row.querySelector('.device-log-source-archive').value,time_rule:timeRule}}return result}
async function saveDeviceLogSources(){try{state.config.device_log_sources=readDeviceLogSources();await api('/api/config',{method:'POST',body:JSON.stringify(state.config)});state.config=await api('/api/config');closeFeatureConfig();await refreshDeviceLogSources();resetDeviceLogResults();toast('设备日志源已保存')}catch(error){toast(error.message,true)}}

function ensureHiddenLogSchemeControls(){
  if($('#logPreset'))return;
  const controls=document.createElement('div');controls.id='liveLogSchemeControls';controls.hidden=true;controls.innerHTML='<select id="logPreset" onchange="selectLogPreset()"><option value="" disabled selected>选择已保存方案…</option></select><button class="button subtle" type="button" onclick="newLogPreset()">新建方案</button>';document.body.append(controls);
}
ensurePresetDeleteButtons=function(){
  const select=$('#logPreset');if(select&&!$('#deleteLogPresetButton')){const button=document.createElement('button');button.id='deleteLogPresetButton';button.className='button danger subtle-delete';button.type='button';button.textContent='删除方案';button.onclick=deleteLogPreset;select.after(button);}
  const broadcastControls=$('#broadcastPreset')?.parentElement;if(broadcastControls&&!$('#deleteBroadcastPresetButton')){const button=document.createElement('button');button.id='deleteBroadcastPresetButton';button.className='button danger subtle-delete';button.textContent='删除预设';button.onclick=deleteBroadcastPreset;broadcastControls.insertBefore(button,broadcastControls.querySelector('.button.primary'));}
};
function updateLogSchemeButton(){const button=$('#logSchemeButton'),name=$('#logPreset')?.value||'';if(button)button.textContent='过滤方案：'+(name||'选择方案');}
const logOutputHeightKeys={logOutput:'glacien.log.outputHeight',offlineLogOutput:'glacien.offlineLog.outputHeight'};
function logOutputHeightVariable(output){return output.id==='logOutput'?'--log-output-user-height':'--offline-log-output-user-height';}
function logOutputShell(output){return output.parentElement?.classList.contains('log-output-shell')?output.parentElement:null;}
function clampLogOutputHeight(output,value){const top=logOutputShell(output)?.getBoundingClientRect().top??output.getBoundingClientRect().top,max=Math.max(280,window.innerHeight-top-48);return Math.max(260,Math.min(max,Math.round(value)));}
function applyStoredLogOutputHeight(output){const stored=Number(localStorage.getItem(logOutputHeightKeys[output.id])||0),shell=logOutputShell(output);if(!stored||!shell)return;const height=clampLogOutputHeight(output,stored);shell.style.setProperty(logOutputHeightVariable(output),height+'px');shell.dataset.customHeight='true';}
function ensureResizableLogOutputs(){
  for(const output of [$('#logOutput'),$('#offlineLogOutput')]){
    if(!output||output.dataset.resizable)return;output.dataset.resizable='true';applyStoredLogOutputHeight(output);
    const shell=document.createElement('div');shell.className='log-output-shell';output.before(shell);shell.append(output);
    const handle=document.createElement('div');handle.className='log-output-resize';handle.title='拖动调整日志展示高度';handle.setAttribute('aria-label','拖动调整日志展示高度');handle.setAttribute('role','separator');handle.tabIndex=0;shell.append(handle);applyStoredLogOutputHeight(output);
    handle.addEventListener('pointerdown',event=>{event.preventDefault();const startY=event.clientY,startHeight=shell.getBoundingClientRect().height;const move=moveEvent=>{const height=clampLogOutputHeight(output,startHeight+moveEvent.clientY-startY);shell.style.setProperty(logOutputHeightVariable(output),height+'px');shell.dataset.customHeight='true';localStorage.setItem(logOutputHeightKeys[output.id],String(height));};const end=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',end);document.removeEventListener('pointercancel',end);};document.addEventListener('pointermove',move);document.addEventListener('pointerup',end);document.addEventListener('pointercancel',end);});
  }
}
ensureResizableLogOutputs();
window.addEventListener('resize',()=>{for(const output of [$('#logOutput'),$('#offlineLogOutput')]){if(output&&localStorage.getItem(logOutputHeightKeys[output.id]))applyStoredLogOutputHeight(output);}});
function restoreModalScheme(panel,home){if(panel&&home)home.append(panel);}
function openLiveLogSchemeModal(){
  const panel=$('#logRulePanel'),home=$('#liveLogSchemeHome'),controls=$('#liveLogSchemeControls'),remove=$('#deleteLogPresetButton');if(!panel||!home||!controls)return;
  openFeatureModal('live-log-scheme','实时日志过滤方案','',{hideFooter:true});controls.hidden=false;$('#configModalBody').append(controls,panel);if(remove)panel.querySelector('#realtimeSchemeBar')?.append(remove);
  const footer=$('#configModal .config-dialog-footer');footer.hidden=false;footer.innerHTML='<button class="button subtle" id="liveLogSchemeClose">关闭</button>';$('#liveLogSchemeClose').onclick=closeFeatureConfig;
}
function updateOfflineSchemeButton(){const button=$('#offlineSchemeButton'),name=state.offlinePreset.loadedName||'';if(button)button.textContent='分析方案：'+(name||'选择方案');}
function openOfflineSchemeModal(){
  const panel=$('#offlineRulePanel'),home=$('.offline-filter-panel');if(!panel||!home)return;
  openFeatureModal('offline-log-scheme','离线日志分析方案','',{hideFooter:true});$('#configModalBody').append(panel);
  const footer=$('#configModal .config-dialog-footer');footer.hidden=false;footer.innerHTML='<button class="button subtle" id="offlineSchemeClose">关闭</button>';$('#offlineSchemeClose').onclick=closeFeatureConfig;
}
function ensureOfflineSchemeButton(){
  if($('#offlineSchemeButton'))return;const actions=$('#offline-logs .section-heading .header-actions');if(!actions)return;const button=document.createElement('button');button.id='offlineSchemeButton';button.className='button subtle scheme-launch';button.type='button';button.onclick=openOfflineSchemeModal;actions.prepend(button);updateOfflineSchemeButton();
}
const closeFeatureConfigBase=closeFeatureConfig;
closeFeatureConfig=function(){
  if(state.featureConfigKind==='device-file-preview')state.deviceFiles.previewRequest++;
  if(state.featureConfigKind==='live-log-scheme'){const panel=$('#logRulePanel'),home=$('#liveLogSchemeHome'),controls=$('#liveLogSchemeControls'),remove=$('#deleteLogPresetButton');if(!confirmDiscardLogRuleChanges('关闭方案编辑'))return;restoreModalScheme(panel,home);if(controls){if(remove)controls.append(remove);controls.hidden=true;document.body.append(controls);}updateLogSchemeButton();}
  if(state.featureConfigKind==='offline-log-scheme'){const panel=$('#offlineRulePanel'),home=$('.offline-filter-panel');if(!confirmDiscardOfflinePresetChanges('关闭方案编辑'))return;restoreModalScheme(panel,home);}
  closeFeatureConfigBase();
};
const loadLogFiltersBase=loadLogFilters;
loadLogFilters=async function(){await loadLogFiltersBase();updateLogSchemeButton();};
const selectLogPresetBase=selectLogPreset;
selectLogPreset=function(){selectLogPresetBase();updateLogSchemeButton();};
const saveLogPresetBase=saveLogPreset;
saveLogPreset=async function(){await saveLogPresetBase();updateLogSchemeButton();};
const restoreOfflinePresetBase=restoreOfflinePreset;
restoreOfflinePreset=function(name){restoreOfflinePresetBase(name);updateOfflineSchemeButton();};
const resetOfflinePresetEditorBase=resetOfflinePresetEditor;
resetOfflinePresetEditor=function(){resetOfflinePresetEditorBase();updateOfflineSchemeButton();};
const saveOfflineFilterPresetBase=saveOfflineFilterPreset;
saveOfflineFilterPreset=async function(){await saveOfflineFilterPresetBase();updateOfflineSchemeButton();};
const deleteOfflineFilterPresetBase=deleteOfflineFilterPreset;
deleteOfflineFilterPreset=async function(){await deleteOfflineFilterPresetBase();updateOfflineSchemeButton();};
reorganizeFeaturePages();
restoreNavGroups();
document.querySelectorAll('.nav-item[data-page]').forEach(x=>x.addEventListener('click',()=>navigate(x.dataset.page)));
window.addEventListener('beforeunload',event=>{if(logRuleDirty()||offlinePresetDirty()||adbCommandDirty()){event.preventDefault();event.returnValue='';}});
$('#keystoreSelect')?.addEventListener('change', updateSignSelection);
['broadcastName','broadcastAction','broadcastPackage'].forEach(id=>$('#'+id)?.addEventListener('input',updateBroadcastPreview));
(async()=>{try{await loadThemeCatalog();state.config=await api('/api/config');renderAppVersion();renderReleaseTimeline();ensureHiddenLogSchemeControls();renderUserDataPath();ensureFeatureConfigButtons();ensureLogFilterDualEditor();ensureLogRuleToggle();ensureLogExportButtons();ensureAutoScrollToggle();ensurePresetDeleteButtons();enhanceRealtimeSchemeLayout();relocateRealtimeActionButtons();setupOfflineControls();enhanceOfflineFilterBuilder();relocateOfflineBrowserControls();ensureOfflineHighlightCaseToggle();ensureOfflineCancelButton();ensureOfflineSchemeButton();ensureResizableLogOutputs();refreshAdbCommandPresets();resetAdbCommandEditor();applyLogViewSettings();applyOfflineLogViewSettings();await Promise.all([loadLogFilters(),refreshOfflineRgCapability()]);await refreshAll();state.deviceState=$('#devicePill').classList.contains('online')?'online':'offline';setInterval(monitorDevice,5000);}catch(e){toast(e.message,true)}})();

// 在原始 JSON 文本上分词，再分别进行 HTML 转义；不能先整体转义，否则双引号字符串无法被可靠识别。
function jsonHighlight(text){
  const token=/"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|[{}\[\],:]/gi;
  let result='',position=0,match;
  while((match=token.exec(text))!==null){
    result+=escapeHtml(text.slice(position,match.index));
    const value=match[0],after=text.slice(token.lastIndex),kind=value[0]==='"'?(after.match(/^\s*:/)?'json-key':'json-string'):/^(true|false|null)$/i.test(value)?'json-boolean':/^-?\d/.test(value)?'json-number':'json-punctuation';
    result+=`<span class="${kind}">${escapeHtml(value)}</span>`;
    position=token.lastIndex;
  }
  return result+escapeHtml(text.slice(position));
}

// 设置页仅管理方案。删除只能针对非当前、非默认的候选方案。

// 功能配置均使用字段化表单；基础 Profile 只管理目标名称，
// APK 来源、Keystore 和进程关键词各自归到对应功能页面。
function configInput(label,id,value='',hint=''){return `<label class="feature-field"><span>${label}</span><input id="${id}" value="${escapeHtml(value)}" placeholder="${escapeHtml(hint)}"></label>`}
function configJson(label,id,value,compact=false){return `<label class="feature-field feature-json ${compact?'compact-json':''}"><span>${label}</span><textarea id="${id}" spellcheck="false" oninput="autoResizeConfigJson(this)">${escapeHtml(JSON.stringify(value,null,2))}</textarea></label>`}
function autoResizeConfigJson(textarea){if(!textarea?.closest('.compact-json'))return;textarea.style.height='auto';textarea.style.height=`${Math.min(Math.max(textarea.scrollHeight,58),170)}px`;}
function launchExamples(){return '<div class="launch-examples"><b>拉起命令示例</b><p>按 Activity 拉起：<code>am start -n com.example.app/.MainActivity</code></p><p>按 Intent Action 拉起：<code>am start -a com.example.app.ACTION_OPEN</code></p><p>页面会自动在前面添加 <code>adb shell</code>，不要重复填写。</p></div>'}
function openFeatureModal(kind, title, content, options={}){
  const modal = $('#configModal');
  state.featureConfigKind = kind;
  modal.dataset.kind = kind;
  $('#configModalTitle').textContent = title;
  $('#configModalBody').innerHTML = content;
  $('#configModal .config-dialog-footer').hidden = Boolean(options.hideFooter);
  modal.hidden = false;
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
  return modal;
}
function closeFeatureConfig(){
  $('#configModal').hidden=true;
  delete $('#configModal').dataset.kind;
  const footer=$('#configModal .config-dialog-footer');footer.hidden=false;footer.innerHTML='<button class="button subtle" onclick="closeFeatureConfig()">取消</button><button class="button primary" onclick="saveFeatureConfig()">保存</button>';
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
  state.featureConfigKind=null;
}
// 只有按下和松开都位于遮罩空白处才关闭；从输入框内拖动到遮罩上选择文字时不能误关闭。
let modalBackdropPointerId = null;
document.addEventListener('pointerdown', function(event){
  if(!event.isPrimary)return;
  const modal=$('#configModal');
  modalBackdropPointerId=modal&&!modal.hidden&&event.button===0&&event.target===modal?event.pointerId:null;
});
document.addEventListener('pointerup', function(event){
  if(!event.isPrimary)return;
  const modal=$('#configModal'),startedOnBackdrop=modalBackdropPointerId===event.pointerId;
  modalBackdropPointerId=null;
  if(startedOnBackdrop&&modal&&!modal.hidden&&event.target===modal)closeFeatureConfig();
});
document.addEventListener('pointercancel',function(event){if(modalBackdropPointerId===event.pointerId)modalBackdropPointerId=null;});
// 弹窗正文是唯一滚动容器：背景已由 modal-open 锁定，
// 只依赖 CSS 的 overscroll-behavior 阻断滚动链，不能在 JS 中拦截 wheel，
// 否则子元素不可滚动时会误阻止实际正文滚动。
function readFeatureJson(id,label){try{return JSON.parse($('#'+id).value)}catch(e){throw new Error(`${label} 不是有效 JSON：${e.message}`)}}
function ensureFeatureConfigButtons(){/* 资源与进程页已在 HTML 中定义右侧配置/刷新按钮。 */}
function apkSourceRow(name='',path=''){return '<div class="apk-source-config-row"><label><span>来源名称</span><input class="apk-source-name" value="'+escapeHtml(name)+'" placeholder="例如：vehicle_control_debug"></label><label><span>APK 输出目录</span><input class="apk-source-path" value="'+escapeHtml(path)+'" placeholder="绝对目录路径"></label><button class="button danger subtle-delete" type="button" onclick="this.closest(\'.apk-source-config-row\').remove()">移除</button></div>';}
function apkSourceEditor(){const rows=Object.entries(state.config?.apk_sources||{}).map(entry=>apkSourceRow(entry[0],entry[1])).join('')||apkSourceRow();return '<div class="apk-source-config"><p class="page-description">配置一个或多个构建输出目录。快速导入只扫描这些目录中的 APK，来源文件不会被移动或删除。</p><div id="apkSourceRows">'+rows+'</div><button class="button subtle" type="button" onclick="document.querySelector(\'#apkSourceRows\').insertAdjacentHTML(\'beforeend\',apkSourceRow())">添加来源</button></div>';}
function openApkSourceConfig(){openFeatureModal('apk-sources','配置 APK 来源',apkSourceEditor());}
function readApkSources(){const result={};for(const row of $$('#apkSourceRows .apk-source-config-row')){const name=row.querySelector('.apk-source-name').value.trim(),path=row.querySelector('.apk-source-path').value.trim();if(!name&&!path)continue;if(!name||!path)throw new Error('APK 来源名称和目录必须同时填写');if(result[name])throw new Error('APK 来源名称重复：'+name);result[name]=path;}return result;}
function apkSourcePickerContent(sources){
  const root=document.createElement('div');root.className='apk-source-picker';
  const hint=document.createElement('p');hint.className='page-description';hint.textContent='默认勾选每个来源最新修改的 APK；可手动多选后复制到用户数据目录的 adb-tools/apk-center/files/。';root.append(hint);
  for(const source of sources){const group=document.createElement('section');group.className='apk-source-group';const heading=document.createElement('div');heading.className='apk-source-heading';const title=document.createElement('div'),name=document.createElement('b'),path=document.createElement('small'),count=document.createElement('span');name.textContent=source.name;path.textContent=source.path;count.textContent=source.available?source.apks.length+' 个 APK':'目录不可用';title.append(name,path);heading.append(title,count);group.append(heading);for(const item of source.apks||[]){const label=document.createElement('label');label.className='apk-source-item';const input=document.createElement('input');input.type='checkbox';input.className='check apk-source-check';input.dataset.source=source.name;input.dataset.path=item.relative_path;input.checked=Boolean(item.latest);const content=document.createElement('span'),file=document.createElement('b'),meta=document.createElement('small');file.textContent=item.name;meta.textContent=item.relative_path+' · '+formatSize(item.size)+' · '+new Date(item.modified).toLocaleString()+(item.latest?' · 最新':'');content.append(file,meta);label.append(input,content);group.append(label);}if(!source.available||!source.apks.length){const empty=document.createElement('p');empty.className='apk-source-empty';empty.textContent=source.available?'没有可导入的 APK。':'目录不可用。';group.append(empty);}root.append(group);}
  if(!sources.length){const empty=document.createElement('p');empty.className='apk-source-empty';empty.textContent='尚未配置 APK 来源。';root.append(empty);}
  const overwrite=document.createElement('label');overwrite.className='overwrite-option';overwrite.innerHTML='<input id="apkSourceOverwrite" type="checkbox"> 允许覆盖当前目标中的同名 APK';const submit=document.createElement('button');submit.className='button primary';submit.id='collectApksButton';submit.type='button';submit.textContent='导入所选 APK';submit.onclick=collectSelectedApks;root.append(overwrite,submit);return root;
}
async function openApkSourcePicker(){openFeatureModal('apk-source-picker','从构建目录导入','<div class="apk-source-empty">正在扫描已配置来源…</div>',{hideFooter:true});try{const sources=await api('/api/apk-sources');$('#configModalBody').replaceChildren(apkSourcePickerContent(sources));}catch(error){$('#configModalBody').textContent=error.message;}}
async function collectSelectedApks(){const files=$$('.apk-source-check:checked').map(input=>({source:input.dataset.source,relative_path:input.dataset.path}));if(!files.length)return toast('请至少选择一个 APK',true);const button=$('#collectApksButton'),overwrite=Boolean($('#apkSourceOverwrite')?.checked);button.disabled=true;button.textContent='导入中…';try{const result=await api('/api/apks/collect',{method:'POST',body:JSON.stringify({files,overwrite})});if(result.requires_confirmation){button.disabled=false;button.textContent='导入所选 APK';if(confirm('adb-tools/apk-center/files/ 已存在同名 APK：\n'+result.conflicts.join('\n')+'\n\n确认覆盖？')){$('#apkSourceOverwrite').checked=true;return collectSelectedApks();}return;}closeFeatureConfig();await loadApks();toast('已导入 '+result.results.length+' 个 APK');}catch(error){toast(error.message,true);button.disabled=false;button.textContent='导入所选 APK';}}
function deleteLogPreset(){const name=$('#logPreset').value;if(!name)return toast('请选择要删除的过滤方案',true);if(!confirm(`确认删除过滤方案“${name}”？`))return;delete state.config.log_filters[name];api('/api/config',{method:'POST',body:JSON.stringify(state.config)}).then(async()=>{state.config=await api('/api/config');await loadLogFilters();newLogPreset();toast('过滤方案已删除')}).catch(e=>toast(e.message,true));}
function deleteBroadcastPreset(){const name=$('#broadcastPreset').value;if(!name)return toast('请选择要删除的广播预设',true);if(!confirm(`确认删除广播预设“${name}”？`))return;delete state.config.broadcasts[name];api('/api/config',{method:'POST',body:JSON.stringify(state.config)}).then(async()=>{state.config=await api('/api/config');await loadBroadcasts();$('#broadcastPreset').value='';loadBroadcastPreset();toast('广播预设已删除')}).catch(e=>toast(e.message,true));}

// 进程页只维护关键词；每个包的拉起入口通过行内“配置拉起”单独管理。
function openFeatureConfig(kind){const titles={overview:'工作站与 ADB 配置',app:'工作站配置',adb:'ADB 环境',processes:'进程管理配置'};let html='';if(kind==='overview')html=configInput('本地服务端口','featurePort',state.config.port||8765)+configInput('Android SDK / platform-tools / adb 路径（可空）','featureSdk',state.config.sdk_root||'');if(kind==='app')html=configInput('本地服务端口','featurePort',state.config.port||8765);if(kind==='adb')html=configInput('Android SDK / platform-tools / adb 路径（可空）','featureSdk',state.config.sdk_root||'');if(kind==='processes')html=configInput('全局包名关键词（逗号分隔）','featureKeywords',(state.config.process_package_keywords||[]).join(', '));openFeatureModal(kind,titles[kind]||'配置',html);}
async function saveFeatureConfig(){
  const kind = state.featureConfigKind;
  if (kind === 'offline-sources') return saveOfflineSourceConfig();
  if (kind === 'device-log-sources') return saveDeviceLogSources();
  try {
    if (kind === 'overview' || kind === 'app') state.config.port = Number($('#featurePort').value) || 8765;
    if (kind === 'overview' || kind === 'adb') state.config.sdk_root = $('#featureSdk').value.trim();
    if (kind === 'processes') state.config.process_package_keywords = words($('#featureKeywords').value);
    if (kind === 'apk-sources') state.config.apk_sources = readApkSources();
    if (kind === 'process-launch') {
      const packageName = state.featureProcessPackage;
      const command = $('#launchCommand').value.trim();
      if (!/^am\s+(?:start|start-activity)(?:\s|$)/.test(command)) throw new Error('拉起命令必须以 am start 或 am start-activity 开头');
      state.config.app_launches = {
        ...(state.config.app_launches || {}),
        [packageName]: { command },
      };
    }
    const request = { ...state.config };
    await api('/api/config', { method: 'POST', body: JSON.stringify(request) });
    state.config = await api('/api/config');
    renderUserDataPath();
    closeFeatureConfig();
    await refreshAll();
    toast('配置已保存');
  } catch (error) {
    toast(error.message, true);
  }
}

// 命令模板变量：推荐 {{package}}，也兼容 <package>。变量值只用于本次执行。
function commandTemplateVariables(template=$('#adbCommandArgs')?.value||''){const result=[],pattern=/\{\{([A-Za-z][A-Za-z0-9_-]{0,31})\}\}|<([A-Za-z][A-Za-z0-9_-]{0,31})>/g;let match;while((match=pattern.exec(template))!==null){const name=match[1]||match[2];if(!result.includes(name))result.push(name);}return result;}
function adbCommandVariables(){return Object.fromEntries(commandTemplateVariables().map(name=>[name,$(`#adbVariable-${name}`)?.value.trim()||'']));}
function renderAdbCommandVariables(){const container=$('#adbCommandVariables');if(!container)return;const values=adbCommandVariables(),names=commandTemplateVariables();container.innerHTML=names.length?names.map(name=>`<label><span>${escapeHtml(name)}</span><input id="adbVariable-${escapeHtml(name)}" value="${escapeHtml(values[name]||'')}" placeholder="输入 ${escapeHtml(name)}" oninput="updateAdbCommandPreview()"></label>`).join(''):'<span class="command-variable-hint">变量写法：<code>{{package}}</code>（推荐）或 <code>&lt;package&gt;</code>。变量值只用于本次执行，不会保存。</span>';}
function resolveAdbCommandTemplate(template=$('#adbCommandArgs')?.value||'',values=adbCommandVariables()){return template.replace(/\{\{([A-Za-z][A-Za-z0-9_-]{0,31})\}\}|<([A-Za-z][A-Za-z0-9_-]{0,31})>/g,(_,a,b)=>values[a||b]||`<${a||b}>`);}

// 自定义命令仅保存 ADB 参数与超时；执行结果停留在浏览器内，下载时由浏览器生成文本。
function adbCommandPresets(){return state.config?.adb_commands||{}}
function adbCommandData(){return {description:$('#adbCommandDescription').value.trim(),command:$('#adbCommandArgs').value.trim(),timeout_seconds:Number($('#adbCommandTimeout').value)||30};}
function adbCommandSignature(data=adbCommandData()){return JSON.stringify({description:data.description,command:data.command,timeout_seconds:data.timeout_seconds});}
function adbCommandDirty(){const loaded=state.command.loadedName,current=adbCommandSignature();return loaded?current!==state.command.baseline||$('#adbCommandName').value.trim()!==loaded:Boolean($('#adbCommandName').value.trim()||current!==adbCommandSignature({description:'',command:'',timeout_seconds:30}));}
function refreshAdbCommandState(){const el=$('#adbCommandState');if(!el)return;const dirty=adbCommandDirty(),loaded=state.command.loadedName;el.className=`command-preset-state ${dirty?'dirty':'saved'}`;el.textContent=loaded?(dirty?'已修改，未保存':'已保存'):(dirty?'未保存的新命令':'未选择方案');}
function markAdbCommandDirty(){refreshAdbCommandState();}
function setAdbCommandBaseline(name){state.command.loadedName=name||'';state.command.baseline=adbCommandSignature();refreshAdbCommandState();}
function confirmDiscardAdbCommandChanges(action){return !adbCommandDirty()||confirm(`当前自定义命令有未保存修改。${action}将丢弃这些修改，是否继续？`);}
function resetAdbCommandEditor(){if(!$('#adbCommandName'))return;$('#adbCommandName').value='';$('#adbCommandDescription').value='';$('#adbCommandArgs').value='';$('#adbCommandTimeout').value='30';if($('#adbCommandCategory'))$('#adbCommandCategory').value='';$('#adbCommandDelete').disabled=true;$('#adbCommandResultMeta').textContent='尚未执行命令。';$('#adbCommandResult').textContent='等待执行结果。';$('#adbCommandResult').classList.remove('error-result');$('#adbCommandDownload').disabled=true;state.command.result=null;setAdbCommandBaseline('');updateAdbCommandPreview();}
function refreshAdbCommandPresets(selected=''){if(selected&&Object.prototype.hasOwnProperty.call(adbCommandPresets(),selected))state.command.loadedName=selected;refreshCommandCategorySelect();$('#adbCommandDelete').disabled=!state.command.loadedName;renderAdbCommandTree();refreshAdbCommandState();}
function loadAdbCommandPreset(){/* 已由命令选择弹层取代；保留空函数以兼容旧页面书签。 */}
async function saveAdbCommandPreset(){const name=$('#adbCommandName').value.trim(),data=adbCommandData();if(!name)return toast('请填写命令名称',true);if(!data.command)return toast('请填写设备端命令模板',true);const updating=Object.prototype.hasOwnProperty.call(adbCommandPresets(),name);state.config.adb_commands={...adbCommandPresets(),[name]:data};try{await api('/api/config',{method:'POST',body:JSON.stringify(state.config)});state.config=await api('/api/config');$('#adbCommandName').value=name;setAdbCommandBaseline(name);refreshAdbCommandPresets(name);refreshCommandCategorySelect(data.category);renderAdbCommandTree();toast(updating?`命令“${name}”已更新`:`命令“${name}”已保存`);}catch(error){toast(error.message,true)}}
async function deleteAdbCommandPreset(){const name=state.command.loadedName;if(!name)return;if(!confirm(`确认删除命令“${name}”？`))return;delete state.config.adb_commands[name];try{await api('/api/config',{method:'POST',body:JSON.stringify(state.config)});state.config=await api('/api/config');resetAdbCommandEditor();refreshAdbCommandPresets();renderAdbCommandTree();toast(`已删除命令“${name}”`);}catch(error){toast(error.message,true)}}
function updateAdbCommandPreview(){const args=$('#adbCommandArgs')?.value.trim();if($('#adbCommandPreview'))$('#adbCommandPreview').textContent=`adb ${args||'<参数>'}`;}
function commandResultText(result){return ['# Glacien Workbench ADB command result',`# Time: ${new Date().toISOString()}`,`# Command: ${(result.command||[]).join(' ')}`,`# Exit code: ${result.exit_code}`,`# Elapsed: ${result.elapsed_seconds}s`,'','# stdout',result.stdout||'','# stderr',result.stderr||''].join('\n')+'\n'}
function showAdbCommandResult(result){state.command.result=result;const meta=$('#adbCommandResultMeta'),out=$('#adbCommandResult');meta.textContent=`退出码 ${result.exit_code} · 耗时 ${result.elapsed_seconds}s · ${(result.command||[]).join(' ')}`;out.textContent=[result.stdout,result.stderr&&`[stderr]\n${result.stderr}`].filter(Boolean).join('\n\n')||'(无输出)';out.classList.toggle('error-result',!result.ok);$('#adbCommandDownload').disabled=false;}
async function runAdbCommand(confirmed=false){const data=adbCommandData();if(!data.command)return toast('请填写 ADB 参数',true);const button=$('#adbCommandRun');button.disabled=true;button.textContent='执行中…';try{const result=await api('/api/adb-commands/run',{method:'POST',body:JSON.stringify({...data,confirmed})});if(result.requires_confirmation){if(confirm(`危险命令：${result.command.join(' ')}\n\n${result.message}。确认执行？`))return await runAdbCommand(true);return;}showAdbCommandResult(result);toast(result.ok?'命令执行完成':`命令执行失败：退出码 ${result.exit_code}`,!result.ok);}catch(error){$('#adbCommandResultMeta').textContent='执行失败';$('#adbCommandResult').textContent=error.message;$('#adbCommandResult').classList.add('error-result');toast(error.message,true)}finally{button.disabled=false;button.textContent='执行';}}
function downloadAdbCommandResult(){const result=state.command.result;if(!result)return;let name=$('#adbCommandExportName').value.trim()||'adb_command_result';name=name.replace(/[\\/:*?"<>|]+/g,'_');if(!name.toLowerCase().endsWith('.txt'))name+='.txt';const url=URL.createObjectURL(new Blob([commandResultText(result)],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();URL.revokeObjectURL(url);toast(`已下载命令结果：${name}`);}

// 命令模板变量：推荐 {{package}}，也兼容 <package>。变量值只用于本次执行。
function ensureAdbCommandVariables(){
  const commandInput = $('#adbCommandArgs');
  if (!commandInput) return null;
  let panel = $('#adbCommandVariables');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'adbCommandVariables';
    panel.className = 'command-variables';
    commandInput.closest('label').after(panel);
  }
  return panel;
}
function syncAdbCommandVariables(){
  const panel = ensureAdbCommandVariables();
  if (!panel) return;
  const names = commandTemplateVariables();
  const previous = Object.fromEntries([...panel.querySelectorAll('input')].map(function(input){ return [input.dataset.name, input.value]; }));
  const signature = names.join('|');
  if (panel.dataset.signature === signature) return;
  panel.dataset.signature = signature;
  panel.innerHTML = names.length ? names.map(function(name){
    return '<label><span>变量：' + escapeHtml(name) + '</span><input data-name="' + escapeHtml(name) + '" value="' + escapeHtml(previous[name] || '') + '" placeholder="输入 ' + escapeHtml(name) + '"></label>';
  }).join('') : '<span class="command-variable-hint">变量写法：<code>{{package}}</code>（推荐）或 <code>&lt;package&gt;</code>。变量值只用于本次执行，不会保存。</span>';
  panel.querySelectorAll('input').forEach(function(input){ input.addEventListener('input', refreshAdbCommandPreview); });
}
function currentAdbCommandVariables(){
  const panel = ensureAdbCommandVariables();
  if (!panel) return {};
  return Object.fromEntries([...panel.querySelectorAll('input')].map(function(input){ return [input.dataset.name, input.value.trim()]; }));
}
function refreshAdbCommandPreview(){
  syncAdbCommandVariables();
  const resolved = resolveAdbCommandTemplate($('#adbCommandArgs') ? $('#adbCommandArgs').value : '', currentAdbCommandVariables()).trim();
  if ($('#adbCommandPreview')) $('#adbCommandPreview').textContent = 'adb ' + (resolved || '<参数>');
}
const previousResetAdbCommandEditor = resetAdbCommandEditor;
resetAdbCommandEditor = function(){ previousResetAdbCommandEditor(); refreshAdbCommandPreview(); };
runAdbCommand = async function(confirmed){
  const data = adbCommandData();
  if (!data.command) return toast('请填写 ADB 参数', true);
  const button = $('#adbCommandRun');
  button.disabled = true;
  button.textContent = '执行中…';
  try {
    const result = await api('/api/adb-commands/run', { method: 'POST', body: JSON.stringify(withAdbSerial({ ...data, variables: currentAdbCommandVariables(), confirmed: Boolean(confirmed) })) });
    if (result.requires_confirmation) {
      if (confirm('危险命令：' + result.command.join(' ') + '\n\n' + result.message + '。确认执行？')) return await runAdbCommand(true);
      return;
    }
    showAdbCommandResult(result);
    toast(result.ok ? '命令执行完成' : '命令执行失败：退出码 ' + result.exit_code, !result.ok);
  } catch (error) {
    $('#adbCommandResultMeta').textContent = '执行失败';
    $('#adbCommandResult').textContent = error.message;
    $('#adbCommandResult').classList.add('error-result');
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '执行';
  }
};
updateAdbCommandPreview = refreshAdbCommandPreview;
refreshAdbCommandPreview();

const previousSaveFeatureConfig = saveFeatureConfig;
saveFeatureConfig = function(){
  if (state.featureConfigKind === 'command-categories') return saveCommandCategoryManager();
  if (state.featureConfigKind === 'device-file-create-directory') return submitDeviceFileCreate('directory');
  if (state.featureConfigKind === 'device-file-create-file') return submitDeviceFileCreate('file');
  return previousSaveFeatureConfig();
};

function configureDeviceCommandUi(){
  const page = $('#commands');
  if (!page) return;
  const description = page.querySelector('.page-description');
  if (description) description.innerHTML = '只填写 Android 设备端命令。工具固定以 <code>adb shell sh -c</code> 执行，命令保存到 <code>adb-tools/commands/commands.json</code>。';
  const commandInput = $('#adbCommandArgs');
  if (commandInput) {
    commandInput.placeholder = '例如：pm list packages -3 或 dumpsys package {{package}} | grep {{permission}}';
    const label = commandInput.closest('label');
    if (label && label.firstChild) label.firstChild.textContent = '设备端命令模板';
  }
}
configureDeviceCommandUi();

// 已保存项选择器：命令分类树、外置新建命令，以及离线/广播的外置新建入口。
function commandCategories(){
  const configured = Array.isArray(state.config && state.config.adb_command_categories) ? state.config.adb_command_categories : [];
  const assigned = Object.values(adbCommandPresets()).map(function(item){ return String((item || {}).category || '').trim(); }).filter(Boolean);
  return [...new Set([...configured.map(function(item){ return String(item).trim(); }).filter(Boolean), ...assigned])];
}
function refreshCommandCategorySelect(selected){
  const select = $('#adbCommandCategory');
  if (!select) return;
  const current = selected !== undefined ? selected : select.value;
  select.innerHTML = '<option value="">未分类</option>' + commandCategories().map(function(category){ return '<option value="' + escapeHtml(category) + '">' + escapeHtml(category) + '</option>'; }).join('');
  select.value = commandCategories().includes(current) ? current : '';
}
function ensureCommandLibrary(){
  const workspace = $('.command-workspace');
  if (!workspace || !$('#adbCommandLibrary') || !$('#adbCommandCategory')) return;
  refreshCommandCategorySelect();
  renderAdbCommandTree();
}
function renderAdbCommandTree(){
  const status = $('#adbCommandLibraryStatus');
  if (status) {
    const name = state.command.loadedName;
    const item = name ? adbCommandPresets()[name] : null;
    status.textContent = item ? '当前：' + name + ' · ' + (item.category || '未分类') : '未选择命令；可新建或从命令库选择';
  }
  renderAdbCommandPicker();
}
function commandGroups(query){
  const keyword = String(query || '').trim().toLocaleLowerCase();
  const groups = new Map(commandCategories().map(function(category){ return [category, []]; }));
  groups.set('', []);
  Object.entries(adbCommandPresets()).forEach(function(entry){
    const name = entry[0], item = entry[1] || {}, category = String(item.category || '').trim();
    if (keyword && ![name, item.description || '', item.command || '', category].join(' ').toLocaleLowerCase().includes(keyword)) return;
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push([name, item]);
  });
  return groups;
}
function commandCategoryRow(name){ return '<div class="command-category-row" data-original="' + escapeHtml(name || '') + '"><input value="' + escapeHtml(name || '') + '" placeholder="分类名称，例如：包管理"><button class="icon-button" type="button" onclick="removeCommandCategoryRow(this)">×</button></div>'; }
function addCommandCategoryRow(){ $('#commandCategoryRows').insertAdjacentHTML('beforeend', commandCategoryRow('')); }
function removeCommandCategoryRow(button){ const rows = $$('#commandCategoryRows .command-category-row'); if (rows.length === 1) { rows[0].querySelector('input').value = ''; return; } button.closest('.command-category-row').remove(); }
function openCommandCategoryManager(){
  const rows = commandCategories().map(commandCategoryRow).join('') || commandCategoryRow('');
  openFeatureModal('command-categories','命令分类','<div class="command-category-editor"><p class="page-description">分类只用于组织已保存的设备端命令。修改分类名称会自动同步该分类下的已保存命令；删除仍被命令使用的分类前，请先为这些命令改到其他分类。</p><div id="commandCategoryRows">' + rows + '</div><button class="button subtle" type="button" onclick="addCommandCategoryRow()">添加分类</button></div>');
}
function saveCommandCategoryManager(){
  const rows = $$('#commandCategoryRows .command-category-row').map(function(row){ return { original: String(row.dataset.original || '').trim(), value: row.querySelector('input').value.trim() }; });
  const categories = rows.map(function(row){ return row.value; }).filter(Boolean);
  if (new Set(categories).size !== categories.length) return toast('分类名称不能重复', true);
  const commands = adbCommandPresets();
  const renameMap = new Map(rows.filter(function(row){ return row.original && row.original !== row.value; }).map(function(row){ return [row.original, row.value]; }));
  const rowByOriginal = new Map(rows.filter(function(row){ return row.original; }).map(function(row){ return [row.original, row]; }));
  const missing = commandCategories().find(function(category){
    const row = rowByOriginal.get(category);
    const nextCategory = row ? row.value : '';
    return !nextCategory && Object.values(commands).some(function(item){ return String((item || {}).category || '').trim() === category; });
  });
  if (missing) return toast('分类“' + missing + '”仍被已保存命令使用，请先为这些命令选择其他分类', true);
  const nextCommands = Object.fromEntries(Object.entries(commands).map(function(entry){
    const name = entry[0], item = entry[1] || {}, current = String(item.category || '').trim();
    const nextCategory = renameMap.has(current) ? renameMap.get(current) : current;
    return [name, Object.assign({}, item, { category: nextCategory || '' })];
  }));
  const selectedCategory = $('#adbCommandCategory') ? $('#adbCommandCategory').value : '';
  const nextSelectedCategory = renameMap.has(selectedCategory) ? renameMap.get(selectedCategory) : selectedCategory;
  state.config.adb_command_categories = categories;
  state.config.adb_commands = nextCommands;
  return api('/api/config', { method: 'POST', body: JSON.stringify(state.config) }).then(async function(){
    state.config = await api('/api/config');
    if ($('#adbCommandCategory')) refreshCommandCategorySelect(nextSelectedCategory);
    if (state.command.loadedName) {
      try {
        const baseline = JSON.parse(state.command.baseline || '{}');
        if (renameMap.has(baseline.category || '')) baseline.category = renameMap.get(baseline.category || '');
        state.command.baseline = JSON.stringify(baseline);
      } catch (_) { /* 旧状态异常时保留现有脏状态判断。 */ }
    }
    closeFeatureConfig();
    refreshAdbCommandPresets(state.command.loadedName);
    toast('命令分类已保存');
  }).catch(function(error){ toast(error.message, true); });
}
function openAdbCommandPicker(){
  openFeatureModal('command-picker','选择设备端命令','<div class="command-picker"><p class="page-description">命令按分类收起。展开一个分类后选择命令，不会在当前页面铺开列表。</p><label class="command-picker-search"><span>搜索已保存命令</span><input id="commandPickerSearch" placeholder="名称、分类、说明或命令内容" oninput="renderAdbCommandPicker()" autofocus></label><div id="commandPickerList" class="command-picker-list"></div></div>',{hideFooter:true});
  renderAdbCommandPicker();
  $('#commandPickerSearch').focus();
}
function renderAdbCommandPicker(){
  const list = $('#commandPickerList');
  if (!list) return;
  const query = $('#commandPickerSearch') ? $('#commandPickerSearch').value : '';
  const hasQuery = Boolean(String(query || '').trim());
  list.innerHTML = '';
  let count = 0;
  commandGroups(query).forEach(function(items, category){
    if (!items.length) return;
    count += items.length;
    const details = document.createElement('details');
    details.className = 'command-picker-category';
    details.open = hasQuery;
    const summary = document.createElement('summary');
    summary.innerHTML = '<span>' + escapeHtml(category || '未分类') + '</span><small>' + items.length + ' 条</small>';
    details.append(summary);
    const commands = document.createElement('div');
    commands.className = 'command-picker-commands';
    items.sort(function(a,b){ return a[0].localeCompare(b[0]); }).forEach(function(entry){
      const name = entry[0], item = entry[1];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'command-picker-item' + (name === state.command.loadedName ? ' selected' : '');
      button.innerHTML = '<b>' + escapeHtml(name) + '</b><small>' + escapeHtml(item.description || item.command || '未填写说明') + '</small>';
      button.onclick = function(){ loadAdbCommandByName(name); };
      commands.append(button);
    });
    details.append(commands);
    list.append(details);
  });
  if (!count) list.innerHTML = '<span class="command-picker-empty">没有匹配的已保存命令。</span>';
}
function newAdbCommand(){
  if (!confirmDiscardAdbCommandChanges('新建命令')) return;
  closeFeatureConfig();
  resetAdbCommandEditor();
  refreshCommandCategorySelect('');
  $('#adbCommandDelete').disabled = true;
  $('#adbCommandState').textContent = '未保存的新命令';
  renderAdbCommandTree();
  $('#adbCommandName').focus();
}
function loadAdbCommandByName(name){
  if (name !== state.command.loadedName && !confirmDiscardAdbCommandChanges('切换到命令“' + name + '”')) return false;
  const item = adbCommandPresets()[name] || {};
  $('#adbCommandName').value = name;
  $('#adbCommandDescription').value = item.description || '';
  $('#adbCommandArgs').value = item.command || '';
  $('#adbCommandTimeout').value = item.timeout_seconds || 30;
  refreshCommandCategorySelect(item.category || '');
  $('#adbCommandDelete').disabled = false;
  setAdbCommandBaseline(name);
  refreshAdbCommandPreview();
  renderAdbCommandTree();
  if (state.featureConfigKind === 'command-picker') closeFeatureConfig();
  return true;
}
const existingAdbCommandData = adbCommandData;
adbCommandData = function(){ return Object.assign({}, existingAdbCommandData(), { category: $('#adbCommandCategory') ? $('#adbCommandCategory').value : '' }); };
adbCommandSignature = function(data){ const value = data || adbCommandData(); return JSON.stringify({ description:value.description, command:value.command, timeout_seconds:value.timeout_seconds, category:value.category || '' }); };
refreshAdbCommandPresets = function(selected){
  if (selected !== undefined && Object.prototype.hasOwnProperty.call(adbCommandPresets(), selected)) state.command.loadedName = selected;
  refreshCommandCategorySelect();
  renderAdbCommandTree();
  refreshAdbCommandState();
};
saveAdbCommandPreset = async function(){
  const name = $('#adbCommandName').value.trim(), data = adbCommandData();
  if (!name) return toast('请填写命令名称', true);
  if (!data.command) return toast('请填写设备端命令模板', true);
  const updating = Object.prototype.hasOwnProperty.call(adbCommandPresets(), name);
  state.config.adb_commands = Object.assign({}, adbCommandPresets(), { [name]: data });
  try { await api('/api/config', { method:'POST', body:JSON.stringify(state.config) }); state.config = await api('/api/config'); $('#adbCommandName').value=name; refreshAdbCommandPresets(name); refreshCommandCategorySelect(data.category); setAdbCommandBaseline(name); renderAdbCommandTree(); toast(updating ? '命令“' + name + '”已更新' : '命令“' + name + '”已保存'); } catch(error){ toast(error.message, true); }
};
deleteAdbCommandPreset = async function(){
  const name = state.command.loadedName;
  if (!name) return;
  if (!confirm('确认删除命令“' + name + '”？')) return;
  delete state.config.adb_commands[name];
  try { await api('/api/config', { method:'POST', body:JSON.stringify(state.config) }); state.config = await api('/api/config'); newAdbCommand(); refreshAdbCommandPresets(); toast('已删除命令“' + name + '”'); } catch(error){ toast(error.message, true); }
};
function newOfflineAnalysisScheme(){
  if (!confirmDiscardOfflinePresetChanges('新建过滤方案')) return;
  resetOfflinePresetEditor();
  $('#offlinePresetSelect').value = '';
  $('#offlineResultStatus').textContent = '新建过滤方案：填写条件和高亮后再保存。';
  $('#offlinePresetName').focus();
}
function enhanceOfflineSchemeSelector(){
  const bar = $('.offline-preset-bar');
  if (!bar || $('#offlineNewPresetButton')) return;
  const button = document.createElement('button');
  button.id = 'offlineNewPresetButton';
  button.type = 'button';
  button.className = 'button subtle';
  button.textContent = '新建方案';
  button.onclick = newOfflineAnalysisScheme;
  const input = bar.querySelector('input');
  if (input) input.before(button);
}
function newBroadcastPreset(){
  $('#broadcastPreset').value = '';
  $('#broadcastName').value = '';
  $('#broadcastAction').value = '';
  $('#broadcastPackage').value = '';
  $('#broadcastExtras').innerHTML = '';
  addBroadcastExtra();
  updateBroadcastPreview();
  $('#broadcastName').focus();
}
loadBroadcasts = async function(){
  try { const presets = await api('/api/broadcasts'); const select = $('#broadcastPreset'), current = select.value; select.innerHTML = '<option value="" disabled>选择已保存广播…</option>' + Object.keys(presets).sort().map(function(name){ return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>'; }).join(''); if (presets[current]) select.value = current; else select.value = ''; if (!$('#broadcastExtras').children.length) addBroadcastExtra(); updateBroadcastPreview(); } catch(error){ toast(error.message, true); }
};
loadBroadcastPreset = function(){ const preset = activeBroadcasts()[$('#broadcastPreset').value]; if (!preset) return; $('#broadcastName').value = $('#broadcastPreset').value; $('#broadcastAction').value = preset.action || ''; $('#broadcastPackage').value = preset.package || ''; $('#broadcastExtras').innerHTML = ''; (preset.extras || []).forEach(addBroadcastExtra); if (!(preset.extras || []).length) addBroadcastExtra(); updateBroadcastPreview(); };
function enhanceBroadcastSelector(){
  const controls = $('#broadcast .log-controls');
  if (!controls || $('#newBroadcastButton')) return;
  const button = document.createElement('button');
  button.id = 'newBroadcastButton';
  button.type = 'button';
  button.className = 'button subtle';
  button.textContent = '新建广播';
  button.onclick = newBroadcastPreset;
  controls.prepend(button);
}
ensureCommandLibrary();
enhanceOfflineSchemeSelector();
enhanceBroadcastSelector();
refreshAdbCommandPresets();
refreshAdbCommandPreview();

// 命令页只保留临时测试；保存命令统一在弹窗编辑，避免主页面堆叠输入框。
function commandEditorDataV2(){
  const previous=state.command.editingName||state.command.loadedName||'',existing=adbCommandPresets()[previous]||{};
  return {
    ...(existing.id?{id:existing.id}:{}),
    description: $('#adbCommandDescription') ? $('#adbCommandDescription').value.trim() : '',
    command: $('#adbCommandArgs') ? $('#adbCommandArgs').value.trim() : '',
    timeout_seconds: Number($('#adbCommandTimeout') ? $('#adbCommandTimeout').value : 30) || 30,
    category: $('#adbCommandCategory') ? $('#adbCommandCategory').value : '',
  };
}
function commandEditorSignatureV2(data){
  const value = data || commandEditorDataV2();
  return JSON.stringify({description:value.description,command:value.command,timeout_seconds:value.timeout_seconds,category:value.category || ''});
}
function testCommandTemplateV2(){ return $('#adbTestCommand') ? $('#adbTestCommand').value.trim() : ''; }
function testCommandVariablesV2(){
  return Object.fromEntries($$('#adbTestVariables input').map(function(input){ return [input.dataset.name, input.value.trim()]; }));
}
function renderAdbTestVariablesV2(){
  const panel = $('#adbTestVariables');
  if (!panel) return;
  const values = testCommandVariablesV2(), names = commandTemplateVariables(testCommandTemplateV2());
  const signature = names.join('|');
  if (panel.dataset.signature === signature) return;
  panel.dataset.signature = signature;
  panel.innerHTML = names.length ? names.map(function(name){
    return '<label><span>变量：' + escapeHtml(name) + '</span><input data-name="' + escapeHtml(name) + '" value="' + escapeHtml(values[name] || '') + '" placeholder="输入 ' + escapeHtml(name) + '"></label>';
  }).join('') : '<span class="command-variable-hint">可使用 <code>{{package}}</code> 或 <code>&lt;package&gt;</code>，变量只用于本次测试。</span>';
  panel.querySelectorAll('input').forEach(function(input){ input.addEventListener('input', refreshAdbTestPreviewV2); });
}
function refreshAdbTestPreviewV2(){
  renderAdbTestVariablesV2();
  const resolved = resolveAdbCommandTemplate(testCommandTemplateV2(), testCommandVariablesV2()).trim();
  const preview = $('#adbTestPreview');
  if (preview) preview.textContent = 'adb shell sh -c ' + (resolved || '<命令>');
}
function syncTestCommandV2(command, timeout){
  if ($('#adbTestCommand')) $('#adbTestCommand').value = command || '';
  if ($('#adbTestTimeout')) $('#adbTestTimeout').value = timeout || 30;
  const panel = $('#adbTestVariables');
  if (panel) panel.dataset.signature = '';
  refreshAdbTestPreviewV2();
}
function commandModalContentV2(name, item){
  const remove = name ? '<button class="button danger" type="button" onclick="deleteAdbCommandPreset()">删除命令</button>' : '';
  return '<div class="command-editor-modal"><p class="page-description">保存的是设备端命令模板；变量值不会写入配置。</p><div class="command-editor-fields"><label>命令名称<input id="adbCommandName" placeholder="例如：列出第三方应用" oninput="markAdbCommandDirty()"></label><label>分类<select id="adbCommandCategory" onchange="markAdbCommandDirty()"></select></label><label class="command-editor-description">说明（可选）<input id="adbCommandDescription" placeholder="例如：查询已安装第三方包名" oninput="markAdbCommandDirty()"></label><label class="command-editor-template">设备端命令模板<input id="adbCommandArgs" placeholder="例如：pm list packages -3 或 dumpsys package {{package}} | grep {{permission}}" oninput="markAdbCommandDirty();refreshAdbCommandPreview()"></label><label>超时（秒）<input id="adbCommandTimeout" type="number" min="1" max="300" oninput="markAdbCommandDirty();refreshAdbCommandPreview()"></label></div><div id="adbCommandVariables" class="command-variables"></div><div class="command-editor-preview"><code id="adbCommandPreview">adb shell sh -c &lt;命令&gt;</code></div>' + remove + '</div>';
}
openAdbCommandEditor = function(name){
  const commandName = name || '';
  const item = commandName ? adbCommandPresets()[commandName] : {};
  if (commandName && !item) return toast('命令不存在或已被删除', true);
  openFeatureModal('command-editor', commandName ? '编辑命令：' + commandName : '新建命令', commandModalContentV2(commandName, item));
  $('#adbCommandName').value = commandName;
  $('#adbCommandDescription').value = item.description || '';
  $('#adbCommandArgs').value = item.command || '';
  $('#adbCommandTimeout').value = item.timeout_seconds || 30;
  refreshCommandCategorySelect(item.category || '');
  state.command.editingName = commandName;
  state.command.baseline = commandEditorSignatureV2();
  refreshAdbCommandPreview();
  refreshAdbCommandState();
};
adbCommandData = commandEditorDataV2;
adbCommandSignature = commandEditorSignatureV2;
adbCommandDirty = function(){
  const nameInput = $('#adbCommandName');
  if (!nameInput) return false;
  const editing = state.command.editingName || '';
  return editing ? commandEditorSignatureV2() !== state.command.baseline || nameInput.value.trim() !== editing : Boolean(nameInput.value.trim() || commandEditorSignatureV2() !== commandEditorSignatureV2({description:'',command:'',timeout_seconds:30,category:''}));
};
refreshAdbCommandState = function(){
  const label = $('#adbCommandState');
  if (!label) return;
  const editing = state.command.editingName || '', dirty = adbCommandDirty();
  label.className = 'command-preset-state ' + (dirty ? 'dirty' : 'saved');
  label.textContent = editing ? (dirty ? '已修改，未保存' : '已保存') : (dirty ? '未保存的新命令' : '新命令');
};
markAdbCommandDirty = function(){ refreshAdbCommandState(); };
confirmDiscardAdbCommandChanges = function(action){ return !adbCommandDirty() || confirm('当前命令编辑有未保存修改。' + action + '将丢弃这些修改，是否继续？'); };
newAdbCommand = function(){ openAdbCommandEditor(); };
loadAdbCommandByName = function(name){
  const item = adbCommandPresets()[name];
  if (!item) return toast('命令不存在或已被删除', true);
  state.command.loadedName = name;
  syncTestCommandV2(item.command, item.timeout_seconds);
  const edit = $('#adbCommandEdit');
  if (edit) edit.disabled = false;
  renderAdbCommandTree();
  if (state.featureConfigKind === 'command-picker') closeFeatureConfig();
  toast('已载入命令“' + name + '”到临时测试区');
  return true;
};
renderAdbCommandTree = function(){
  const name = state.command.loadedName, item = name ? adbCommandPresets()[name] : null, status = $('#adbCommandLibraryStatus'), edit = $('#adbCommandEdit');
  if (status) status.textContent = item ? '当前：' + name + ' · ' + (item.category || '未分类') : '未选择命令；可新建或从命令库选择';
  if (edit) edit.disabled = !item;
  renderAdbCommandPicker();
};
refreshAdbCommandPresets = function(selected){
  if (selected && Object.prototype.hasOwnProperty.call(adbCommandPresets(), selected)) state.command.loadedName = selected;
  renderAdbCommandTree();
};
saveAdbCommandPreset = async function(){
  const name = $('#adbCommandName') ? $('#adbCommandName').value.trim() : '', data = commandEditorDataV2(), previous = state.command.editingName || '';
  if (!name) return toast('请填写命令名称', true);
  if (!data.command) return toast('请填写设备端命令模板', true);
  if (previous && previous !== name && Object.prototype.hasOwnProperty.call(adbCommandPresets(), name) && !confirm('命令“' + name + '”已存在，确认覆盖它并将当前命令改名？')) return;
  const commands = Object.assign({}, adbCommandPresets(), {[name]:data});
  if (previous && previous !== name) delete commands[previous];
  state.config.adb_commands = commands;
  try {
    await api('/api/config', {method:'POST',body:JSON.stringify(state.config)});
    state.config = await api('/api/config');
    state.command.loadedName = name;
    closeFeatureConfig();
    syncTestCommandV2(data.command, data.timeout_seconds);
    refreshAdbCommandPresets(name);
    toast(previous ? '命令“' + name + '”已更新' : '命令“' + name + '”已保存');
  } catch(error) { toast(error.message, true); }
};
deleteAdbCommandPreset = async function(){
  const name = state.command.editingName || state.command.loadedName;
  if (!name || !confirm('确认删除命令“' + name + '”？')) return;
  delete state.config.adb_commands[name];
  try {
    await api('/api/config', {method:'POST',body:JSON.stringify(state.config)});
    state.config = await api('/api/config');
    if (state.command.loadedName === name) { state.command.loadedName = ''; syncTestCommandV2('', 30); }
    closeFeatureConfig();
    refreshAdbCommandPresets();
    toast('已删除命令“' + name + '”');
  } catch(error) { toast(error.message, true); }
};
runAdbCommand = async function(confirmed){
  const command = testCommandTemplateV2();
  if (!command) return toast('请填写要测试的设备端命令', true);
  const button = $('#adbCommandRun');
  button.disabled = true; button.textContent = '执行中…';
  try {
    const result = await api('/api/adb-commands/run', {method:'POST',body:JSON.stringify(withAdbSerial({command:command,timeout_seconds:Number($('#adbTestTimeout') ? $('#adbTestTimeout').value : 30) || 30,variables:testCommandVariablesV2(),confirmed:Boolean(confirmed)}))});
    if (result.requires_confirmation) {
      if (confirm('危险命令：' + result.command.join(' ') + '\n\n' + result.message + '。确认执行？')) return await runAdbCommand(true);
      return;
    }
    showAdbCommandResult(result);
    toast(result.ok ? '命令执行完成' : '命令执行失败：退出码 ' + result.exit_code, !result.ok);
  } catch(error) {
    $('#adbCommandResultMeta').textContent = '执行失败'; $('#adbCommandResult').textContent = error.message; $('#adbCommandResult').classList.add('error-result'); toast(error.message, true);
  } finally { button.disabled = false; button.textContent = '执行'; }
};
function downloadSharedBlobV2(data, name){
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], {type:'application/json;charset=utf-8'}));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
async function downloadSharedConfig(){
  try {
    const shared = await api('/api/config/export');
    downloadSharedBlobV2(shared, 'glacien-rules-' + new Date().toISOString().slice(0,10) + '.json');
    toast('已导出可分享规则 JSON');
  } catch(error) { toast(error.message, true); }
}
async function importSharedConfig(files){
  const file = files && files[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (!confirm('导入会按功能合并命令、广播和日志规则；不会修改端口、SDK、APK、资源或 Keystore。外部同名规则会覆盖本地同名规则，是否继续？')) return;
    const result = await api('/api/config/import', {method:'POST',body:JSON.stringify(payload)});
    state.config = result.config || await api('/api/config');
    renderSettings(); renderUserDataPath(); refreshOfflineFilterPresets(); refreshAdbCommandPresets(); await loadLogFilters();
    const detail = Object.entries(result.imported || {}).map(function(entry){ return entry[0] + ' ' + entry[1] + ' 项'; }).join('、');
    const skipped=(result.skipped_features||[]).length?'；当前版本未识别并跳过：'+result.skipped_features.join('、'):'';
    toast('规则导入完成：' + detail + skipped);
  } catch(error) { toast('导入失败：' + error.message, true); }
  finally { if ($('#sharedConfigImport')) $('#sharedConfigImport').value = ''; }
}

// 单一 target 模型：资源包各自记忆设备部署路径。
function renderUserDataPath(){const target=$('#userDataPath');if(target)target.textContent=state.config?._meta?.data_root||'读取中…'}
function renderSettingsPath(target,value){if(!target)return;target.textContent=value;target.title=value==='读取中…'?'':value;}
renderSettings=function(){const meta=state.config?._meta||{};renderSettingsPath($('#appConfigPath'),meta.app_config||'读取中…');renderSettingsPath($('#settingsDataRoot'),meta.data_root||'读取中…')}
function renderAppVersion(){const target=$('#appVersion'),version=state.config?._meta?.version||'0.3.6';if(target)target.textContent='Glacien Workbench · v'+version}
function renderReleaseTimeline(){const meta=state.config?._meta||{},current=meta.version||'0.3.6',target=$('#releaseTimeline'),label=$('#currentReleaseVersion');if(label)label.textContent='v'+current;if(!target)return;const releases=Array.isArray(meta.releases)?meta.releases:[];if(!releases.length){target.innerHTML='<p class="release-empty">当前版本 v'+escapeHtml(current)+'，暂无更新记录。</p>';return}const visible=releases.slice(0,3),hasOlder=releases.length>visible.length;target.innerHTML=visible.map(item=>{const version=String(item.version||''),changes=Array.isArray(item.changes)?item.changes:[];return `<article class="release-entry"><div class="release-marker"></div><div class="release-entry-body"><header><div><b>v${escapeHtml(version||current)}</b>${version===current?'<span>当前版本</span>':''}</div><time>${escapeHtml(item.date||'')}</time></header><h3>${escapeHtml(item.title||'版本更新')}</h3><ul>${changes.map(change=>`<li>${escapeHtml(change)}</li>`).join('')}</ul></div></article>`}).join('')+(hasOlder?'<p class="release-older" aria-label="还有更早版本未展示">···<span>更早版本暂不展示</span></p>':'')}
async function revealUserDataDirectory(){try{const result=await api('/api/system/reveal-data',{method:'POST',body:'{}'});if(result.ok)return toast('已打开用户数据目录：'+result.directory);let copied=false;try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(result.directory);copied=true}}catch(error){}toast('系统文件窗口未能打开：'+(result.error||result.directory)+(copied?'（路径已复制）':''),true)}catch(error){toast(error.message,true)}}
async function exportAdbCommands(){try{const data=await api('/api/adb-commands/export');downloadSharedBlobV2(data,'glacien-commands.json');toast('已导出自定义命令 JSON')}catch(error){toast(error.message,true)}}
async function importAdbCommands(files){const file=files?.[0];if(!file)return;try{const payload=JSON.parse(await file.text());const result=await api('/api/adb-commands/import',{method:'POST',body:JSON.stringify(payload)});state.config=result.config||await api('/api/config');refreshAdbCommandPresets();renderAdbCommandTree();const renamed=Object.keys(result.renamed||{}).length;toast(`命令导入完成：新增 ${result.added}，跳过相同 ${result.skipped}${renamed?`，重命名冲突 ${renamed}`:''}`)}catch(error){toast('导入命令失败：'+error.message,true)}finally{if($('#adbCommandImport'))$('#adbCommandImport').value=''}}
function resourceDevicePath(index){return $(`#resource-path-${index}`)?.value.trim()||''}
async function saveResourcePath(index){const item=state.resources[index],path=resourceDevicePath(index);if(!item)return;if(!path)return toast('请填写设备端绝对目录',true);state.config.resource_device_paths={...(state.config.resource_device_paths||{}),[item.name]:path};try{await api('/api/config',{method:'POST',body:JSON.stringify(state.config)});state.config=await api('/api/config');toast(`已保存 ${item.name} 的部署路径`)}catch(error){toast(error.message,true)}}
loadResources=async function(){const list=$('#resourceList');list.innerHTML='<div class="artifact-row">正在扫描资源包…</div>';try{state.resources=await api('/api/resources');list.innerHTML=state.resources.length?state.resources.map((item,index)=>`<div class="artifact-row resource-row"><input class="check resource-check" type="checkbox" value="${escapeHtml(item.path)}" data-index="${index}" onchange="updateResourceSelection()"><span class="file-icon">TAR</span><span class="artifact-main"><b>${escapeHtml(item.name)}</b><span>${formatSize(item.size)} · ${new Date(item.modified).toLocaleString()}</span><span class="md5-value" id="resource-md5-${index}">MD5：按“MD5”计算 · 推送前清理：${escapeHtml((item.cleanup_entries||[]).join('、')||'无顶层内容')}</span><label class="resource-path-field"><span>设备部署目录</span><input id="resource-path-${index}" value="${escapeHtml(item.device_path||'')}" placeholder="/sdcard/resources/"></label></span><button class="row-action" onclick="saveResourcePath(${index})">保存路径</button><button class="row-action" onclick="showResourceMd5(${index})">MD5</button><button class="row-action danger-action" onclick="deleteResource(${index})">删除</button></div>`).join(''):'<div class="artifact-row"><span class="artifact-main"><b>没有资源包</b><span>点击右上角“上传资源”添加 .tar.gz 文件。</span></span></div>';updateResourceSelection()}catch(error){list.innerHTML=`<div class="artifact-row">${escapeHtml(error.message)}</div>`}}
showResourceMd5=async function(index){const item=state.resources[index],target=$(`#resource-md5-${index}`);if(!item||!target)return;target.textContent='MD5：计算中…';try{const result=await api('/api/resources/md5',{method:'POST',body:JSON.stringify({file:item.path})});target.textContent=`MD5：${result.md5} · 推送前清理：${(item.cleanup_entries||[]).join('、')||'无顶层内容'}`;await navigator.clipboard?.writeText(result.md5);toast(`MD5 已计算并复制到剪贴板：${item.name}`)}catch(error){target.textContent='MD5：计算失败';toast(error.message,true)}}
deleteResource=async function(index){const item=state.resources[index];if(!item||!confirm(`确认删除资源包？\n\n${item.name}\n\n此操作不可恢复。`))return;try{await api('/api/resources/delete',{method:'POST',body:JSON.stringify({file:item.path})});if(state.config.resource_device_paths)delete state.config.resource_device_paths[item.name];await api('/api/config',{method:'POST',body:JSON.stringify(state.config)});state.config=await api('/api/config');toast(`已删除 ${item.name}`);loadResources()}catch(error){toast(error.message,true)}}
uploadResource=async function(files){const file=files?.[0];if(!file)return;if(!file.name.endsWith('.tar.gz'))return toast('只支持上传 .tar.gz 资源包',true);const body=new FormData();body.append('file',file);try{const response=await fetch('/api/resources/upload',{method:'POST',body});const data=await response.json();if(!response.ok)throw new Error(data.error||'上传失败');toast(`已上传 ${data.name}，请为它配置设备部署目录`);loadResources()}catch(error){toast(error.message,true)}finally{$('#resourceUpload').value=''}}
pushResources=async function(){const selections=$$('.resource-check:checked').map(input=>{const index=Number(input.dataset.index);return {index,file:input.value,name:state.resources[index].name,device_path:resourceDevicePath(index)}});if(!selections.length)return;const missing=selections.filter(item=>!item.device_path);if(missing.length)return toast('请先为所有选中的资源包配置设备部署目录',true);if(!confirm(`确认推送 ${selections.length} 个资源包？\n\n每个资源包会先删除各自部署目录下与其顶层目录同名的旧内容。`))return;const button=$('#pushResourcesButton');button.disabled=true;button.textContent='推送中…';try{state.config.resource_device_paths={...(state.config.resource_device_paths||{}),...Object.fromEntries(selections.map(item=>[item.name,item.device_path]))};await api('/api/config',{method:'POST',body:JSON.stringify(state.config)});state.config=await api('/api/config');const deployments=selections.map(({file,device_path})=>({file,device_path}));const result=await api('/api/resources/push',{method:'POST',body:JSON.stringify(withAdbSerial({deployments}))});const failed=result.results.filter(item=>!item.ok);toast(failed.length?`推送失败：${failed[0].output}`:`已部署 ${result.results.length} 个资源包`,Boolean(failed.length));if(!failed.length)await loadResources()}catch(error){toast(error.message,true)}finally{updateResourceSelection()}}
collectSelectedApks=async function(){const files=$$('.apk-source-check:checked').map(input=>({source:input.dataset.source,relative_path:input.dataset.path}));if(!files.length)return toast('请至少选择一个 APK',true);const button=$('#collectApksButton'),overwrite=Boolean($('#apkSourceOverwrite')?.checked);button.disabled=true;button.textContent='导入中…';try{const result=await api('/api/apks/collect',{method:'POST',body:JSON.stringify({files,overwrite})});if(result.requires_confirmation){button.disabled=false;button.textContent='导入所选 APK';if(confirm('adb-tools/apk-center/files/ 已存在同名 APK：\n'+result.conflicts.join('\n')+'\n\n确认覆盖？')){$('#apkSourceOverwrite').checked=true;return collectSelectedApks()}return}closeFeatureConfig();await loadApks();toast('已导入 '+result.results.length+' 个 APK')}catch(error){toast(error.message,true);button.disabled=false;button.textContent='导入所选 APK'}}
const saveFeatureConfigBeforeCommandEditor = saveFeatureConfig;
saveFeatureConfig = function(){
  if (state.featureConfigKind === 'command-editor') return saveAdbCommandPreset();
  return saveFeatureConfigBeforeCommandEditor();
};
refreshAdbTestPreviewV2();
// HTML 事件属性使用这个简洁名称，实际实现保留 V2 以区别旧命令编辑逻辑。
refreshAdbTestPreview = refreshAdbTestPreviewV2;


async function uploadApk(files){
  const file = files && files[0];
  if (!file) return;
  const body = new FormData(); body.append("file", file);
  try {
    const response = await fetch("/api/apks/upload", {method:"POST", body});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "上传失败");
    toast("已上传 APK：" + data.name); loadApks();
  } catch(error) { toast(error.message, true); }
  finally { if ($("#apkUpload")) $("#apkUpload").value = ""; }
}
async function uploadKeystore(files){
  const file = files && files[0];
  if (!file) return;
  const body = new FormData(); body.append("file", file);
  try {
    const response = await fetch("/api/keystores/upload", {method:"POST", body});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "上传失败");
    toast("已上传签名文件：" + data.name + "。现在可直接在签名页选择它。"); loadSignPage();
  } catch(error) { toast(error.message, true); }
  finally { if ($("#keystoreUpload")) $("#keystoreUpload").value = ""; }
}
async function loadKeystoreFiles(){
  const list = $("#keystoreFileList");
  if (!list) return;
  list.innerHTML = '<div class="artifact-row">正在读取签名文件…</div>';
  try {
    const files = await api("/api/keystore-files");
    list.innerHTML = "";
    if (!files.length) {
      list.innerHTML = '<div class="artifact-row"><span class="artifact-main"><b>没有签名文件</b><span>点击“上传签名文件”添加 .jks 或 .keystore。</span></span></div>';
      return;
    }
    files.forEach(function(file){
      const row = document.createElement("div");
      row.className = "artifact-row";
      const icon = document.createElement("span"); icon.className = "file-icon"; icon.textContent = "KEY";
      const main = document.createElement("span"); main.className = "artifact-main";
      const title = document.createElement("b"); title.textContent = file.name;
      const detail = document.createElement("span"); detail.textContent = file.path + " · " + formatSize(file.size) + " · 可直接选择用于签名";
      main.append(title, detail);
      const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = "READY";
      const remove = document.createElement("button"); remove.className = "row-action danger-action"; remove.textContent = "删除"; remove.title = "删除签名文件";
      remove.onclick = function(){ deleteKeystoreFile(file.name); };
      row.append(icon, main, tag, remove); list.append(row);
    });
  } catch(error) { list.innerHTML = '<div class="artifact-row">' + escapeHtml(error.message) + "</div>"; }
}
async function deleteKeystoreFile(name){
  if (!confirm("确认删除签名文件 “" + name + "”？此操作不可恢复。")) return;
  try {
    const result = await api("/api/keystores/delete", {method:"POST", body:JSON.stringify({file:name})});
    toast("已删除签名文件：" + result.file);
    await loadSignPage();
    if (state.featureConfigKind === "keystore-manager") await loadKeystoreFiles();
  } catch(error) { toast(error.message, true); }
}

function keystoreManagerContent(){
  return '<p class="page-description">签名文件独立保存在 <code>adb-tools/apk-center/keystores/</code>。删除后不可恢复；密码不会写入磁盘。</p><div class="artifact-list keystore-manager-list" id="keystoreFileList"></div>';
}
async function openKeystoreManager(){
  openFeatureModal('keystore-manager', '管理签名文件', keystoreManagerContent(), {hideFooter:true});
  await loadKeystoreFiles();
}

async function uninstallProcess(packageName, confirmed){
  if (!confirmed && !confirm("确认卸载设备应用 “" + packageName + "”？这会删除应用及其设备端数据，操作不可恢复。")) return;
  try {
    const result = await api("/api/processes/uninstall", {method:"POST", body:JSON.stringify(withAdbSerial({package:packageName, confirmed:Boolean(confirmed)}))});
    if (result.requires_confirmation) return uninstallProcess(packageName, true);
    toast(result.ok ? "已卸载：" + packageName : "卸载失败：" + result.output, !result.ok);
    loadProcesses();
  } catch(error) { toast(error.message, true); }
}
async function restartAdbServer(){
  const button = $("#restartAdbButton");
  if (button) { button.disabled = true; button.textContent = "重启中…"; }
  try {
    const result = await api("/api/adb/restart");
    toast(result.ok ? "ADB 服务已重启，已重新读取设备列表" : "ADB 重启失败：" + (result.devices_output || result.kill_output), !result.ok);
    await refreshAll();
  } catch(error) { toast(error.message, true); }
  finally { if (button) { button.disabled = false; button.textContent = "重启 ADB"; } }
}
async function forceKillAdb(){
  if(!confirm('确认执行 pkill -9 -x adb？\n\n这会强制终止本机所有进程名为 adb 的进程，并中断 USB、无线 ADB、Logcat 和正在执行的 ADB 操作。'))return;
  if(state.logs)stopLogs();
  const button=$('#forceKillAdbButton');button.disabled=true;button.textContent='强杀中…';
  try{const result=await api('/api/adb/force-kill',{method:'POST',body:'{}'});toast(result.message);setTimeout(refreshAll,800)}catch(error){toast(error.message,true)}finally{button.disabled=false;button.textContent='强杀 ADB'}
}
const wirelessAdbStorageKey='glacien.adb.wireless';
function recentWirelessAdb(){try{const value=JSON.parse(localStorage.getItem(wirelessAdbStorageKey)||'{}');return value&&typeof value==='object'?value:{}}catch(error){return {}}}
function wirelessSuggestionLabel(source){return {connected_wireless:'当前已连接的无线 ADB',usb_device_wifi:'当前 USB 设备的 wlan0',wifi_gateway:'当前 Wi-Fi 默认网关',adb_history:'ADB 历史无线地址',recent:'最近成功连接'}[source]||'未自动识别到车机 IP'}
async function openWirelessAdb(){
  openFeatureModal('wireless-adb','无线 ADB 连接','<div class="wireless-adb-loading">正在识别无线地址…</div>',{hideFooter:true});
  try{const suggestion=await api('/api/adb/wireless-suggestion?serial='+encodeURIComponent(selectedAdbSerial())),recent=recentWirelessAdb();if(!suggestion.ip&&recent.ip){suggestion.ip=recent.ip;suggestion.port=recent.port||5555;suggestion.source='recent'}renderWirelessAdbForm(suggestion);scanWirelessAdb()}catch(error){renderWirelessAdbForm({ip:recentWirelessAdb().ip||'',port:recentWirelessAdb().port||5555,source:'none',can_enable_tcpip:false,usb_serial:'',subnet_hint:''});toast(error.message,true)}
}
function renderWirelessAdbForm(suggestion){
  const root=document.createElement('div');root.className='wireless-adb-form';
  const hint=document.createElement('p');hint.className='page-description';hint.textContent='优先通过 ADB/mDNS 发现设备，并扫描当前 /24 网段的指定端口。路由器开启客户端隔离时无法发现其他终端。';
  const discovery=document.createElement('section');discovery.className='wireless-adb-discovery';discovery.innerHTML='<div class="wireless-adb-heading"><div><b>发现的设备</b><span id="wirelessAdbScanStatus">等待扫描</span></div><div><button class="button subtle" id="wirelessAdbCleanupButton" type="button" onclick="cleanupWirelessAdb()">清理离线连接</button><button class="button primary" id="wirelessAdbScanButton" type="button" onclick="scanWirelessAdb()">扫描设备</button></div></div><div class="wireless-adb-list" id="wirelessAdbList"><div class="wireless-adb-empty">正在扫描当前网络…</div></div>';
  const fields=document.createElement('div');fields.className='wireless-adb-fields';fields.innerHTML='<label><span>车机 IPv4 地址</span><input id="wirelessAdbIp" inputmode="decimal" placeholder="例如：192.168.1.100"></label><label><span>端口</span><input id="wirelessAdbPort" type="number" min="1" max="65535" value="5555"></label>';
  const details=document.createElement('div');details.className='wireless-adb-details';details.innerHTML='<span>地址来源：<b>'+escapeHtml(wirelessSuggestionLabel(suggestion.source))+'</b></span>'+(suggestion.host_ipv4?'<span>电脑地址：<code>'+escapeHtml(suggestion.host_ipv4)+'</code></span>':'')+(suggestion.gateway_ipv4?'<span>默认网关：<code>'+escapeHtml(suggestion.gateway_ipv4)+'</code>'+(suggestion.gateway_interface?' · '+escapeHtml(suggestion.gateway_interface):'')+'</span>':'')+(suggestion.subnet_hint?'<span>电脑当前网段：<code>'+escapeHtml(suggestion.subnet_hint)+'</code></span>':'')+(suggestion.usb_serial?'<span>USB 设备：<code>'+escapeHtml(suggestion.usb_serial)+'</code></span>':'');
  const enable=document.createElement('label');enable.className='wireless-adb-tcpip';enable.innerHTML='<input id="wirelessAdbEnableTcpip" type="checkbox"> 先让当前 USB 设备监听此 TCP 端口';enable.hidden=!suggestion.can_enable_tcpip;if(suggestion.can_enable_tcpip)enable.querySelector('input').checked=suggestion.source==='usb_device_wifi';
  const actions=document.createElement('div');actions.className='wireless-adb-actions';actions.innerHTML='<button class="button subtle" type="button" onclick="closeFeatureConfig()">取消</button><button class="button primary" id="wirelessAdbConnectButton" type="button" onclick="connectWirelessAdb()">连接</button>';
  root.append(hint,discovery,fields,details,enable,actions);$('#configModalBody').replaceChildren(root);$('#wirelessAdbIp').value=suggestion.ip||'';$('#wirelessAdbPort').value=suggestion.port||5555;root.dataset.usbSerial=suggestion.usb_serial||'';
}
function wirelessSourceLabel(source){return {connected:'已连接',mdns:'mDNS',gateway:'默认网关',subnet:'局域网扫描'}[source]||source}
function renderWirelessAdbDevices(result){
  const list=$('#wirelessAdbList'),status=$('#wirelessAdbScanStatus');if(!list||!status)return;
  status.textContent=result.message+(result.cleaned_offline?.length?` · 已清理 ${result.cleaned_offline.length} 个离线项`:'');
  list.replaceChildren();
  if(!(result.devices||[]).length){const empty=document.createElement('div');empty.className='wireless-adb-empty';empty.textContent='未发现设备。请确认设备已开启网络 ADB；若连接第三方 Wi-Fi，请检查客户端隔离。';list.append(empty);return}
  for(const item of result.devices){
    const row=document.createElement('div');row.className='wireless-adb-device';
    const copy=document.createElement('div');copy.className='wireless-adb-device-copy';copy.innerHTML=`<b>${escapeHtml(item.model||item.serial)}</b><code>${escapeHtml(item.serial)}</code><small>${escapeHtml((item.sources||[]).map(wirelessSourceLabel).join(' · '))}</small>`;
    const action=document.createElement('button');action.type='button';action.className=item.state==='device'?'button danger':'button subtle';action.textContent=item.state==='device'?'断开':'连接';action.onclick=()=>item.state==='device'?disconnectWirelessAdb(item.ip,item.port,action):connectWirelessCandidate(item.ip,item.port);
    row.append(copy,action);list.append(row);
  }
}
async function scanWirelessAdb(){
  const button=$('#wirelessAdbScanButton'),status=$('#wirelessAdbScanStatus'),port=Number($('#wirelessAdbPort')?.value||5555);if(!button)return;
  button.disabled=true;button.textContent='扫描中…';if(status)status.textContent='正在检查 mDNS、默认网关和当前 /24 网段…';
  try{renderWirelessAdbDevices(await api('/api/adb/wireless-scan',{method:'POST',body:JSON.stringify({port})}))}catch(error){if(status)status.textContent=error.message;toast(error.message,true)}finally{if(button.isConnected){button.disabled=false;button.textContent='扫描设备'}}
}
function connectWirelessCandidate(ip,port){$('#wirelessAdbIp').value=ip;$('#wirelessAdbPort').value=port;connectWirelessAdb()}
async function cleanupWirelessAdb(){
  const button=$('#wirelessAdbCleanupButton');button.disabled=true;button.textContent='清理中…';
  try{const result=await api('/api/adb/wireless-cleanup',{method:'POST',body:'{}'});toast(result.message);await scanWirelessAdb();await refreshStatus()}catch(error){toast(error.message,true)}finally{if(button.isConnected){button.disabled=false;button.textContent='清理离线连接'}}
}
async function disconnectWirelessAdb(ip,port,button){
  const serial=`${ip}:${port}`;button.disabled=true;button.textContent='断开中…';
  try{const result=await api('/api/adb/wireless-disconnect',{method:'POST',body:JSON.stringify({ip,port})});if(state.adbSerial===serial){state.adbSerial='';localStorage.removeItem('glacien.adb.serial')}const recent=recentWirelessAdb();if(`${recent.ip}:${recent.port||5555}`===serial)localStorage.removeItem(wirelessAdbStorageKey);toast(result.message);await scanWirelessAdb();await refreshStatus()}catch(error){toast(error.message,true)}finally{if(button.isConnected){button.disabled=false;button.textContent='断开'}}
}
async function connectWirelessAdb(){
  const ip=$('#wirelessAdbIp').value.trim(),port=Number($('#wirelessAdbPort').value),enable=Boolean($('#wirelessAdbEnableTcpip')?.checked),button=$('#wirelessAdbConnectButton'),usbSerial=$('.wireless-adb-form')?.dataset.usbSerial||'';if(!ip)return toast('请输入车机 IPv4 地址',true);if(!Number.isInteger(port)||port<1||port>65535)return toast('端口必须是 1-65535 的整数',true);
  button.disabled=true;button.textContent='连接中（必要时恢复 ADB）…';
  try{const result=await api('/api/adb/connect',{method:'POST',body:JSON.stringify({ip,port,enable_tcpip:enable,usb_serial:usbSerial})});localStorage.setItem(wirelessAdbStorageKey,JSON.stringify({ip,port}));state.adbSerial=result.serial;localStorage.setItem('glacien.adb.serial',result.serial);await refreshAll();toast((result.recovered?'本机 ADB 服务已恢复，':'')+(result.message||('已连接 '+result.serial)));await scanWirelessAdb()}catch(error){toast(error.message,true)}finally{if(button.isConnected){button.disabled=false;button.textContent='连接'}}
}
function ensureAdbRestartButton(){
  const actions = $("#adb-overview .hero-actions");
  if (!actions || $("#restartAdbButton")) return;
  const button = document.createElement("button");
  button.id = "restartAdbButton"; button.className = "button subtle"; button.textContent = "重启 ADB"; button.onclick = restartAdbServer;
  actions.append(button);
}
ensureAdbRestartButton();
function ensureForceKillAdbButton(){const actions=$('#adb-overview .hero-actions');if(!actions||$('#forceKillAdbButton'))return;const button=document.createElement('button');button.id='forceKillAdbButton';button.className='button danger';button.textContent='强杀 ADB';button.title='执行 pkill -9 -x adb';button.onclick=forceKillAdb;actions.append(button)}
ensureForceKillAdbButton();
function ensureWirelessAdbButton(){const actions=$('#adb-overview .hero-actions');if(!actions||$('#wirelessAdbButton'))return;const button=document.createElement('button');button.id='wirelessAdbButton';button.className='button subtle';button.textContent='无线 ADB';button.onclick=openWirelessAdb;actions.append(button)}
ensureWirelessAdbButton();

// 进程行直接展示与系统签名的比对结果，摘要仅作辅助信息，避免用户误解。
loadProcesses = async function(){
  const list = $("#processList");
  list.innerHTML = '<div class="process-row">正在读取设备进程…</div>';
  try {
    const items = await api("/api/processes?serial=" + encodeURIComponent(selectedAdbSerial()));
    if (!items.length) { list.innerHTML = '<div class="process-row">当前关键字没有匹配到任何包名。</div>'; return; }
    list.innerHTML = "";
    items.forEach(function(item){
      const row = document.createElement("div"); row.className = "process-row";
      const dot = document.createElement("i"); dot.className = "process-dot" + (item.running ? " running" : "");
      const main = document.createElement("span"); main.className = "process-main";
      const name = document.createElement("b"); name.textContent = item.package;
      const meta = document.createElement("span"); meta.textContent = item.pid ? "PID " + item.pid : "未运行";
      const signature = document.createElement("span");
      const signatureStates = {platform:"匹配", non_platform:"不匹配", unknown:"未知"};
      const status = signatureStates[item.signature_status] || "未知";
      signature.className = "process-signature " + (item.signature_status || "unknown");
      signature.textContent = "系统签名：" + status + (item.signature ? "（摘要 " + item.signature.slice(0, 12) + "…）" : "");
      const certificate = document.createElement("span"); certificate.className = "process-sha256 process-cert-sha256"; certificate.textContent = "签名证书 SHA-256：尚未计算";
      main.append(name, meta, signature, certificate);
      const state = document.createElement("span"); state.className = "process-state" + (item.running ? " running" : ""); state.textContent = item.running ? "RUNNING" : "STOPPED";
      const configButton = document.createElement("button"); configButton.className = "button subtle config-launch-button"; configButton.textContent = "配置拉起"; configButton.onclick = function(){ openProcessLaunchConfig(item.package); };
      const launch = document.createElement("button"); launch.className = item.launch_configured ? "button subtle" : "button disabled-action"; launch.textContent = item.launch_configured ? "拉起" : "未配置入口"; launch.disabled = !item.launch_configured; if (item.launch_configured) launch.onclick = function(){ launchProcess(item.package); };
      const stop = document.createElement("button"); stop.className = item.running ? "button danger" : "button disabled-action"; stop.textContent = item.running ? "停止" : "未启动"; stop.disabled = !item.running; if (item.running) stop.onclick = function(){ stopProcess(item.package); };
      const certDigest = document.createElement("button"); certDigest.className = "button subtle process-cert-sha256-button"; certDigest.textContent = "证书 SHA-256"; certDigest.onclick = function(){ calculateProcessCertificateSha256(item.package, certDigest, certificate); };
      const uninstall = document.createElement("button"); uninstall.className = "button danger uninstall-process-button"; uninstall.textContent = "卸载"; uninstall.onclick = function(){ uninstallProcess(item.package); };
      row.append(dot, main, state, configButton, launch, stop, certDigest, uninstall); list.append(row);
    });
  } catch(error) { list.innerHTML = '<div class="process-row">' + escapeHtml(error.message) + "</div>"; }
};
async function calculateProcessCertificateSha256(packageName,button,status){button.disabled=true;button.textContent='验签中…';status.textContent='签名证书 SHA-256：正在临时 Pull base.apk 并验签…';try{const result=await api('/api/processes/cert-sha256',{method:'POST',body:JSON.stringify(withAdbSerial({package:packageName}))});const text=certificateResultText(result.certificates);status.textContent=result.certificates.length===1?`签名证书 SHA-256：${result.certificates[0].sha256}`:`签名证书 SHA-256：${result.certificates.length} 个 signer`;button.disabled=false;button.textContent='证书 SHA-256';showCertificateSha256Result(packageName,result.certificates,result.apk_path,result.warning);const copied=await copyCertificateText(text);toast(copied?`签名证书 SHA-256 已计算并复制到剪贴板：${packageName}`:`签名证书 SHA-256 已计算，但自动复制失败：${packageName}`,!copied)}catch(error){status.textContent='签名证书 SHA-256：计算失败';toast(error.message,true)}finally{button.disabled=false;button.textContent='证书 SHA-256'}}

// 自定义命令执行态：临时输入与已保存命令严格互斥，不能再把模板复制到临时框。
function selectedCommandV3(){
  return state.command.loadedName ? adbCommandPresets()[state.command.loadedName] || null : null;
}
testCommandTemplateV2 = function(){
  const command = selectedCommandV3();
  return command ? String(command.command || '').trim() : ($('#adbTestCommand')?.value.trim() || '');
};
testCommandVariablesV2 = function(){
  return Object.fromEntries($$('#adbTestVariables input').map(function(input){ return [input.dataset.name, input.value.trim()]; }));
};
renderAdbTestVariablesV2 = function(){
  const panel = $('#adbTestVariables'), command = selectedCommandV3();
  if (!panel) return;
  if (!command) { panel.innerHTML = ''; panel.dataset.signature = ''; panel.hidden = true; return; }
  const names = commandTemplateVariables(command.command || '');
  const signature = state.command.loadedName + '|' + names.join('|');
  if (panel.dataset.signature === signature) return;
  panel.dataset.signature = signature;
  panel.hidden = !names.length;
  panel.innerHTML = names.length ? names.map(function(name){
    return '<label><span>变量：' + escapeHtml(name) + '</span><input data-name="' + escapeHtml(name) + '" placeholder="输入 ' + escapeHtml(name) + '"></label>';
  }).join('') : '';
  panel.querySelectorAll('input').forEach(function(input){ input.addEventListener('input', refreshAdbTestPreviewV2); });
};
refreshAdbTestPreviewV2 = function(){
  renderAdbTestVariablesV2();
  const preview = $('#adbTestPreview');
  if (preview) preview.textContent = 'adb shell sh -c ' + (testCommandTemplateV2() || '<命令>');
};
refreshAdbTestPreview = refreshAdbTestPreviewV2;
function refreshCommandExecutionModeV3(){
  const command = selectedCommandV3();
  const temporary = $('#adbTemporaryCommandPanel'), saved = $('#adbSavedCommandPanel');
  if (temporary) temporary.hidden = Boolean(command);
  if (saved) saved.hidden = !command;
  if ($('#adbSelectedCommandName')) $('#adbSelectedCommandName').textContent = command ? state.command.loadedName : '';
  if ($('#adbSelectedCommandDescription')) $('#adbSelectedCommandDescription').textContent = command ? (command.description || '未填写说明') : '';
  renderAdbTestVariablesV2();
  refreshAdbTestPreviewV2();
}
useTemporaryCommand = function(){
  state.command.loadedName = '';
  const variables = $('#adbTestVariables');
  if (variables) { variables.dataset.signature = ''; variables.innerHTML = ''; variables.hidden = true; }
  if ($('#adbCommandEdit')) $('#adbCommandEdit').disabled = true;
  refreshCommandExecutionModeV3();
  renderAdbCommandTree();
  $('#adbTestCommand')?.focus();
};
loadAdbCommandByName = function(name){
  if (!adbCommandPresets()[name]) return toast('命令不存在或已被删除', true);
  state.command.loadedName = name;
  const variables = $('#adbTestVariables');
  if (variables) { variables.dataset.signature = ''; variables.innerHTML = ''; variables.hidden = true; }
  refreshCommandExecutionModeV3();
  renderAdbCommandTree();
  if (state.featureConfigKind === 'command-picker') closeFeatureConfig();
  toast('已选择命令“' + name + '”');
  return true;
};
renderAdbCommandTree = function(){
  const command = selectedCommandV3(), status = $('#adbCommandLibraryStatus'), edit = $('#adbCommandEdit');
  if (status) status.textContent = command ? '当前：' + state.command.loadedName + ' · ' + (command.description || '未填写说明') : '当前处于临时输入';
  if (edit) edit.disabled = !command;
  renderAdbCommandPicker();
};
refreshAdbCommandPresets = function(selected){
  if (selected && Object.prototype.hasOwnProperty.call(adbCommandPresets(), selected)) state.command.loadedName = selected;
  if (state.command.loadedName && !selectedCommandV3()) state.command.loadedName = '';
  refreshCommandExecutionModeV3();
  renderAdbCommandTree();
};
saveAdbCommandPreset = async function(){
  const name = $('#adbCommandName') ? $('#adbCommandName').value.trim() : '', data = commandEditorDataV2(), previous = state.command.editingName || '';
  if (!name) return toast('请填写命令名称', true);
  if (!data.command) return toast('请填写设备端命令模板', true);
  if (previous && previous !== name && Object.prototype.hasOwnProperty.call(adbCommandPresets(), name) && !confirm('命令“' + name + '”已存在，确认覆盖它并将当前命令改名？')) return;
  const commands = Object.assign({}, adbCommandPresets(), {[name]:data});
  if (previous && previous !== name) delete commands[previous];
  state.config.adb_commands = commands;
  try {
    await api('/api/config', {method:'POST',body:JSON.stringify(state.config)});
    state.config = await api('/api/config');
    state.command.loadedName = name;
    state.command.editingName = name;
    state.command.baseline = commandEditorSignatureV2(data);
    const variables = $('#adbTestVariables');
    if (variables) { variables.dataset.signature = ''; variables.innerHTML = ''; variables.hidden = true; }
    closeFeatureConfig();
    refreshCommandExecutionModeV3();
    renderAdbCommandTree();
    toast(previous ? '命令“' + name + '”已更新' : '命令“' + name + '”已保存');
  } catch(error) { toast(error.message, true); }
};
deleteAdbCommandPreset = async function(){
  const name = state.command.editingName || state.command.loadedName;
  if (!name || !confirm('确认删除命令“' + name + '”？')) return;
  delete state.config.adb_commands[name];
  try {
    await api('/api/config', {method:'POST',body:JSON.stringify(state.config)});
    state.config = await api('/api/config');
    if (state.command.loadedName === name) state.command.loadedName = '';
    closeFeatureConfig();
    refreshCommandExecutionModeV3();
    renderAdbCommandTree();
    toast('已删除命令“' + name + '”');
  } catch(error) { toast(error.message, true); }
};
runAdbCommand = async function(confirmed){
  const command = selectedCommandV3(), template = testCommandTemplateV2();
  if (!template) return toast('请填写要执行的设备端命令', true);
  if (!command && commandTemplateVariables(template).length) return toast('临时输入不支持参数占位符；请直接填写完整命令，或保存后从命令库选择。', true);
  const button = $('#adbCommandRun');
  button.disabled = true; button.textContent = '执行中…';
  try {
    const result = await api('/api/adb-commands/run', {method:'POST',body:JSON.stringify(withAdbSerial({command:template,timeout_seconds:Number(command?.timeout_seconds) || 30,variables:testCommandVariablesV2(),confirmed:Boolean(confirmed)}))});
    if (result.requires_confirmation) {
      if (confirm('危险命令：' + result.command.join(' ') + '\n\n' + result.message + '。确认执行？')) return await runAdbCommand(true);
      return;
    }
    showAdbCommandResult(result);
    toast(result.ok ? '命令执行完成' : '命令执行失败：退出码 ' + result.exit_code, !result.ok);
  } catch(error) {
    $('#adbCommandResultMeta').textContent = '执行失败'; $('#adbCommandResult').textContent = error.message; $('#adbCommandResult').classList.add('error-result'); toast(error.message, true);
  } finally { button.disabled = false; button.textContent = '执行'; }
};
downloadAdbCommandResult = function(){
  const result = state.command.result;
  if (!result) return;
  const basis = state.command.loadedName || 'adb_command_result';
  const name = basis.replace(/[\\/:*?"<>|]+/g, '_') + '.txt';
  const url = URL.createObjectURL(new Blob([commandResultText(result)], {type:'text/plain;charset=utf-8'}));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
  toast('已下载命令结果：' + name);
};
$('#adbTestCommand')?.addEventListener('input', refreshAdbTestPreviewV3);
function refreshAdbTestPreviewV3(){ refreshAdbTestPreviewV2(); }
refreshCommandExecutionModeV3();

// 实时日志执行态：只允许已保存过滤方案，不能回退到无筛选“全部日志”。
function selectedSavedLogRule(){
  const name = $("#logPreset")?.value || "";
  return Object.prototype.hasOwnProperty.call(activeLogFilters(), name) ? name : "";
}
function updateLogRunState(){
  const name = selectedSavedLogRule(), button = $("#logToggle");
  if (button && !state.logs) button.disabled = !name;
  const exportButton = $("#logExportButton");
  if (exportButton) exportButton.disabled = !name;
  return name;
}
loadLogFilters = async function(){
  try {
    const filters = await api("/api/log-filters"), select = $("#logPreset"), previous = select.value;
    const names = Object.keys(filters).sort();
    select.innerHTML = '<option value="" disabled>选择已保存方案…</option>' + names.map(function(name){ return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>'; }).join("");
    select.value = Object.prototype.hasOwnProperty.call(filters, previous) ? previous : "";
    fillLogEditor(select.value);
    updateLogRunState();
  } catch(error) { toast(error.message, true); }
};
selectLogPreset = function(){
  if (state.logs) stopLogs();
  fillLogEditor(selectedSavedLogRule());
  updateLogRunState();
};
newLogPreset = function(){
  if (state.logs) stopLogs();
  $("#logPreset").value = "";
  fillLogEditor();
  updateLogRunState();
  $("#logRuleName").focus();
};
saveLogPreset = async function(){
  const name = $("#logRuleName").value.trim(), processName = $("#logProcessName")?.value.trim() || "", filters = updateLogFilterEditor();
  if (!name) return toast("请填写方案名称", true);
  if (processName && !/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(processName)) return toast("进程名格式无效，请填写完整进程名", true);
  if (!filters) return toast("请先修正过滤表达式", true);
  if (!filters.length) return toast("请至少填写一条过滤条件", true);
  const highlights = [];
  for (const input of document.querySelectorAll("#logRulePanel .color-input input")) {
    const colorTerms = words(input.value);
    if (colorTerms.length) highlights.push({terms: colorTerms, color: input.dataset.color});
  }
  if (state.logs) stopLogs();
  const savedRule = {filters, highlights};
  if (processName) savedRule.process_name = processName;
  state.config.log_filters = {...(state.config.log_filters || {}), [name]: savedRule};
  try {
    await api("/api/config", {method:"POST", body:JSON.stringify(state.config)});
    state.config = await api("/api/config");
    await loadLogFilters();
    $("#logPreset").value = name;
    fillLogEditor(name);
    updateLogRunState();
    $("#logStatus").textContent = "过滤方案已保存。选择它后即可开始监听。";
    toast("过滤方案“" + name + "”已保存");
  } catch(error) { toast(error.message, true); }
};
startLogs = async function(){
  const preset = selectedSavedLogRule();
  if (!preset) return toast("请先选择并保存过滤方案", true);
  const sessionId=(state.logSessionId||0)+1;state.logSessionId=sessionId;
  const button = $("#logToggle");
  button.disabled = true;
  button.textContent = "检查进程…";
  let target;
  try {
    target = await api("/api/log-process?preset=" + encodeURIComponent(preset) + "&serial=" + encodeURIComponent(selectedAdbSerial()));
  } catch(error) {
    if(sessionId!==state.logSessionId)return;
    button.textContent = "开始监听";
    updateLogRunState();
    $("#logStatus").textContent = error.message;
    return toast(error.message, true);
  }
  state.logCount = 0;
  $("#logOutput").innerHTML = '<span class="log-hint">正在连接过滤方案匹配的 adb logcat…</span>';
  $("#logStatus").textContent = "正在建立实时 Logcat 连接…";
  const source = new EventSource("/api/logs?preset=" + encodeURIComponent(preset) + "&serial=" + encodeURIComponent(selectedAdbSerial()));
  if(sessionId!==state.logSessionId){source.close();return;}
  state.logs = source;
  $("#logToggle").textContent = "停止监听";
  $("#logToggle").disabled = false;
  source.onopen = function(){if(sessionId!==state.logSessionId||state.logs!==source)return;$("#logStatus").textContent = "SSE 已连接，正在等待匹配的 Logcat 日志…"; };
  const processText = target.name ? " · 进程 " + target.name + "（PID " + target.pids.join("、") + "）" : "";
  source.addEventListener("ready", function(event){if(sessionId!==state.logSessionId||state.logs!==source)return;const detail=JSON.parse(event.data);state.logRule=detail.rule||{};const current=detail.process?.name?" · 进程 "+detail.process.name+"（PID "+detail.process.pids.join("、")+"）":processText;$("#logStatus").textContent="已连接过滤方案“"+preset+"”"+current+"，等待匹配日志。"; });
  source.onmessage = function(event){if(sessionId!==state.logSessionId||state.logs!==source)return;try { appendLog(JSON.parse(event.data)); state.logCount += 1; $("#logStatus").textContent = "过滤方案“" + preset + "”" + processText + "已接收 " + state.logCount + " 条匹配日志。"; } catch(error) { toast("日志渲染失败：" + error.message, true); } };
  source.onerror = function(){if(sessionId!==state.logSessionId||state.logs!==source)return;toast("Logcat 连接已断开", true);$("#logStatus").textContent = "连接中断。请确认设备在线后重新开始。";stopLogs();};
};
stopLogs = function(silent=false){
  state.logSessionId=(state.logSessionId||0)+1;
  if (state.logs) state.logs.close();
  state.logs = null;
  $("#logToggle").textContent = "开始监听";
  if (!silent&&$("#logStatus")) $("#logStatus").textContent = "已停止接收 Logcat。";
  updateLogRunState();
};
toggleLogs = function(){ state.logs ? stopLogs() : startLogs(); };
ensureLogExportButtons = function(){
  if ($("#logViewControls")) return;
  const controls = document.createElement("div");
  controls.id = "logViewControls"; controls.className = "log-view-controls";
  controls.innerHTML = '<label>字体 <input id="logFontSize" type="range" min="11" max="22" step="1" oninput="updateLogFontSize(this.value)"><b id="logFontSizeValue">13px</b></label><label>高亮背景 <input id="logHighlightOpacity" type="range" min="10" max="100" step="5" oninput="updateLogHighlightOpacity(this.value)"><b id="logHighlightOpacityValue">100%</b></label>';
  $("#logStatus").before(controls);
  applyLogViewSettings(); updateLogRunState();
};
function relocateRealtimeActionButtons(){
  const controls=$('#logViewControls'),start=$('#logToggle'),clearDisplay=$('#logDisplayClearButton'),clearDevice=$('#logDeviceClearButton');
  if(!controls)return;
  if(start&&start.parentElement!==controls)controls.appendChild(start);
  for(const [button,label] of [[clearDisplay,'清空显示'],[clearDevice,'清空日志']]){if(button&&button.parentElement!==controls){button.classList.remove('icon-button');button.classList.add('button','subtle','log-clear-button');button.textContent=label;controls.appendChild(button);}}
}
exportLogs = async function(){
  const preset = selectedSavedLogRule();
  if (!preset) return toast("请先选择已保存过滤方案", true);
  try { const result = await api("/api/logs/export", {method:"POST", body:JSON.stringify(withAdbSerial({preset}))}); toast("已保存 " + result.lines + " 行：" + result.path); } catch(error) { toast(error.message, true); }
};

// 实时日志过滤方案草稿保护。
const selectLogPresetWithDraftProtection = selectLogPreset;
selectLogPreset = function(){
  const next=$('#logPreset').value,previous=state.logPreset.loadedName;
  if(next!==previous&&!confirmDiscardLogRuleChanges('切换过滤方案')){$('#logPreset').value=previous;return;}
  selectLogPresetWithDraftProtection();
};
const newLogPresetWithDraftProtection = newLogPreset;
newLogPreset = function(){if(!confirmDiscardLogRuleChanges('新建过滤方案'))return;newLogPresetWithDraftProtection();};
const deleteLogPresetWithDraftProtection = deleteLogPreset;
deleteLogPreset = function(){if(!confirmDiscardLogRuleChanges('删除当前过滤方案'))return;return deleteLogPresetWithDraftProtection();};
loadLogFilters();

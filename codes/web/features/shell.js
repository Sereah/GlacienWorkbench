function pageMeta(id) { return ({ home:['WORKBENCH','首页'], 'adb-overview':['ADB WORKSPACE','ADB 概览'], apks:['DEPLOYMENT CENTER','部署中心'], processes:['APPLICATIONS & PROCESSES','应用与进程'], performance:['PERFORMANCE DIAGNOSTICS','性能诊断'], logs:['LOGCAT STREAM','实时日志'], 'offline-logs':['LOCAL FILE FILTER','离线日志分析'], 'audio-processing':['PCM AUDIO PLAYER','音频处理'], 'device-tools':['DEVICE UTILITIES','设备工具'], commands:['ADB COMMANDS','ADB 命令'], settings:['LOCAL CONFIGURATION','设置'] })[id]; }
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
    const tools=[{id:'logs',label:'日志Pull',page:'device-logs'},{id:'bugreport',label:'Bugreport采集',page:'bugreports'}];
    for(const tool of tools){
      const button=document.createElement('button');button.type='button';button.className='device-tool-tab';button.dataset.deviceToolTab=tool.id;button.textContent=tool.label;button.addEventListener('click',()=>selectDeviceToolTab(tool.id));deviceTabs.append(button);
      const panel=document.createElement('div');panel.id='device-tool-'+tool.id;panel.className='device-tool-panel';$('#device-tools').append(panel);moveStandalonePage(tool.page,panel);
    }
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
  if(id==='processes')selectAppManagerTab(state.appManager.tab||'apps');
  if(id==='logs')loadLogFilters();
  if(id==='device-tools')selectDeviceToolTab(state.deviceFiles.tab||'captures');
  if(id==='commands')selectAdbOperationTab(state.adbOperationTab||'commands');
  if(id==='settings')renderSettings();
  if(id==='audio-processing')loadAudioPage();
  if(id==='performance')loadPerformancePage();
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
  state.performance.applicationsLoaded = false;
  $('#performanceApplications')?.replaceChildren();
  state.adbSerial = serial; localStorage.setItem('glacien.adb.serial', serial);
  try { await refreshAll(); toast('已切换设备：' + serial); } catch (error) { toast(error.message, true); }
}
// 设备轮询只刷新状态；仅在“重新连接”边沿刷新页面，不能重建正在运行的日志 SSE。
async function monitorDevice(){try{const previous=state.deviceState;await refreshStatus();const current=$('#devicePill').classList.contains('online')?'online':'offline';state.deviceState=current;if(previous&&previous!==current){toast(current==='online'?'设备已连接，已刷新当前页面':'设备已断开连接',current!=='online');if(current==='online')await refreshAll();}}catch(e){/* 定时检查失败不打断页面操作 */}}

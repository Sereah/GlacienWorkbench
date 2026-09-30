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
const LOG_RENDER_BATCH_SIZE=250;
const LOG_RENDER_QUEUE_LIMIT=MAX_VISIBLE_LOG_LINES+LOG_RENDER_BATCH_SIZE;
function clearPendingRealtimeLogRender(){
  const render=state.logRender;
  if(render?.frameId)cancelAnimationFrame(render.frameId);
  if(render){render.lines=[];render.frameId=0;}
}
function discardRealtimeLogRender(){
  clearPendingRealtimeLogRender();
  state.logRender=null;
}
function beginRealtimeLogRender(sessionId,preset,processText){
  discardRealtimeLogRender();
  state.logRender={sessionId,preset,processText,lines:[],frameId:0,highlights:[]};
}
function scheduleRealtimeLogRender(){
  const render=state.logRender;
  if(!render||render.frameId)return;
  render.frameId=requestAnimationFrame(()=>flushRealtimeLogRender());
}
function enqueueRealtimeLog(line,sessionId){
  const render=state.logRender;
  if(!render||render.sessionId!==sessionId)return;
  render.lines.push(line);
  // 页面只展示最近日志；积压过多时保留最新内容，避免隐藏页面持续占用内存。
  if(render.lines.length>LOG_RENDER_QUEUE_LIMIT)render.lines.splice(0,render.lines.length-MAX_VISIBLE_LOG_LINES);
  scheduleRealtimeLogRender();
}
function flushRealtimeLogRender({drain=false,updateStatus=true}={}){
  const render=state.logRender;
  if(!render)return;
  if(render.frameId){cancelAnimationFrame(render.frameId);render.frameId=0;}
  const count=drain?render.lines.length:Math.min(LOG_RENDER_BATCH_SIZE,render.lines.length);
  appendLogBatch(render.lines.splice(0,count),render.highlights);
  if(updateStatus&&render.sessionId===state.logSessionId&&state.logs){
    $('#logStatus').textContent='过滤方案“'+render.preset+'”'+render.processText+'已接收 '+state.logCount+' 条匹配日志。';
  }
  if(render.lines.length)scheduleRealtimeLogRender();
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
  const name = $("#logRuleName").value.trim(), filters = updateLogFilterEditor();
  if (!name) return toast("请填写方案名称", true);
  if (!filters) return toast("请先修正过滤表达式", true);
  if (!filters.length) return toast("请至少填写一条过滤条件", true);
  const highlights = [];
  for (const input of document.querySelectorAll("#logRulePanel .color-input input")) {
    const colorTerms = words(input.value);
    if (colorTerms.length) highlights.push({terms: colorTerms, color: input.dataset.color});
  }
  if (state.logs) stopLogs();
  // 保留旧规则中的未知字段与 process_name；新进程筛选仅作为本次监听参数。
  const savedRule = {...(activeLogFilters()[name] || {}), filters, highlights};
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
  const processName = $("#logProcessName")?.value.trim() || "";
  if (processName && !/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(processName)) return toast("进程名格式无效，请填写完整进程名", true);
  const query = "preset=" + encodeURIComponent(preset) + "&serial=" + encodeURIComponent(selectedAdbSerial()) + "&process_override=1&process=" + encodeURIComponent(processName);
  const sessionId=(state.logSessionId||0)+1;state.logSessionId=sessionId;
  const button = $("#logToggle");
  button.disabled = true;
  button.textContent = "检查进程…";
  let target;
  try {
    target = await api("/api/log-process?" + query);
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
  const processText = target.name ? " · 进程 " + target.name + "（PID " + target.pids.join("、") + "）" : "";
  beginRealtimeLogRender(sessionId,preset,processText);
  const source = new EventSource("/api/logs?" + query);
  if(sessionId!==state.logSessionId){source.close();discardRealtimeLogRender();return;}
  state.logs = source;
  $("#logToggle").textContent = "停止监听";
  $("#logToggle").disabled = false;
  source.onopen = function(){if(sessionId!==state.logSessionId||state.logs!==source)return;$("#logStatus").textContent = "SSE 已连接，正在等待匹配的 Logcat 日志…"; };
  source.addEventListener("ready", function(event){if(sessionId!==state.logSessionId||state.logs!==source)return;const detail=JSON.parse(event.data);state.logRule=detail.rule||{};if(state.logRender?.sessionId===sessionId)state.logRender.highlights=preparedLogHighlights();const current=detail.process?.name?" · 进程 "+detail.process.name+"（PID "+detail.process.pids.join("、")+"）":processText;$("#logStatus").textContent="已连接过滤方案“"+preset+"”"+current+"，等待匹配日志。"; });
  source.onmessage = function(event){if(sessionId!==state.logSessionId||state.logs!==source)return;try { enqueueRealtimeLog(JSON.parse(event.data),sessionId); state.logCount += 1; } catch(error) { toast("日志渲染失败：" + error.message, true); } };
  source.onerror = function(){if(sessionId!==state.logSessionId||state.logs!==source)return;toast("Logcat 连接已断开", true);$("#logStatus").textContent = "连接中断。请确认设备在线后重新开始。";stopLogs();};
};
stopLogs = function(silent=false){
  if(silent)discardRealtimeLogRender();else flushRealtimeLogRender({drain:true,updateStatus:false});
  state.logSessionId=(state.logSessionId||0)+1;
  if (state.logs) state.logs.close();
  state.logs = null;
  discardRealtimeLogRender();
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
  const processName=$("#logProcessName")?.value.trim()||"";
  if(processName&&!/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(processName))return toast("进程名格式无效，请填写完整进程名",true);
  try { const result=await api("/api/logs/export", {method:"POST", body:JSON.stringify(withAdbSerial({preset,process_name:processName}))}); toast("已保存 " + result.lines + " 行：" + result.path); } catch(error) { toast(error.message, true); }
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

const ARTIFACT_REMOVE_DURATION_MS=180;
const EMPTY_APK_LIST='<div class="artifact-row"><span class="artifact-main"><b>没有找到 APK</b><span>请上传 APK 或从构建目录导入。</span></span></div>';
function artifactRowIndex(target){const value=Number(target?.closest('.artifact-row')?.dataset.index);return Number.isInteger(value)?value:-1;}
async function removeArtifactRow(row){
  if(!row)return;
  const list=row.parentElement;
  list?.classList.add('removing-item');
  if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){row.remove();list?.classList.remove('removing-item');return;}
  row.style.height=Math.ceil(row.getBoundingClientRect().height)+'px';
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  row.classList.add('removing');
  await new Promise(resolve=>{
    let finished=false;
    const complete=()=>{if(finished)return;finished=true;clearTimeout(timeout);row.removeEventListener('transitionend',onTransitionEnd);resolve();};
    const onTransitionEnd=event=>{if(event.target===row&&event.propertyName==='height')complete();};
    const timeout=setTimeout(complete,ARTIFACT_REMOVE_DURATION_MS+80);
    row.addEventListener('transitionend',onTransitionEnd);
  });
  row.remove();
  list?.classList.remove('removing-item');
}
function reindexApkRows(){
  $$('#apkList .artifact-row[data-index]').forEach((row,index)=>{
    row.dataset.index=String(index);
    const md5=row.querySelector('[data-apk-result="md5"]'),sha256=row.querySelector('[data-apk-result="sha256"]'),certificate=row.querySelector('[data-apk-result="certificate"]');
    if(md5)md5.id=`md5-${index}`;
    if(sha256)sha256.id=`sha256-${index}`;
    if(certificate)certificate.id=`cert-sha256-${index}`;
  });
}
const artifactListRequests={apk:0,sign:0,resource:0};
const artifactListSnapshots={sign:null};
function artifactListsEqual(current,next){return JSON.stringify(current)===JSON.stringify(next)}
function artifactListChanged(list,current,next){return list.dataset.loaded!=='true'||!artifactListsEqual(current,next)}
function artifactListSkeleton(message){return `<div class="artifact-list-skeleton" role="status" aria-label="${escapeHtml(message)}">${Array.from({length:3},()=>'<div class="artifact-skeleton-row"><i></i><span><i></i><i></i></span></div>').join('')}</div>`;}
function beginArtifactListRefresh(list,button,message){
  const hasContent=list.dataset.loaded==='true';
  list.classList.remove('refresh-complete');list.setAttribute('aria-busy','true');
  if(hasContent)list.classList.add('refreshing');else list.innerHTML=artifactListSkeleton(message);
  if(button){button.dataset.idleLabel=button.dataset.idleLabel||button.textContent;button.disabled=true;button.textContent='刷新中…';}
  return hasContent;
}
function finishArtifactListRefresh(list,button,success,animate=true){
  list.classList.remove('refreshing');list.setAttribute('aria-busy','false');
  if(success){list.dataset.loaded='true';if(animate){list.classList.add('refresh-complete');clearTimeout(list._refreshAnimationTimer);list._refreshAnimationTimer=setTimeout(()=>list.classList.remove('refresh-complete'),220);}}
  if(button){button.disabled=false;button.textContent=button.dataset.idleLabel||'刷新';}
}
function artifactRenameSpec(kind,index){
  const apk=kind==='apk',items=apk?state.apks:state.resources,item=items[index];
  if(!item)return null;
  return {kind,index,item,suffix:apk?'.apk':'.tar.gz',label:apk?'APK':'资源包',endpoint:apk?'/api/apks/rename':'/api/resources/rename',list:apk?'#apkList':'#resourceList'};
}
function openArtifactRename(kind,index){
  const spec=artifactRenameSpec(kind,index);if(!spec)return;
  state.artifactRename={kind,path:spec.item.path};
  openFeatureModal('artifact-rename',`重命名${spec.label}`,'',{hideFooter:true});
  const root=document.createElement('div');root.className='artifact-rename-form';
  const field=document.createElement('label'),title=document.createElement('span'),inputRow=document.createElement('div'),input=document.createElement('input'),suffix=document.createElement('code'),hint=document.createElement('small'),actions=document.createElement('div'),cancel=document.createElement('button'),save=document.createElement('button');
  field.className='feature-field';title.textContent='文件名称';input.id='artifactRenameInput';input.maxLength=240;input.value=spec.item.name.slice(0,-spec.suffix.length);suffix.textContent=spec.suffix;hint.textContent='扩展名由软件固定保留；不能覆盖已有同名文件。';inputRow.className='artifact-rename-input';inputRow.append(input,suffix);field.append(title,inputRow,hint);
  actions.className='artifact-rename-actions';cancel.type='button';cancel.className='button subtle';cancel.textContent='取消';cancel.onclick=closeFeatureConfig;save.type='button';save.className='button primary';save.id='artifactRenameSave';save.textContent='重命名';save.onclick=submitArtifactRename;actions.append(cancel,save);root.append(field,actions);$('#configModalBody').replaceChildren(root);
  input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();submitArtifactRename();}});input.focus();input.select();
}
function updateRenamedArtifactRow(spec,updated){
  const items=spec.kind==='apk'?state.apks:state.resources,currentIndex=items.findIndex(item=>item.path===spec.path);
  if(currentIndex<0)return null;
  const previous=items[currentIndex];items[currentIndex]={...previous,...updated};
  const rows=$$(`${spec.list} .artifact-row[data-index]`),row=rows.find(item=>item.querySelector('input.check')?.value===spec.path)||rows.find(item=>Number(item.dataset.index)===currentIndex);if(!row)return null;
  const name=row.querySelector('[data-artifact-name]'),checkbox=row.querySelector('input.check');
  if(name)name.textContent=updated.name;
  if(checkbox)checkbox.value=updated.path;
  if(spec.kind==='apk'){
    const tag=row.querySelector('[data-apk-signing]');
    if(tag)tag.textContent=updated.signed_with?`SIGNED: ${updated.signed_with}`:'未识别签名';
  }else{
    const paths=state.config.resource_device_paths||{},devicePath=paths[previous.name]||updated.device_path||'';
    delete paths[previous.name];if(devicePath)paths[updated.name]=devicePath;state.config.resource_device_paths=paths;
  }
  return row;
}
function highlightRenamedArtifact(listSelector,path){
  const row=$$(`${listSelector} .artifact-row[data-index]`).find(item=>item.querySelector('input.check')?.value===path);if(!row)return;
  row.classList.remove('renamed');requestAnimationFrame(()=>row.classList.add('renamed'));setTimeout(()=>row.classList.remove('renamed'),700);
}
async function submitArtifactRename(){
  const request=state.artifactRename,input=$('#artifactRenameInput'),button=$('#artifactRenameSave');if(!request||!input||!button)return;
  if(button.disabled)return;
  const items=request.kind==='apk'?state.apks:state.resources,index=items.findIndex(item=>item.path===request.path),spec=artifactRenameSpec(request.kind,index),name=input.value.trim();
  if(!spec)return toast('待重命名文件已不存在，请刷新列表',true);
  if(!name)return toast('请输入新的文件名称',true);
  button.disabled=true;button.textContent='重命名中…';
  try{
    const result=await api(spec.endpoint,{method:'POST',body:JSON.stringify({file:spec.item.path,name})});
    const row=updateRenamedArtifactRow(spec,result.file);closeFeatureConfig();toast(`已重命名为 ${result.file.name}`);
    const refreshed=spec.kind==='apk'?await loadApks(false):await loadResources(false);
    if(refreshed)highlightRenamedArtifact(spec.list,result.file.path);else if(row)highlightRenamedArtifact(spec.list,result.file.path);
  }catch(error){button.disabled=false;button.textContent='重命名';toast(error.message,true)}
}
async function loadApks(showLoading=true) {
  const list=$('#apkList'),button=$('#apkRefreshButton'),selected=new Set(selectedApks()),requestId=++artifactListRequests.apk,showProgress=showLoading||list.dataset.loaded!=='true',hadContent=showProgress?beginArtifactListRefresh(list,button,'正在扫描 APK 文件'):true;
  if(!showProgress)list.setAttribute('aria-busy','true');
  try {
    const apks=await api('/api/apks');if(requestId!==artifactListRequests.apk)return false;
    const changed=artifactListChanged(list,state.apks,apks);state.apks=apks;
    if(!changed){finishArtifactListRefresh(list,button,true,false);return true;}
    list.innerHTML = state.apks.length ? state.apks.map((apk, i) => `<div class="artifact-row" data-index="${i}"><input class="check apk-check" type="checkbox" value="${escapeHtml(apk.path)}" onchange="updateApkSelection()"><span class="file-icon">APK</span><span class="artifact-main"><b data-artifact-name>${escapeHtml(apk.name)}</b><span>${formatSize(apk.size)} · ${new Date(apk.modified).toLocaleString()}</span><span>包名：${escapeHtml(apk.package_name||'未识别')}</span><span class="checksum-value" data-apk-result="md5" id="md5-${i}">MD5：按“MD5”计算</span><span class="checksum-value" data-apk-result="sha256" id="sha256-${i}">文件 SHA-256：按“SHA-256”计算</span><span class="checksum-value" data-apk-result="certificate" id="cert-sha256-${i}">证书 SHA-256：按“证书 SHA-256”计算</span></span><span class="tag" data-apk-signing>${apk.signed_with?`SIGNED: ${escapeHtml(apk.signed_with)}`:'未识别签名'}</span><button class="row-action" onclick="showMd5(artifactRowIndex(this))">MD5</button><button class="row-action" onclick="showApkSha256(artifactRowIndex(this))">SHA-256</button><button class="row-action" onclick="showApkCertificateSha256(artifactRowIndex(this))">证书 SHA-256</button><button class="row-action" onclick="openApkPush(artifactRowIndex(this))">Push</button><button class="row-action" onclick="openArtifactRename('apk',artifactRowIndex(this))">重命名</button><button class="row-action danger-action" onclick="deleteApk(artifactRowIndex(this),this)">删除</button></div>`).join('') : EMPTY_APK_LIST;
    $$('#apkList .apk-check').forEach(input=>input.checked=selected.has(input.value));updateApkSelection();finishArtifactListRefresh(list,button,true,showLoading&&hadContent);return true;
  } catch (e) { if(requestId!==artifactListRequests.apk)return false;if(!hadContent)list.innerHTML = `<div class="artifact-row">${escapeHtml(e.message)}</div>`;else toast(`刷新 APK 列表失败：${e.message}`,true);finishArtifactListRefresh(list,button,false,false);return false; }
}
async function showMd5(index){const apk=state.apks[index],target=$(`#md5-${index}`);if(!apk||!target)return;target.textContent='MD5：计算中…';try{const r=await api('/api/apks/md5',{method:'POST',body:JSON.stringify({file:apk.path})});target.textContent=`MD5：${r.md5}`;await navigator.clipboard?.writeText(r.md5);toast(`MD5 已计算并复制到剪贴板：${apk.name}`)}catch(e){target.textContent='MD5：计算失败';toast(e.message,true)}}
async function showApkSha256(index){const apk=state.apks[index],target=$(`#sha256-${index}`);if(!apk||!target)return;target.textContent='文件 SHA-256：计算中…';try{const result=await api('/api/apks/sha256',{method:'POST',body:JSON.stringify({file:apk.path})});target.textContent=`文件 SHA-256：${result.sha256}`;await navigator.clipboard?.writeText(result.sha256);toast(`文件 SHA-256 已计算并复制到剪贴板：${apk.name}`)}catch(error){target.textContent='文件 SHA-256：计算失败';toast(error.message,true)}}
async function showApkCertificateSha256(index){const apk=state.apks[index],target=$(`#cert-sha256-${index}`);if(!apk||!target)return;target.textContent='证书 SHA-256：计算中…';try{const result=await api('/api/apks/cert-sha256',{method:'POST',body:JSON.stringify({file:apk.path})});const text=certificateResultText(result.certificates);target.textContent=result.certificates.length===1?`证书 SHA-256：${result.certificates[0].sha256}`:`证书 SHA-256：${result.certificates.length} 个 signer`;showCertificateSha256Result(apk.name,result.certificates,'',result.warning);const copied=await copyCertificateText(text);toast(copied?`证书 SHA-256 已计算并复制到剪贴板：${apk.name}`:`证书 SHA-256 已计算，但自动复制失败：${apk.name}`,!copied)}catch(error){target.textContent='证书 SHA-256：计算失败';toast(error.message,true)}}
function certificateResultText(certificates){return certificates.flatMap(item=>[`Signer #${item.signer}`,item.sha256,item.dn,'']).join('\n').trim()}
async function copyCertificateText(text){return copyTextToClipboard(text)}
function showCertificateSha256Result(title,certificates,path='',warning=''){openFeatureModal('certificate-sha256','签名证书 SHA-256：'+title,'',{hideFooter:true});const root=document.createElement('div');root.className='process-sha256-results certificate-sha256-results';const hint=document.createElement('p');hint.className='page-description';hint.textContent='这是 APK 签名证书指纹，不是 APK 文件摘要。';root.append(hint);if(warning){const notice=document.createElement('p');notice.className='notice warning';notice.textContent=warning;root.append(notice)}if(path){const source=document.createElement('small');source.className='certificate-apk-path';source.textContent='APK：'+path;root.append(source)}for(const item of certificates){const card=document.createElement('section'),name=document.createElement('b'),digest=document.createElement('code'),dn=document.createElement('small');name.textContent='Signer #'+item.signer;digest.textContent=item.sha256;dn.textContent=item.dn||'未提供证书 DN';card.append(name,digest,dn);root.append(card)}const copy=document.createElement('button');copy.type='button';copy.className='button primary certificate-copy-button';copy.textContent='复制结果';copy.onclick=async()=>{const copied=await copyCertificateText(certificateResultText(certificates));toast(copied?'证书 SHA-256 已复制到剪贴板':'复制失败，请手动选择摘要复制',!copied)};root.append(copy);$('#configModalBody').replaceChildren(root)}
async function deleteApk(index,button){
  const apk=state.apks[index];if(!apk||!confirm(`确认删除 APK？\n\n${apk.name}\n\n此操作不可恢复。`))return;
  const row=button?.closest('.artifact-row');if(button)button.disabled=true;
  try{
    await api('/api/apks/delete',{method:'POST',body:JSON.stringify({file:apk.path})});
    state.apks.splice(index,1);
    await removeArtifactRow(row);
    reindexApkRows();
    if(!state.apks.length)$('#apkList').innerHTML=EMPTY_APK_LIST;
    updateApkSelection();
    toast(`已删除 ${apk.name}`);
  }catch(e){if(button)button.disabled=false;toast(e.message,true)}
}

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
  const userHint=document.createElement('p');userHint.className='page-description';userHint.textContent='Push 只复制 APK 文件，不会改变任何 Android User 的应用安装状态。';root.append(userHint);
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

function apkInstallUserLabel(user){return `User ${user.user_id} · ${user.name}${user.current?' · 当前用户':''}${user.running?' · 运行中':' · 未运行'}`}
function selectedApkInstallUsers(){return $$('.apk-install-user:checked').map(input=>Number(input.value))}
function updateApkInstallSelection(){
  const users=$$('.apk-install-user'),selected=selectedApkInstallUsers(),all=$('#apkInstallAllUsers'),execute=$('#apkInstallExecute'),replace=$('#apkInstallReplace'),downgrade=$('#apkInstallDowngrade');
  if(all){all.checked=Boolean(users.length)&&selected.length===users.length;all.indeterminate=selected.length>0&&selected.length<users.length;}
  if(downgrade){downgrade.disabled=!replace?.checked;if(downgrade.disabled)downgrade.checked=false;}
  if(execute)execute.disabled=!selected.length;
}
function toggleAllApkInstallUsers(checked){$$('.apk-install-user').forEach(input=>input.checked=checked);updateApkInstallSelection()}
function apkInstallDialog(files,users){
  const names=files.map(path=>state.apks.find(item=>item.path===path)?.name||path);
  return `<div class="apk-install-dialog"><section><b>已选择 ${files.length} 个 APK</b><div class="apk-install-files">${names.map(name=>`<code>${escapeHtml(name)}</code>`).join('')}</div></section><section><header><div><b>目标 Android User</b><small>每次打开都从当前设备重新读取。</small></div><label><input id="apkInstallAllUsers" type="checkbox" onchange="toggleAllApkInstallUsers(this.checked)"> 全选</label></header><div class="apk-install-users">${users.map(user=>`<label><input class="apk-install-user" type="checkbox" value="${user.user_id}" ${user.current?'checked':''} onchange="updateApkInstallSelection()"><span><b>${escapeHtml(apkInstallUserLabel(user))}</b></span></label>`).join('')}</div></section><section><b>安装选项</b><div class="apk-install-options"><label><input id="apkInstallReplace" type="checkbox" checked onchange="updateApkInstallSelection()"> 允许覆盖已有应用并保留数据 <code>-r</code></label><label><input id="apkInstallDowngrade" type="checkbox"> 允许版本降级 <code>-d</code></label><label><input id="apkInstallGrant" type="checkbox"> 自动授予运行时权限 <code>-g</code></label><label><input id="apkInstallTestOnly" type="checkbox"> 允许安装测试 APK <code>-t</code></label></div></section><p class="safe-note">选择 User 控制应用在哪些用户下可用；APK 代码版本由设备共享，更新时可能影响其他已安装该包的 User。</p><div id="apkInstallResults"></div><div class="apk-install-actions"><button class="button subtle" type="button" onclick="closeFeatureConfig()">取消</button><button class="button primary" id="apkInstallExecute" type="button" onclick="executeApkInstall()">开始安装</button></div></div>`;
}
async function openApkInstall(){
  const files=selectedApks();if(!files.length)return;
  state.apkInstall={files,users:[]};openFeatureModal('apk-install','安装 APK','<div class="app-detail-loading"><div class="app-detail-loading-heading"><span class="app-detail-spinner"></span><b>正在读取设备 User…</b></div></div>',{hideFooter:true});
  try{const result=await api(apiPathWithSerial('/api/android-users'));if(state.featureConfigKind!=='apk-install')return;state.apkInstall.users=result.items||[];$('#configModalBody').innerHTML=apkInstallDialog(files,state.apkInstall.users);updateApkInstallSelection();}
  catch(error){if(state.featureConfigKind==='apk-install')$('#configModalBody').innerHTML=`<p class="user-guide-error">${escapeHtml(error.message)}</p>`;}
}
function renderApkInstallResults(results){
  const users=new Map((state.apkInstall?.users||[]).map(user=>[user.user_id,user]));
  return `<div class="apk-install-result-list">${results.map(item=>`<div class="apk-install-result ${item.ok?'success':'failed'}"><span>${item.ok?'✓':'!'}</span><div><b>${escapeHtml(item.file)} · ${escapeHtml(apkInstallUserLabel(users.get(item.user_id)||{user_id:item.user_id,name:'未知 User',current:false,running:false}))}</b><small>${escapeHtml(item.output||(item.ok?'安装完成':'安装失败'))}</small></div></div>`).join('')}</div>`;
}
async function executeApkInstall(){
  const button=$('#apkInstallExecute'),cancel=$('.apk-install-actions .button.subtle'),userIds=selectedApkInstallUsers();if(!button||!userIds.length)return;
  const options={replace:$('#apkInstallReplace').checked,downgrade:$('#apkInstallDowngrade').checked,grant_permissions:$('#apkInstallGrant').checked,test_only:$('#apkInstallTestOnly').checked};
  button.disabled=true;button.textContent='安装中…';if(cancel)cancel.disabled=true;$$('#configModalBody input').forEach(input=>input.disabled=true);
  try{const result=await api('/api/install',{method:'POST',body:JSON.stringify(withAdbSerial({files:state.apkInstall.files,user_ids:userIds,options}))});if(state.featureConfigKind!=='apk-install')return;$('#apkInstallResults').innerHTML=renderApkInstallResults(result.results||[]);const failed=(result.results||[]).filter(item=>!item.ok);button.textContent='重新安装';toast(failed.length?`${failed.length} 项安装失败`:`已完成 ${result.results.length} 项 User 安装`,Boolean(failed.length));}
  catch(error){toast(error.message,true);button.textContent='重试安装';}
  finally{if(state.featureConfigKind==='apk-install'){if(cancel)cancel.disabled=false;$$('#configModalBody input').forEach(input=>input.disabled=false);updateApkInstallSelection();}}
}

function switchApkTab(tab){state.apkTab=tab;document.querySelectorAll('.apk-tab').forEach(x=>x.classList.toggle('active',x.dataset.apkTab===tab));document.querySelectorAll('.apk-subpage').forEach(x=>x.classList.toggle('visible',x.id===`apk-tab-${tab}`));if(tab==='local')loadApks(false);if(tab==='sign')loadSignPage(false);if(tab==='resources')loadResources(false)}

async function loadSignPage(showLoading=true){
  const list=$('#signList'),button=$('#signRefreshButton'),selectedFiles=new Set(selectedSignApks()),select=$('#keystoreSelect'),selectedKeystore=select.value,requestId=++artifactListRequests.sign,showProgress=showLoading||list.dataset.loaded!=='true',hadContent=showProgress?beginArtifactListRefresh(list,button,'正在读取 APK 与签名文件'):true;
  if(!showProgress)list.setAttribute('aria-busy','true');
  try{
    const [apks,keys]=await Promise.all([api('/api/apks'),api('/api/keystores')]);
    if(requestId!==artifactListRequests.sign)return false;
    const snapshot={apks,keys},changed=artifactListChanged(list,artifactListSnapshots.sign,snapshot);artifactListSnapshots.sign=snapshot;
    if(!changed){finishArtifactListRefresh(list,button,true,false);return true;}
    select.innerHTML=keys.map(k=>`<option value="${escapeHtml(k.name)}" ${k.available?'':'disabled'}>${escapeHtml(k.name)}${k.available?'':'（文件不存在）'}</option>`).join('');
    if(keys.some(key=>key.name===selectedKeystore&&key.available))select.value=selectedKeystore;
    const selected=keys.find(k=>k.name===select.value);$('#keystoreHint').textContent=selected?'已选择受管签名文件；只有多 key 文件才需要填写 Alias。':'请先上传并选择签名文件。';
    list.innerHTML=apks.length?apks.map(apk=>`<label class="artifact-row"><input class="check sign-check" type="checkbox" value="${escapeHtml(apk.path)}" onchange="updateSignSelection()"><span class="file-icon">APK</span><span class="artifact-main"><b>${escapeHtml(apk.name)}</b><span>${formatSize(apk.size)} · ${new Date(apk.modified).toLocaleString()}</span><span>${apk.signed_with?`已由受管签名文件 “${escapeHtml(apk.signed_with)}”生成`:'未识别为本工具生成的签名输出'}</span></span><span class="tag">${apk.signed_with?`SIGNED: ${escapeHtml(apk.signed_with)}`:'SOURCE APK'}</span></label>`).join(''):'<div class="artifact-row">没有可签名的 APK。</div>';
    $$('#signList .sign-check').forEach(input=>input.checked=selectedFiles.has(input.value));updateSignSelection();finishArtifactListRefresh(list,button,true,showLoading&&hadContent);return true;
  }catch(e){if(requestId!==artifactListRequests.sign)return false;if(!hadContent)list.innerHTML=`<div class="artifact-row">${escapeHtml(e.message)}</div>`;else toast(`刷新签名 APK 列表失败：${e.message}`,true);finishArtifactListRefresh(list,button,false,false);return false;}
}
function selectedSignApks(){return [...document.querySelectorAll('.sign-check:checked')].map(x=>x.value)}
function updateSignSelection(){const n=selectedSignApks().length;$('#signSelection').textContent=n?`已选择 ${n} 个 APK`:'尚未选择 APK';$('#signButton').disabled=!n||!$('#keystoreSelect').value}
async function signSelected(){const files=selectedSignApks(),keystore=$('#keystoreSelect').value,storePassword=$('#storePassword').value,keyPassword=$('#keyPassword').value,alias=$('#keystoreAlias').value.trim();if(!files.length||!keystore)return;if(!storePassword||!keyPassword)return toast('请输入 Keystore 密码和私钥密码',true);const button=$('#signButton');button.disabled=true;button.textContent='签名中…';try{const r=await api('/api/apks/sign',{method:'POST',body:JSON.stringify({files,keystore,alias,store_password:storePassword,key_password:keyPassword})});const failed=r.results.filter(x=>!x.ok);toast(failed.length?`${failed.length} 项签名失败：${failed[0].output}`:`已签名 ${r.results.length} 个 APK`,!!failed.length);$('#storePassword').value='';$('#keyPassword').value='';loadSignPage();}catch(e){toast(e.message,true)}finally{button.textContent='签名所选项';button.disabled=false}}

function selectedResources(){return[...document.querySelectorAll('.resource-check:checked')].map(x=>x.value)}
function updateResourceSelection(){const n=selectedResources().length;const b=$('#pushResourcesButton');b.disabled=!n;b.textContent=n?`推送 ${n} 项`:'推送所选项'}

function updateProcessLaunchPreview(){const command=$('#launchCommand')?.value.trim()||'';const preview=$('#processLaunchPreview');if(preview)preview.textContent='adb shell '+(command||'<设备端拉起命令>')}
function openProcessLaunchConfig(packageName){const config=state.config.app_launches?.[packageName]||{};state.featureProcessPackage=packageName;openFeatureModal('process-launch',`配置拉起：${packageName}`,configInput('设备端拉起命令','launchCommand',config.command||'',`am start -n ${packageName}/.MainActivity`)+`<div class="launch-examples"><b>完整执行预览</b><pre><code id="processLaunchPreview"></code></pre><p>只填写 <code>adb shell</code> 后面的内容，支持 <code>am start</code> 或 <code>am start-activity</code>。参数值包含空格时请使用引号。</p></div>`);const footer=$('#configModal .config-dialog-footer');footer.hidden=false;footer.classList.add('process-launch-footer');footer.innerHTML=`${config.command?'<button class="button danger" onclick="deleteProcessLaunchConfig()">删除拉起配置</button>':''}<div class="config-footer-actions"><button class="button subtle" onclick="closeFeatureConfig()">取消</button><button class="button primary" onclick="saveFeatureConfig()">保存</button></div>`;$('#launchCommand').addEventListener('input',updateProcessLaunchPreview);updateProcessLaunchPreview();}
async function deleteProcessLaunchConfig(){const packageName=state.featureProcessPackage;if(!packageName)return;if(!state.config.app_launches?.[packageName])return closeFeatureConfig();if(!confirm(`确认删除 ${packageName} 的拉起配置？`))return;delete state.config.app_launches[packageName];await api('/api/config',{method:'POST',body:JSON.stringify(state.config)});state.config=await api('/api/config');closeFeatureConfig();loadProcesses(true);toast('拉起配置已删除')}

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
  const name=$('#logRuleName')?.value.trim()||'',raw=$('#logRuleTerms')?.value||'',highlights={};let filters=[],error='';
  if(raw.trim()){try{filters=parseLogFilterExpression(raw)}catch(exception){error=exception.message}}
  for(const input of document.querySelectorAll('#logRulePanel [data-color]')){const terms=words(input.value);if(terms.length)highlights[input.dataset.color]=terms;}
  return {name,filters,highlights,error,raw:error?raw:''};
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
  const editor=document.createElement('section');editor.id='logFilterEditor';editor.className='log-filter-builder log-filter-editor';editor.innerHTML='<header class="log-filter-builder-header log-filter-editor-header"><div><b>筛选条件</b><small>每条条件都必须满足；后加条件继续缩小结果</small></div><div class="log-filter-mode-tabs"><button class="log-filter-mode-button active" data-mode="basic" type="button">基础模式</button><button class="log-filter-mode-button" data-mode="expression" type="button">表达式模式</button></div></header><div id="logFilterBasicMode" class="log-filter-builder-body log-filter-basic"><div class="log-filter-basic-meta"><span class="log-filter-match-badge" id="logFilterKeywordCount">0 条条件</span><span id="logFilterBasicSummary">添加条件后即可保存方案</span></div><div id="realtimeFilterRows" class="log-condition-rows realtime-filter-rows"></div><button class="button subtle realtime-filter-add" type="button">＋ 添加条件</button></div><div id="logFilterExpressionMode" class="log-filter-builder-body log-filter-expression" hidden><label><span>QUERY</span></label><div class="log-filter-expression-help"><span><code>(a | b)</code> 包含任一</span><span><code>(a &amp; b)</code> 包含全部</span><span><code>!(a | b)</code> 排除任一</span><span>条件之间用 <code>&amp;</code></span></div><div class="log-filter-copy-actions"><button class="button subtle" type="button" onclick="copyLogFilterCommand(\'realtime\',\'grep\')">复制为 grep</button><button class="button subtle" type="button" onclick="copyLogFilterCommand(\'realtime\',\'rg\')">复制为 rg</button></div><p id="logFilterExpressionStatus" class="log-filter-expression-status"></p><p id="logFilterExpressionError" class="log-filter-expression-error" hidden></p></div>';
  ruleMain.append(editor);$('#logFilterExpressionMode label').append(terms);$$('.log-filter-mode-button').forEach(button=>button.onclick=()=>showLogFilterMode(button.dataset.mode));$('.realtime-filter-add').onclick=()=>addRealtimeFilter();
  const colors=$('.color-grid');if(colors&&!$('#logHighlightSection')){const section=createLogHighlightSection('logHighlightSection','高亮规则','可选：为日志内容中的任意字符串设置颜色',colors);colors.before(section);section.append(colors);}
  const actions=$('.rule-actions');if(actions&&!$('#logRuleDraftState')){const draft=document.createElement('span');draft.id='logRuleDraftState';draft.className='log-rule-draft-state';actions.prepend(draft);}name.addEventListener('input',refreshLogRuleState);$$('#logs [data-color]').forEach(input=>input.addEventListener('input',refreshLogRuleState));
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
function fillLogEditor(name=''){const rule=activeLogFilters()[name]||{},filters=normalizeRealtimeFilters(rule);$('#logRuleName').value=name;$('#logRuleTerms').value=filters.length?formatLogFilterExpression(filters):'';const grouped=Object.fromEntries(logColors.map(color=>[color,[]]));for(const group of rule.highlights||[]){if(grouped[group.color])grouped[group.color].push(...(group.terms||[]));}document.querySelectorAll('#logRulePanel .color-input input').forEach(input=>input.value=(grouped[input.dataset.color]||[]).join(', '));updateLogFilterEditor();setLogRuleBaseline(name);}
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
  clearPendingRealtimeLogRender();
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
const MAX_VISIBLE_LOG_LINES=1300;
function preparedLogHighlights(){return logHighlights().map(item=>({...item,term:String(item.term),lowerTerm:String(item.term).toLowerCase()}));}
function createLogLine(line,highlights){
  const text=String(line||''),lower=text.toLowerCase(),element=document.createElement('span');
  element.className=`log-line ${logSeverityClass(text)}`;
  let position=0;
  while(position<text.length){
    let hit=-1,chosen=null;
    for(const item of highlights){
      const index=lower.indexOf(item.lowerTerm,position);
      if(index!==-1&&(hit===-1||index<hit||(index===hit&&item.term.length>chosen.term.length))){hit=index;chosen=item;}
    }
    if(hit===-1){element.append(document.createTextNode(text.slice(position)));break;}
    if(hit>position)element.append(document.createTextNode(text.slice(position,hit)));
    const mark=document.createElement('mark');mark.className=`highlight-${chosen.color}`;mark.textContent=text.slice(hit,hit+chosen.term.length);element.append(mark);position=hit+chosen.term.length;
  }
  return element;
}
function appendLogBatch(lines,highlights=preparedLogHighlights()){
  if(!lines.length)return;
  const output=$('#logOutput'),fragment=document.createDocumentFragment();
  output.querySelector('.log-hint')?.remove();
  for(const line of lines.slice(-MAX_VISIBLE_LOG_LINES))fragment.append(createLogLine(line,highlights));
  output.append(fragment);
  while(output.childElementCount>MAX_VISIBLE_LOG_LINES)output.firstElementChild.remove();
  if(autoScrollEnabled())output.scrollTop=output.scrollHeight;
}
function appendLog(line){appendLogBatch([line]);}

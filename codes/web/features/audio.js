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

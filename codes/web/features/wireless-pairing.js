function wirelessPairingServiceRows(services) {
  if (!services.length) return '<div class="wireless-adb-empty">未发现配对服务，可手动填写设备显示的地址和端口。</div>';
  return services.map(item => `<button class="wireless-pairing-service" type="button" onclick="selectWirelessPairingService('${escapeHtml(item.ip)}',${item.port})"><b>${escapeHtml(item.name || 'Android 设备')}</b><code>${escapeHtml(item.endpoint)}</code></button>`).join('');
}

function renderWirelessPairing(status) {
  const form = $('.wireless-adb-form');
  if (!form || $('#wirelessPairingPanel')) return;
  const panel = document.createElement('section');
  panel.id = 'wirelessPairingPanel';
  panel.className = 'wireless-pairing-panel';
  panel.innerHTML = `
    <div class="wireless-pairing-heading"><div><b>Android 11+ 无线配对</b><small>${escapeHtml(status.message || '')}</small></div><button class="button subtle" type="button" onclick="refreshWirelessPairing()">刷新配对服务</button></div>
    <div class="wireless-pairing-services" id="wirelessPairingServices">${wirelessPairingServiceRows(status.pairing_services || [])}</div>
    <div class="wireless-pairing-fields">
      <label><span>设备 IPv4</span><input id="wirelessPairingIp" inputmode="decimal" placeholder="192.168.1.100"></label>
      <label><span>配对端口</span><input id="wirelessPairingPort" type="number" min="1" max="65535" placeholder="设备显示的端口"></label>
      <label><span>六位配对码</span><input id="wirelessPairingCode" type="password" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></label>
      <button class="button primary" id="wirelessPairButton" type="button" onclick="pairWirelessAdb()" ${status.supported ? '' : 'disabled'}>配对</button>
    </div>`;
  const discovery = form.querySelector('.wireless-adb-discovery');
  discovery.after(panel);
}

function selectWirelessPairingService(ip, port) {
  $('#wirelessPairingIp').value = ip;
  $('#wirelessPairingPort').value = String(port);
  $('#wirelessPairingCode').focus();
}

async function refreshWirelessPairing() {
  try {
    const status = await api('/api/adb/pairing-status');
    const list = $('#wirelessPairingServices');
    if (list) list.innerHTML = wirelessPairingServiceRows(status.pairing_services || []);
  } catch (error) { toast(error.message, true); }
}

async function pairWirelessAdb() {
  const ip = $('#wirelessPairingIp').value.trim();
  const port = Number($('#wirelessPairingPort').value);
  const pairingCode = $('#wirelessPairingCode').value.trim();
  const button = $('#wirelessPairButton');
  if (!ip || !Number.isInteger(port) || port < 1 || port > 65535) return toast('请输入设备显示的配对地址和端口', true);
  if (!/^\d{6}$/.test(pairingCode)) return toast('请输入六位无线配对码', true);
  button.disabled = true;
  button.textContent = '配对中…';
  try {
    const result = await api('/api/adb/pair', {method: 'POST', body: JSON.stringify({ip, port, pairing_code: pairingCode})});
    $('#wirelessPairingCode').value = '';
    toast(result.message || '无线配对成功');
    if ((result.connect_services || []).length === 1) {
      const target = result.connect_services[0];
      $('#wirelessAdbIp').value = target.ip;
      $('#wirelessAdbPort').value = String(target.port);
      toast('配对成功，已填入设备连接端口，请点击“连接”');
    }
    await scanWirelessAdb();
  } catch (error) {
    $('#wirelessPairingCode').value = '';
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '配对';
  }
}

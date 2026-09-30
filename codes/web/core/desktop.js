let desktopBridge = null;
function initializeDesktopBridge() {
  if (typeof QWebChannel === 'undefined' || !window.qt?.webChannelTransport) return;
  new QWebChannel(window.qt.webChannelTransport, channel => {
    desktopBridge = channel.objects.glacienDesktop || null;
    document.documentElement.classList.toggle('desktop-host', Boolean(desktopBridge));
  });
}
initializeDesktopBridge();

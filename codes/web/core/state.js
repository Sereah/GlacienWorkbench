// 跨页面共享状态；页面专属的临时状态应继续收敛到对应子对象。
const state = {
  config: null, apks: [], resources: [], logs: null, logRule: {}, logCount: 0, page: 'home',
  adbSerial: localStorage.getItem('glacien.adb.serial') || '', adbSelectionRequired: false,
  offline: {files: [], results: [], rendered: 0, skipped: 0, worker: null, scanning: false, totalBytes: 0, sources: []},
  audio: {files: [], selected: '', previewUrl: ''},
  deviceLogs: {sources: {}, files: [], result: null, pulling: false},
  captures: {screenshot: null, recording: null, recordingState: 'idle', scrcpyAvailable: false, timer: null, capability: 'screenshot', displays: [], continuous: null, compareItems: [], library: {kind: 'all', offset: 0, items: [], hasMore: false}},
  deviceFiles: {tab: 'captures', path: '/sdcard', parent: '', entries: [], loading: false, previewRequest: 0},
  appManager: {items: [], details: {}, kind: 'all', query: '', selected: '', tab: 'apps', serial: '', loaded: false},
  bugreports: {items: [], status: {state: 'idle'}, timer: null},
  performance: {status: {state: 'idle', samples: []}, timer: null, applicationsLoaded: false, sessions: [], selectedSessions: new Set()},
  modalStack: [],
  adbOperationTab: 'commands', offlinePreset: {loadedName: '', baseline: ''},
  logPreset: {loadedName: '', baseline: ''}, command: {loadedName: '', baseline: '', result: null},
};

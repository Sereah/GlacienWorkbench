/* 离线日志 Worker：分块扫描 File，避免将完整 runlog 常驻主线程内存。 */
let cancelled = false;

function termMatches(term, target) {
  const lower = term.toLowerCase();
  const parts = lower.split('*');
  if (parts.length === 1) return target.includes(lower);
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const idx = target.indexOf(part, pos);
    if (idx < 0) return false;
    if (i === 0 && !lower.startsWith('*') && idx !== 0) return false;
    pos = idx + part.length;
  }
  if (!lower.endsWith('*') && parts[parts.length - 1]) {
    const last = parts[parts.length - 1];
    if (!target.endsWith(last)) return false;
  }
  return true;
}

function matches(line, filters) {
  const target = line.toLowerCase();
  return filters.every((filter) => {
    if (filter.mode === 'include_all') return filter.terms.every((term) => termMatches(term, target));
    if (filter.mode === 'exclude_any') return !filter.terms.some((term) => termMatches(term, target));
    return filter.terms.some((term) => termMatches(term, target));
  });
}

async function scanFile(fileInfo, filters, progress) {
  const reader = fileInfo.file.stream().getReader();
  const decoder = new TextDecoder('utf-8');
  let prefix = new Uint8Array(0), remainder = '', lineNumber = 0, matchesBatch = [];
  const flush = () => {
    if (!matchesBatch.length) return;
    postMessage({ type: 'matches', matches: matchesBatch });
    matchesBatch = [];
  };
  try {
    while (!cancelled) {
      const { value, done } = await reader.read();
      if (done) break;
      progress.bytes += value.byteLength;
      if (prefix.length < 65536) {
        const merged = new Uint8Array(Math.min(65536, prefix.length + value.length));
        merged.set(prefix); merged.set(value.subarray(0, merged.length - prefix.length), prefix.length); prefix = merged;
        if (prefix.includes(0) || (prefix[0] === 0x1f && prefix[1] === 0x8b)) return { binary: true };
      }
      const text = decoder.decode(value, { stream: true });
      const lines = (remainder + text).split(/\r\n|\r|\n/);
      remainder = lines.pop();
      for (const line of lines) {
        lineNumber += 1;
        if (matches(line, filters)) {
          matchesBatch.push({ file: fileInfo.name, line: lineNumber, text: line });
          if (matchesBatch.length >= 500) flush();
        }
      }
      const now = Date.now();
      if (now - progress.lastUpdate > 200) {
        flush();
        postMessage({ type: 'progress', ...progress });
        progress.lastUpdate = now;
      }
    }
    const tail = decoder.decode();
    if (tail || remainder) {
      const line = remainder + tail;
      if (line) {
        lineNumber += 1;
        if (matches(line, filters)) matchesBatch.push({ file: fileInfo.name, line: lineNumber, text: line });
      }
    }
    flush();
    return { binary: false };
  } finally {
    if (cancelled) await reader.cancel();
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { cancelled = true; return; }
  if (data.type !== 'scan') return;
  cancelled = false;
  const progress = { filesDone: 0, filesTotal: data.files.length, bytes: 0, totalBytes: data.totalBytes, lastUpdate: Date.now() };
  let skipped = 0;
  try {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const files = [...data.files].sort((left, right) => collator.compare(left.name, right.name));
    for (const fileInfo of files) {
      if (cancelled) break;
      const result = await scanFile(fileInfo, data.filters, progress);
      if (result.binary) skipped += 1;
      progress.filesDone += 1;
      postMessage({ type: 'progress', ...progress, skipped });
    }
    postMessage({ type: cancelled ? 'cancelled' : 'done', ...progress, skipped });
  } catch (error) {
    postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};

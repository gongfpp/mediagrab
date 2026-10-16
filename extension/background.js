/**
 * MediaGrab service worker.
 *
 * Bridges the in-page / toolbar UI to the native messaging host, and owns the
 * small amount of job state that has to survive the service worker being torn
 * down (kept in chrome.storage.session).
 *
 * Every long operation is a *job* on the host side. The UI polls; this worker
 * advances the job through its phases, which is what keeps a slow probe from
 * dying together with an idle MV3 worker.
 */

const HOST_NAME = 'com.mass.mediagrab';
const ALARM_NAME = 'mg-poll';

/** Bump to force a one-off migration of existing installs. */
const SETTINGS_REV = 2;

const DEFAULT_SETTINGS = {
  // 'browser' hands the file to Chrome's own downloader, so progress shows up
  // in the download shelf and any download-manager extension can take over.
  // 'ytdlp' keeps everything in a detached background process, which is more
  // capable (HLS/DASH muxing) but has no OS-level progress surface.
  mode: 'browser',        // browser | ytdlp
  quality: 'best',
  outDir: '',
  cookies: 'chrome',
  allowPlaylist: false,
  revealOnFinish: true,
  notifyOnFinish: true,
  settingsRev: SETTINGS_REV,
};

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

async function getSettings() {
  const { settings: stored } = await chrome.storage.sync.get('settings');
  const merged = Object.assign({}, DEFAULT_SETTINGS, stored || {});

  // v2 migration: earlier builds defaulted to the yt-dlp background channel and
  // persisted that choice, so changing the default alone would never take
  // effect. Flip it once, then leave the user's own choice alone afterwards.
  if ((stored || {}).settingsRev !== SETTINGS_REV) {
    merged.mode = 'browser';
    merged.settingsRev = SETTINGS_REV;
    await chrome.storage.sync.set({ settings: merged });
  }
  return merged;
}

async function setSettings(patch) {
  const next = Object.assign(await getSettings(), patch || {});
  await chrome.storage.sync.set({ settings: next });
  return next;
}

// ---------------------------------------------------------------------------
// native host
// ---------------------------------------------------------------------------

function callHost(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(HOST_NAME, payload, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({
            ok: false,
            error: err.message || 'native host unreachable',
            hostUnavailable: true,
          });
        } else {
          resolve(response || { ok: false, error: 'empty response from host' });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: String(e), hostUnavailable: true });
    }
  });
}

// ---------------------------------------------------------------------------
// job registry (storage.session survives worker restarts)
// ---------------------------------------------------------------------------

async function readJobs() {
  const { jobs } = await chrome.storage.session.get('jobs');
  return jobs || {};
}

async function writeJobs(jobs) {
  await chrome.storage.session.set({ jobs });
}

async function trackJob(jobId, record) {
  const jobs = await readJobs();
  jobs[jobId] = record;
  await writeJobs(jobs);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
}

async function updateJob(jobId, patch) {
  const jobs = await readJobs();
  if (!jobs[jobId]) return null;
  jobs[jobId] = Object.assign(jobs[jobId], patch);
  await writeJobs(jobs);
  return jobs[jobId];
}

function baseName(title, ext, fallback) {
  const safe = (title || fallback || 'video')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[/\\:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${safe || 'video'}.${ext || 'mp4'}`;
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function startJob(msg) {
  const settings = await getSettings();
  const mode = msg.mode || settings.mode;
  const action = mode === 'browser' ? 'probe' : 'download';

  const response = await callHost({
    cmd: 'start',
    action,
    url: msg.url,
    title: msg.title || msg.url,
    pageUrl: msg.pageUrl || msg.url,
    mode,
    quality: msg.quality || settings.quality,
    outDir: msg.outDir || settings.outDir,
    cookies: settings.cookies,
    allowPlaylist: msg.allowPlaylist !== undefined ? msg.allowPlaylist : settings.allowPlaylist,
    filenameTemplate: msg.filenameTemplate || '',
  });

  if (!response.ok) return response;

  await trackJob(response.jobId, {
    jobId: response.jobId,
    mode,
    phase: mode === 'browser' ? 'probe' : 'download',
    title: msg.title || msg.url,
    url: msg.url,
    pageUrl: msg.pageUrl || msg.url,
    outDir: response.outDir,
    startedAt: Date.now(),
  });

  return response;
}

/**
 * Hand an already-resolved direct media URL straight to Chrome's downloader.
 *
 * No native host, no yt-dlp: the download appears in the download shelf with a
 * live progress bar, and a download-manager extension (Rayburst / Motrix,
 * DownThemAll, ...) gets the usual chance to take it over.
 */
async function startBrowserDirect(msg) {
  if (!msg || !/^https?:/i.test(msg.url || '')) {
    return { ok: false, error: '没有可用的直链地址' };
  }

  const jobId = `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = msg.filename || baseName(msg.title, msg.ext || 'mp4', msg.id);

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: msg.url,
      filename,
      saveAs: false,
    });
  } catch (e) {
    return { ok: false, error: `浏览器下载未能启动：${(e && e.message) || e}` };
  }

  await trackJob(jobId, {
    jobId,
    mode: 'browser',
    phase: 'browser',
    direct: true,
    downloadId,
    title: msg.title || msg.url,
    url: msg.url,
    pageUrl: msg.pageUrl || '',
    resolution: msg.resolution || '',
    totalBytes: msg.filesize || null,
    startedAt: Date.now(),
  });

  return { ok: true, jobId, downloadId, filename };
}

/** Metadata-only probe, used to preview a video before the user commits. */
async function probeJob(msg) {
  const settings = await getSettings();
  const response = await callHost({
    cmd: 'start',
    action: 'probe',
    url: msg.url,
    title: msg.title || msg.url,
    pageUrl: msg.pageUrl || msg.url,
    quality: msg.quality || settings.quality,
    cookies: settings.cookies,
  });
  if (!response.ok) return response;

  await trackJob(response.jobId, {
    jobId: response.jobId,
    mode: 'probe',
    phase: 'probe',
    title: msg.title || msg.url,
    url: msg.url,
    pageUrl: msg.pageUrl || msg.url,
    startedAt: Date.now(),
  });
  return response;
}

async function pollJob(jobId) {
  const jobs = await readJobs();
  const record = jobs[jobId];
  if (!record) return { ok: false, error: 'untracked job' };

  // Browser-direct jobs never reach the native host, so there is no host job
  // to poll; everything comes from chrome.downloads below.
  let status = { ok: true, state: 'running' };
  if (!record.direct) {
    status = await callHost({ cmd: 'status', jobId });
    if (!status.ok) return status;
    record.title = status.title || record.title;
    record.file = status.file || record.file;
  }

  // Browser mode runs in two stages: resolve with yt-dlp, then hand the
  // single-file URL to Chrome's own downloader.
  if (record.mode === 'browser' && record.phase === 'probe') {
    if (status.state === 'error') {
      record.phase = 'error';
      record.error = (status.errors && status.errors[0]) || '解析失败';
    } else if (status.state === 'done') {
      const best = (status.probe && status.probe.progressive || [])[0];
      if (!best || !best.directUrl) {
        record.phase = 'error';
        record.error = '该页面没有单文件直链（多为 HLS/DASH 分离流），请改用 yt-dlp 模式';
      } else {
        try {
          const downloadId = await chrome.downloads.download({
            url: best.directUrl,
            filename: baseName(status.probe.title || record.title, best.ext, status.probe.id),
            saveAs: false,
          });
          record.phase = 'browser';
          record.downloadId = downloadId;
          record.resolution = best.height ? `${best.width}x${best.height}` : '';
          record.totalBytes = best.filesize || null;
        } catch (e) {
          record.phase = 'error';
          record.error = `浏览器下载失败：${e.message || e}`;
        }
      }
    }
  } else if (record.mode === 'probe' && record.phase === 'probe') {
    // Metadata-only job: the payload the UI renders comes straight from the log.
    if (status.state === 'error') {
      record.phase = 'error';
      record.error = (status.errors && status.errors[0]) || '解析失败';
    } else if (status.state === 'done') {
      record.phase = 'done';
    }
  } else if (record.phase === 'download' && status.state !== 'running') {
    record.phase = status.state;
    if (status.state === 'error') {
      record.error = (status.errors && status.errors[0]) || '下载失败';
    }
  }

  if (record.phase === 'browser') {
    const [item] = await chrome.downloads.search({ id: record.downloadId });
    if (item) {
      record.bytesReceived = item.bytesReceived;
      record.totalBytes = item.totalBytes || record.totalBytes;
      record.percent = item.totalBytes
        ? Math.round((item.bytesReceived / item.totalBytes) * 1000) / 10
        : null;
      record.file = item.filename || record.file;
      if (item.state === 'complete') {
        record.phase = 'done';
      } else if (item.state === 'interrupted') {
        record.phase = 'error';
        record.error = item.error || '下载被中断';
      }
    }
  }

  jobs[jobId] = record;
  await writeJobs(jobs);

  if ((record.phase === 'done' || record.phase === 'error') && !record.notified) {
    record.notified = true;
    jobs[jobId] = record;
    await writeJobs(jobs);
    await maybeComplete(record);
  }

  return Object.assign({}, record, { host: status, ok: true });
}

async function maybeComplete(record) {
  const settings = await getSettings();
  const isProbeOnly = record.mode === 'probe';

  if (!isProbeOnly && record.phase === 'done') {
    // Browser-mode jobs land here too: chrome.downloads reports the absolute
    // path, so revealing it in Finder works the same way.
    if (settings.revealOnFinish && record.file) {
      await callHost({ cmd: 'reveal', path: record.file });
    }
    if (settings.notifyOnFinish) {
      chrome.notifications.create(`mg-${record.jobId}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '下载完成',
        message: (record.title || '').slice(0, 120),
        silent: true,
      });
    }
  } else if (!isProbeOnly && record.phase === 'error' && settings.notifyOnFinish) {
    chrome.notifications.create(`mg-${record.jobId}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '下载失败',
      message: (record.error || record.title || '').slice(0, 120),
      silent: true,
    });
  }

  const jobs = await readJobs();
  const stillActive = Object.values(jobs).some(
    (j) => j.phase !== 'done' && j.phase !== 'error',
  );
  if (!stillActive) await chrome.alarms.clear(ALARM_NAME);
}

async function cancelJob(jobId) {
  const jobs = await readJobs();
  const record = jobs[jobId];

  // Jobs owned by Chrome's downloader have no host process; cancelling the
  // download itself is the only thing that stops bytes moving.
  if (record && record.downloadId) {
    try {
      await chrome.downloads.cancel(record.downloadId);
    } catch (e) { /* already finished or removed */ }
    await updateJob(jobId, { phase: 'error', error: '已取消' });
    return { ok: true };
  }

  const response = await callHost({ cmd: 'cancel', jobId });
  await updateJob(jobId, { phase: 'error', error: '已取消' });
  return response;
}

async function listJobs() {
  const jobs = await readJobs();
  const tracked = Object.values(jobs).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const output = [];
  for (const record of tracked.slice(0, 20)) {
    output.push(await pollJob(record.jobId));
  }
  return { ok: true, jobs: output };
}

// ---------------------------------------------------------------------------
// network capture (webRequest)
//
// In-page hooks (window.fetch / XMLHttpRequest) and the page's own resource
// timeline only see requests made from the *main thread*. Some players —
// Telegram Web K among them — stream media from a Worker or Service Worker, so
// both of those channels come back empty and the blob: URL they publish is
// unresolvable from the main thread (`net::ERR_FILE_NOT_FOUND`).
//
// chrome.webRequest sits at the browser's network layer, so it observes every
// request for a tab regardless of which context issued it. That is the only
// channel a page cannot hide from. We keep a small per-tab ring of URLs and let
// the content script filter them.
// ---------------------------------------------------------------------------

/** Per-tab cap. Busy pages emit thousands of requests; only the tail matters. */
const NET_LOG_LIMIT = 600;

/**
 * 桶的两种归属：
 *
 *   t:<tabId>   —— 浏览器能归属到标签页的请求（页面自己发的）。只给这个标签页。
 *   o:<origin>  —— 归属不到标签页的请求（service worker、其它扩展，tabId = -1）。
 *                  按**发起方 origin** 归档，只合并给同源的页面。
 *
 * v1.3.8 之前这里是唯一的共享桶 `-1`，每个标签页查询时都把它整个合并进候选池。
 * 后果实测过：在 X 下完一个视频后，Telegram 页面把那条 video.twimg.com 的地址
 * 当成了自己页面的候选（日志 `候选: 1 · 同源 stream: 0`），点下载出来的是 X 的视频。
 * 结论：归属不明的请求宁可不给，也不给错 —— 跨站候选一律不进候选池。
 */
const TAB_PREFIX = 't:';
const ORIGIN_PREFIX = 'o:';

const tabKey = (tabId) => `${TAB_PREFIX}${tabId}`;
const originKey = (origin) => `${ORIGIN_PREFIX}${origin || ''}`;

/** "https://x.com/a" -> "https://x.com"；非 http(s) 或解析失败 -> ''。 */
function originOf(href) {
  if (!href) return '';
  try {
    const url = new URL(href);
    return /^https?:$/.test(url.protocol) ? url.origin : '';
  } catch (e) {
    return '';
  }
}

const NETLOG_STORAGE_KEY = 'mgNetLogV1';

/** 桶 key -> { urls: string[], seen: Set<string>, origin: string } */
const netLog = new Map();

/**
 * Total webRequest events ever seen. Zero after browsing means the listener
 * never fired — a completely different problem from "it fired but nothing
 * matched", and previously indistinguishable from the outside.
 */
let netEventsTotal = 0;

/**
 * Top-level registration failures. A throw here used to kill the service
 * worker *before* chrome.runtime.onMessage was registered, which made every
 * later call fail with no visible cause anywhere.
 */
const bootErrors = [];

function safeRegister(label, fn) {
  try {
    fn();
  } catch (e) {
    const message = `${label}: ${(e && e.message) || e}`;
    bootErrors.push(message);
    console.error('[MediaGrab] 注册失败 —', message);
  }
}

function rememberUrl(key, url, origin) {
  if (key == null) return;
  if (!/^https?:/i.test(url)) return;

  let bucket = netLog.get(key);
  if (!bucket) {
    bucket = { urls: [], seen: new Set(), origin: origin || '' };
    netLog.set(key, bucket);
  }
  // origin 只由主文档请求写入（见 webRequest 监听器）：子资源请求的 initiator
  // 可能是页面里某个跨源 iframe，拿它当桶的归属会把整个桶判成过期的。
  if (origin && !bucket.origin) bucket.origin = origin;

  if (bucket.seen.has(url)) {
    // Still being requested: move it back to the tail so a stream URL that is
    // fetched every few seconds never ages out behind static assets.
    const at = bucket.urls.indexOf(url);
    if (at !== -1) {
      bucket.urls.splice(at, 1);
      bucket.urls.push(url);
    }
    return;
  }

  bucket.seen.add(url);
  bucket.urls.push(url);

  if (bucket.urls.length > NET_LOG_LIMIT) {
    const dropped = bucket.urls.splice(0, bucket.urls.length - NET_LOG_LIMIT);
    for (const d of dropped) bucket.seen.delete(d);
  }
}

// --- persistence -----------------------------------------------------------
//
// An MV3 service worker is torn down after ~30s idle and every in-memory Map
// dies with it. chrome.storage.session keeps the capture alive across restarts
// so a query that arrives after a wake-up still sees the requests that
// happened before it. (session storage is in-memory on the browser side, so a
// once-per-second debounced write is cheap.)

let flushTimer = null;
let netLogReady = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNetLog();
  }, 1000);
}

async function flushNetLog() {
  if (!chrome.storage || !chrome.storage.session) return;
  const buckets = {};
  for (const [key, bucket] of netLog) {
    buckets[key] = { urls: bucket.urls.slice(-NET_LOG_LIMIT), origin: bucket.origin || '' };
  }
  try {
    await chrome.storage.session.set({
      [NETLOG_STORAGE_KEY]: { events: netEventsTotal, buckets },
    });
  } catch (e) { /* quota or unavailable — the in-memory log still works */ }
}

async function restoreNetLog() {
  if (!chrome.storage || !chrome.storage.session) return;
  let saved;
  try {
    saved = (await chrome.storage.session.get(NETLOG_STORAGE_KEY))[NETLOG_STORAGE_KEY];
  } catch (e) {
    return;
  }
  if (!saved) return;

  netEventsTotal = Math.max(netEventsTotal, saved.events || 0);

  for (const [rawKey, savedBucket] of Object.entries(saved.buckets || {})) {
    // v1.3.8 及以前存的是 URL 数组；v1.3.9 起是 { urls, origin }。两种都认，
    // 免得升级后第一次查询读到旧格式就整段丢掉。
    const urls = Array.isArray(savedBucket) ? savedBucket : (savedBucket || {}).urls;
    const origin = Array.isArray(savedBucket) ? '' : ((savedBucket || {}).origin || '');
    if (!Array.isArray(urls) || !urls.length) continue;

    const key = String(rawKey);
    const bucket = netLog.get(key);
    if (!bucket) {
      netLog.set(key, { urls: urls.slice(), seen: new Set(urls), origin });
      continue;
    }
    // Merge, never replace: events may have arrived while the restore was in
    // flight, and overwriting would drop them.
    if (origin && !bucket.origin) bucket.origin = origin;
    for (const url of urls) {
      if (bucket.seen.has(url)) continue;
      bucket.seen.add(url);
      bucket.urls.push(url);
    }
  }
}

function ensureNetLogRestored() {
  if (!netLogReady) netLogReady = restoreNetLog().catch(() => {});
  return netLogReady;
}

ensureNetLogRestored();

// --- capture channels ------------------------------------------------------

safeRegister('webRequest.onBeforeRequest', () => {
  chrome.webRequest.onBeforeRequest.addListener((details) => {
    netEventsTotal += 1;

    const tabId = details.tabId;
    if (tabId == null) return;

    if (details.type === 'main_frame') {
      // 顶层导航：上一个页面的日志全部作废。
      //
      // 这里**不是** delete 就完事，而是换成带新页面 origin 的空桶。原因：SW 被
      // 回收后 restoreNetLog 会把持久化的旧桶原样搬回来，一次 delete 挡不住它；
      // 有了 origin 标记，查询时「桶的 origin ≠ 当前页面 origin」就能判成过期。
      // 同标签页从 X 导航到 Telegram 的情况正是靠这一条兜住的。
      if (tabId >= 0) {
        netLog.set(tabKey(tabId), {
          urls: [],
          seen: new Set(),
          origin: originOf(details.url),
        });
        flushNetLog();
        // 角标也一起清：新页面还没被识别过，留着旧页面的「1」会误导。
        // 新页面的 content script 会在首次 refresh() 时重新上报。
        void setBadge(tabId, 0);
        // 页面状态同理：新页面的下载状态与旧页面无关。
        pageStates.delete(tabId);
      }
      return;
    }

    if (tabId >= 0) {
      rememberUrl(tabKey(tabId), details.url);
    } else {
      // tabId = -1：浏览器归属不到标签页（service worker / 其它扩展）。
      // 按发起方 origin 归档，只给同源页面用；认不出 origin 的进 o: 空桶，
      // 该桶不参与任何合并（宁可少给，不可给错）。
      rememberUrl(originKey(originOf(details.initiator) || originOf(details.documentUrl)), details.url);
    }
    scheduleFlush();
  }, { urls: ['<all_urls>'] });
});

// Second channel: any download the page itself starts (e.g. Telegram Web K's
// own ↓ button) carries the real, session-authorised media URL. Cheap to
// observe and it also tells us the URL shape when sniffing comes up empty.
safeRegister('downloads.onCreated', () => {
  chrome.downloads.onCreated.addListener((item) => {
    const url = item && (item.finalUrl || item.url);
    if (!url) return;

    // 只记「页面发起的下载」（tabId >= 0）。扩展自己调 chrome.downloads.download
    // 建的下载 tabId = -1，它不属于任何页面 —— v1.3.8 就是把它记进了共享桶，
    // 于是**每个**标签页都把那条 URL 当成自己页面的候选。在 X 下完视频再去
    // Telegram 点下载，下到的还是 X 的视频，根因就在这一行。
    if (item.tabId == null || item.tabId < 0) return;

    rememberUrl(tabKey(item.tabId), url);
    scheduleFlush();
  });
});

safeRegister('tabs.onRemoved', () => {
  chrome.tabs.onRemoved.addListener((tabId) => {
    netLog.delete(tabKey(tabId));
    flushNetLog();
  });
});

safeRegister('alarms', () => {
  // Keep the shared bucket from growing forever in a long-lived session.
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'mg-netlog-sweep') return;
    // 共享桶是按 origin 分开的，可能有好几个，一起收。
    for (const [key, bucket] of netLog) {
      if (!key.startsWith(ORIGIN_PREFIX)) continue;
      if (bucket.urls.length > NET_LOG_LIMIT / 2) {
        const dropped = bucket.urls.splice(0, bucket.urls.length - NET_LOG_LIMIT / 2);
        for (const d of dropped) bucket.seen.delete(d);
      }
    }
  });
  // Guarded create: top-level code re-runs on every service-worker wake, and an
  // unconditional create() would keep resetting the timer so it never fires.
  chrome.alarms.get('mg-netlog-sweep').then((existing) => {
    if (!existing) chrome.alarms.create('mg-netlog-sweep', { periodInMinutes: 5 });
  }).catch(() => {});
});

/**
 * 当前页面可以使用的候选 URL。
 *
 * 只有两个来源会被合并：
 *   1. 本标签页自己的桶（页面自己发起的请求）；
 *   2. 共享桶里**与本页同源**的那一个（worker / SW 代页面发的请求）。
 * 其余一律不给 —— 跨站候选是 v1.3.8 下错视频的直接原因。
 *
 * `pageOrigin` 由调用方的 sender.url 推出。桶上记着创建时的页面 origin，
 * 用来识别「同标签页换站后由 SW 重启恢复回来的旧快照」：origin 对不上就整桶丢弃。
 */
async function getNetLog(tabId, pageOrigin) {
  await ensureNetLogRestored();
  const urls = [];

  const own = tabId == null ? null : netLog.get(tabKey(tabId));
  const stale = !!own && !!own.origin && !!pageOrigin && own.origin !== pageOrigin;
  let tabUrls = 0;
  if (own && !stale) {
    urls.push(...own.urls);
    tabUrls = own.urls.length;
  }

  const shared = pageOrigin ? netLog.get(originKey(pageOrigin)) : null;
  if (shared) urls.push(...shared.urls);

  // 归属不明的请求（认不出 initiator）单独计数，但不参与合并。
  const unscoped = netLog.get(originKey(''));

  return {
    ok: true,
    urls,
    events: netEventsTotal,
    tabUrls,
    sharedUrls: shared ? shared.urls.length : 0,
    unscopedUrls: unscoped ? unscoped.urls.length : 0,
    staleTab: stale,
  };
}

function getHealth() {
  return {
    ok: true,
    hasWebRequest: !!(chrome.webRequest && chrome.webRequest.onBeforeRequest),
    hasDownloads: !!(chrome.downloads && chrome.downloads.onCreated),
    hasSessionStorage: !!(chrome.storage && chrome.storage.session),
    events: netEventsTotal,
    buckets: netLog.size,
    bootErrors: bootErrors.slice(),
  };
}

// ---------------------------------------------------------------------------
// message router
// ---------------------------------------------------------------------------

async function handle(msg, sender) {
  switch (msg && msg.type) {
    case 'ping':
      return callHost({ cmd: 'ping' });
    case 'getSettings':
      return { ok: true, settings: await getSettings() };
    case 'setSettings':
      return { ok: true, settings: await setSettings(msg.patch) };
    case 'start':
      return startJob(msg);
    case 'startDirect':
      return startBrowserDirect(msg);
    case 'probe':
      return probeJob(msg);
    case 'poll':
      return pollJob(msg.jobId);
    case 'list':
      return listJobs();
    case 'cancel':
      return cancelJob(msg.jobId);
    case 'reveal':
      return callHost({ cmd: 'reveal', path: msg.path });
    case 'openDir':
      return callHost({ cmd: 'openDir', dir: msg.dir });
    case 'forget':
      return forgetJobs(msg.jobId);
    case 'installFetchHook':
      return installFetchHook(msg.tabId);
    case 'assembleMse':
      return assembleMse(msg.tabId, msg.filename);
    case 'getNetLog':
      // 页面 origin 以 sender 为准，不取 content script 传来的值：它才是
      // 「这条消息属于哪个页面」的可信来源，也因此不受页面脚本影响。
      return getNetLog(
        msg.tabId,
        originOf(sender && (sender.url || (sender.tab && sender.tab.url))) || '',
      );
    case 'badge':
      return setBadge(sender && sender.tab && sender.tab.id, msg.count);
    case 'pageState':
      return recordPageState(sender && sender.tab && sender.tab.id, msg.state);
    case 'getPageState':
      return { ok: true, state: pageStates.get(msg.tabId) || null };
    case 'getHealth':
      return getHealth();
    default:
      return { ok: false, error: `unknown message type: ${msg && msg.type}` };
  }
}

/**
 * 工具栏角标：视频页显示 1，其它页面清掉。
 *
 * 两个细节：
 *   - 只取 0 / 1（"有"或"没有"）。角标数字没有更多信息量——页面上有几个视频、
 *     要下哪一档由面板里的画质选择表达。
 *   - tabId 不是数字时直接跳过：拿不到 tab 就没法定位角标，硬设会设到所有
 *     标签页上（chrome.action 不带 tabId 就是全局设置）。
 *   - chrome.action 不存在（旧内核 / 测试桩）时返回错误而不是抛，
 *     调用方是 fire-and-forget 的 void，抛出去只会变成未捕获的 rejection。
 */
/**
 * 页面（content script）报上来的状态快照。
 *
 * v1.5.0 起页面内不再有 UI，用户从菜单栏点「下载此页视频」之后 popup 立刻关闭，
 * 而这一条下载（Telegram 的整片 Range 拉取）可能跑十几分钟 —— 完成 / 失败
 * 必须有**页面外**的出口，否则用户全程看不到任何反馈：
 *   1. 存进 session storage / 内存，popup 再打开时能读到；
 *   2. 状态从"跑着"翻成"完成"/"失败"的那一次，发一条系统通知。
 *
 * ⚠️ 只在这两种状态**变化**时通知。content script 每 700ms 可能上报一次，
 * 不做变化判定就是每 700ms 弹一个通知。
 */
const pageStates = new Map();   // tabId -> state

async function recordPageState(tabId, state) {
  if (typeof tabId !== 'number' || tabId < 0 || !state) return { ok: true, skipped: true };
  const prev = pageStates.get(tabId) || null;
  pageStates.set(tabId, state);

  if (chrome.storage && chrome.storage.session) {
    try {
      await chrome.storage.session.set({ [`pageState:${tabId}`]: state });
    } catch (e) { /* session storage 不可用不影响下载本身 */ }
  }

  const finished = state.phase === 'done' || state.phase === 'error';
  if (finished && prev && prev.phase !== state.phase) {
    const settings = await getSettings();
    if (settings.notifyOnFinish) {
      chrome.notifications.create(`mg-page-${tabId}-${state.at || Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: state.phase === 'done' ? '下载完成' : '下载失败',
        message: (state.message || state.title || '').slice(0, 160),
        silent: true,
      });
    }
  }
  return { ok: true };
}

async function setBadge(tabId, count) {
  if (typeof tabId !== 'number' || tabId < 0) return { ok: true, skipped: true };
  if (!chrome.action || !chrome.action.setBadgeText) {
    return { ok: false, error: 'chrome.action 不可用' };
  }

  const on = Number(count) > 0;
  await chrome.action.setBadgeText({ tabId, text: on ? '1' : '' });

  if (chrome.action.setBadgeBackgroundColor) {
    try {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#e0507b' });
    } catch (e) { /* 颜色不被接受不影响功能 */ }
  }
  if (chrome.action.setTitle) {
    try {
      await chrome.action.setTitle({
        tabId,
        title: on ? 'MediaGrab — 本页有视频可下载' : 'MediaGrab',
      });
    } catch (e) { /* 同上 */ }
  }
  return { ok: true, on };
}

async function forgetJobs(jobId) {
  const jobs = await readJobs();
  if (jobId) {
    delete jobs[jobId];
  } else {
    for (const key of Object.keys(jobs)) {
      if (jobs[key].phase === 'done' || jobs[key].phase === 'error') delete jobs[key];
    }
  }
  await writeJobs(jobs);
  return { ok: true };
}

/**
 * 把 MAIN world 的采集钩子注入指定标签页。
 *
 * 钩子本体在 hooks.js —— 它同时作为 `world: "MAIN"` + `run_at: "document_start"`
 * 的 content script 挂在页面里（见 manifest.json），那一份才是主路径：能在任何
 * 页面脚本之前装好，而 MSE 捕获必须抢在播放器第一次 appendBuffer 之前，晚一步
 * 就丢掉开头的数据。
 *
 * 这个函数是补装路径，用于「页面在扩展更新之前就已经加载完」的情况——此时
 * document_start 那次注入已经错过，只能补。hooks.js 幂等，重复注入安全。
 */
async function installFetchHook(tabId) {
  if (!tabId) return { ok: false, error: "missing tabId" };
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["hooks.js"],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/**
 * 把 MAIN world 钩子捕获的 MSE 分片拼成文件，并在页面里触发保存。
 *
 * 为什么绕这么一圈：Telegram Web K / X.com 的 <video> 上是 MediaSource 的
 * `blob:` 引用——它不是 Blob，页面里 fetch 必报 net::ERR_FILE_NOT_FOUND，
 * chrome.downloads 更拿不到字节。真实字节只在 appendBuffer 的入参里，
 * 由 installFetchHook 装好的钩子留了副本。
 *
 * 拼装与点击都放在 MAIN world 内完成：blob URL 不跨 world 传递，
 * 也避开渲染进程/浏览器进程之间的 blob 可见性问题。
 */
async function assembleMse(tabId, filename) {
  if (!tabId) return { ok: false, error: 'missing tabId' };
  try {
    const [entry] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [filename || 'video.mp4'],
      func: (name) => {
        const media = window.__mgMedia;
        const buckets = (media && media.buckets) || [];
        if (!buckets.length) return { ok: false, error: '没有捕获到 MSE 数据' };

        const tracks = buckets.map((b) => ({ mime: b.mime || '', bytes: b.bytes }));

        let best = null;
        for (const b of buckets) if (!best || b.bytes > best.bytes) best = b;
        if (!best || !best.bytes) return { ok: false, error: 'MSE 数据为空' };

        const mime = /^audio\//i.test(best.mime || '') ? best.mime : 'video/mp4';
        const blob = new Blob(best.chunks, { type: mime });
        const url = URL.createObjectURL(blob);
        try {
          const a = document.createElement('a');
          a.href = url;
          a.download = name;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          a.remove();
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 120000);
        }
        return { ok: true, size: blob.size, mime, tracks };
      },
    });
    return (entry && entry.result) || { ok: false, error: '注入无返回' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Content scripts 不知道自己的 tabId——用 sender.tab.id 补齐。
  if (msg && (msg.type === 'installFetchHook' || msg.type === 'getNetLog'
      || msg.type === 'assembleMse')
      && !msg.tabId && sender.tab && sender.tab.id != null) {
    msg.tabId = sender.tab.id;
  }
  handle(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true; // keep the channel open for the async reply
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const jobs = await readJobs();
  for (const record of Object.values(jobs)) {
    if (record.phase === 'done' || record.phase === 'error') continue;
    await pollJob(record.jobId);
  }
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || (delta.state.current !== 'complete' && delta.state.current !== 'interrupted')) {
    return;
  }
  const jobs = await readJobs();
  const record = Object.values(jobs).find((j) => j.downloadId === delta.id);
  if (record) await pollJob(record.jobId);
});

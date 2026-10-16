/**
 * MediaGrab popup: host health, defaults, current-tab shortcut, recent jobs.
 */

const $ = (id) => document.getElementById(id);

const elStatus = $('status');
const elHostProblem = $('hostProblem');
const elTabInfo = $('tabInfo');
const elTabDownload = $('tabDownload');
const elTabCopy = $('tabCopy');
const elTabHint = $('tabHint');
const elJobs = $('jobs');

const elTabRunning = $('tabRunning');
const elTabVariants = $('tabVariants');

/** popup 选定的档位序号（-1 = 不指定）。 */
let pickedVariant = -1;

/**
 * 档位选择：按**真实体积**列出当前这条的兄弟档位。
 *
 * 为什么只能按体积、不能按"1080p/720p"：Telegram 的每个画质档位是**独立的
 * docId（不同文档）**，端点 URL 里只有 {docId, dcId, size, mimeType}，既没有
 * 分辨率也没有档位名。之前 UI 上写"最高画质/约 1080p"是假的（1.7.0 实测三连
 * 下载拿到同一条视频、清晰度还不一样，就是这个假映射害的）。
 *
 * 体积是唯一诚实的指标，所以直接标出来让用户自己挑。
 */
function renderVariants(list) {
  const items = Array.isArray(list) ? list : [];
  if (items.length < 2) { elTabVariants.hidden = true; elTabVariants.innerHTML = ''; pickedVariant = -1; return; }
  elTabVariants.hidden = false;
  const tip = '端点 URL 里只有字节数，没有分辨率也没有档位名（每个画质档位是独立 docId）。'
    + '所以这里只标真实体积，不猜"这是 1080p/720p"。';
  elTabVariants.innerHTML = items.map((v, i) => {
    const on = i === pickedVariant || (pickedVariant < 0 && v.current);
    return `<button class="v${on ? ' on' : ''}" data-i="${i}" title="${escapeHtml(tip)}">`
      + `${escapeHtml(fmtBytes(v.size))}${v.current ? ' · 当前' : ''}</button>`;
  }).join('');
  for (const b of elTabVariants.querySelectorAll('.v')) {
    b.addEventListener('click', () => {
      pickedVariant = Number(b.dataset.i);
      renderVariants(items);
    });
  }
}

/**
 * 并发任务列表。
 *
 * 1.7.0 之前这里只有一行 elPct，而它是**全局共享**的：下 A 时切到 B，A 的进度
 * 还在往那一行写，B 的进度也会写进去，两个任务互相踩；按钮还被禁用，B 根本
 * 没法起。现在每个任务一行，各写各的。
 */
function renderRunning(list) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) { elTabRunning.innerHTML = ''; return; }
  const rows = items.map((j) => {
    const pct = j.total ? Math.min(100, Math.round((j.received / j.total) * 100)) : 0;
    const finished = j.done === 'done';
    // `interrupted` = 「页面刷新时被中断」。与 failed 同色（都不是好结果），
    // 但文案必须不同：它**不是失败** —— 点一次下载能从断点续上，而且**没有任何
    // 东西在后台继续跑**（1.8.0 实测用户就在猜这件事，插件却什么都不说）。
    const broken = j.done === 'failed' || j.done === 'interrupted';
    const cls = finished ? 'ok' : (broken ? 'err' : '');
    const fallbackNote = j.done === 'interrupted' ? '已被页面刷新中断（未在后台继续）' : '失败';
    const right = finished
      ? escapeHtml(j.note || '完成')
      : (broken ? escapeHtml(j.note || fallbackNote)
        : (j.total ? `${escapeHtml(fmtBytes(j.received))} / ${escapeHtml(fmtBytes(j.total))}`
          : escapeHtml(fmtBytes(j.received))));
    return `<div class="r ${cls}">`
      + `<div class="rn" title="${escapeHtml(j.name)}">${escapeHtml(j.name)}</div>`
      + (j.total && !finished
        ? `<div class="bar"><i style="width:${pct}%"></i></div>` : '')
      + `<div class="rp">${right}</div></div>`;
  });
  elTabRunning.innerHTML = rows.join('');
}

const elPageStale = $('pageStale');
const elPageStaleWhy = $('pageStaleWhy');

/**
 * 「本页还没装上扩展脚本」横幅。
 *
 * 这个状态以前完全没有出口，于是表现为「点下载 → 一直等待中」：
 * 扩展一更新，**已经打开**的标签页里那份 content script 就作废了
 * （`chrome.runtime.id` 变 undefined），而页面**不会**被自动重新注入。
 * 于是 `pageDetect` 5 秒超时 → `pageLive = false` → 静默退回"把页面地址交给
 * yt-dlp"——那条路在 X 上其实能下完（1.6.1 实测：Rayburst 弹了"下载完成"，
 * 标题正是我们传过去的推文标题），但用户全程看不到进度，只觉得卡住了。
 *
 * 所以这里把该做的动作摆出来：刷新本页（一次就修好），以及明确标注代价的
 * yt-dlp 备选。角标不出现也是同一个原因（脚本失效时 `reportBadge` 直接 return）。
 */
function showStaleBanner(why) {
  elPageStale.hidden = false;
  elPageStaleWhy.textContent = why
    || '扩展刚更新 / 重载时，这个标签页里的脚本就作废了，而页面不会自动重新注入。'
    + '刷新一次即可恢复（角标也会重新出现）。';
}

function hideStaleBanner() {
  elPageStale.hidden = true;
}

let activeTab = null;
let activeTarget = { kind: 'none' };
let pageLive = false;      // 当前标签页里有没有可对话的 content script
let lastSummary = null;    // 最近一次 pageStatus 的 summary —— 「复制诊断信息」要用
let lastState = null;      // 最近一次 pageStatus 的 state

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (reply) => {
      const err = chrome.runtime.lastError;
      resolve(err ? { ok: false, error: err.message } : (reply || { ok: false, error: 'no reply' }));
    });
  });
}

function setStatus(kind, text) {
  elStatus.className = `status ${kind}`;
  elStatus.querySelector('span').textContent = text;
}

function showHostProblem(host) {
  elHostProblem.hidden = false;
  elHostProblem.innerHTML = `
    <div class="errbox">
      <strong>本地服务未就绪。</strong><br>
      ${host && host.error ? `错误：<code>${String(host.error).replace(/</g, '&lt;')}</code><br>` : ''}
      需要先安装 native messaging host。在项目目录执行：<br>
      <code>./install.sh</code><br>
      装好后重开本 popup。
    </div>`;
}

function fmtDuration(seconds) {
  if (!seconds) return '';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

async function loadSettings() {
  const reply = await send({ type: 'getSettings' });
  const s = (reply && reply.settings) || {};
  $('mode').value = s.mode || 'browser';
  $('quality').value = s.quality || 'best';
  $('outDir').value = s.outDir || '';
  $('cookies').value = s.cookies || 'chrome';
  $('allowPlaylist').checked = !!s.allowPlaylist;
  $('revealOnFinish').checked = s.revealOnFinish !== false;
  $('notifyOnFinish').checked = s.notifyOnFinish !== false;
}

function wireSettings() {
  $('mode').addEventListener('change', () => send({ type: 'setSettings', patch: { mode: $('mode').value } }));
  $('quality').addEventListener('change', () => send({ type: 'setSettings', patch: { quality: $('quality').value } }));
  $('outDir').addEventListener('change', () => send({ type: 'setSettings', patch: { outDir: $('outDir').value.trim() } }));
  $('cookies').addEventListener('change', () => send({ type: 'setSettings', patch: { cookies: $('cookies').value } }));
  $('allowPlaylist').addEventListener('change', () => send({ type: 'setSettings', patch: { allowPlaylist: $('allowPlaylist').checked } }));
  $('revealOnFinish').addEventListener('change', () => send({ type: 'setSettings', patch: { revealOnFinish: $('revealOnFinish').checked } }));
  $('notifyOnFinish').addEventListener('change', () => send({ type: 'setSettings', patch: { notifyOnFinish: $('notifyOnFinish').checked } }));
  $('openDir').addEventListener('click', () => send({ type: 'openDir', dir: $('outDir').value.trim() }));
}

// ---------------------------------------------------------------------------
// current tab
// ---------------------------------------------------------------------------

async function loadActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  if (!tab || !tab.id || !tab.url) {
    elTabInfo.textContent = '无法读取当前标签页';
    elTabDownload.disabled = true;
    elTabCopy.disabled = true;
    return;
  }

  // 主路径：问 content script。**这是 Telegram / X 这类站点唯一的识别路径** ——
  // sites.js 的 detectFromUrl 对它们只会回 none（页面地址里看不出有没有视频），
  // 真正的识别靠页面里的 <video> + MSE / 网络候选（见 content.js 的 detect()）。
  // 画质必须一起送过去：摘要里的「当前画质整片约 X」是按它算的，而 popup 里
  // 那个下拉与 content script 自己持有的 elQuality 可能不同步（面板 UI 已撤掉，
  // elQuality 只在 loadSettings / pageDownload 时才被赋值）。
  const reply = await sendTab(tab.id, { type: 'pageDetect', quality: $('quality').value });
  if (reply && reply.ok) {
    pageLive = true;
    renderPage(reply.summary, reply.state);
    return;
  }

  // 兜底：页面里没有 content script（扩展刚装、chrome:// 页面、PDF 查看器等）。
  // 此时只能按 URL 规则判断，能认出直链/已知站点就够了。
  pageLive = false;
  const Sites = globalThis.MediaGrabSites;
  activeTarget = Sites.detectFromUrl(tab.url);
  if (activeTarget.kind === 'site' || activeTarget.kind === 'direct') {
    elTabInfo.innerHTML = `<strong>${escapeHtml(activeTarget.site || '视频')}</strong><br>`
      + escapeHtml(shortUrl(tab.url));
    elTabHint.textContent = reply && reply.error ? String(reply.error) : '';
    elTabDownload.disabled = false;
    // 站点页（Telegram / X / B 站…）的字节与候选**只存在于页面上下文**：
    // 没有那份脚本就什么都不知道，这时候唯一有意义的动作是刷新本页。
    if (activeTarget.kind === 'site') {
      showStaleBanner();
      elTabDownload.textContent = '刷新本页';
      elTabDownload.dataset.action = 'reload';
      elTabDownload.classList.remove('primary');
      elTabCopy.disabled = true;
    } else {
      hideStaleBanner();
      elTabCopy.disabled = false;
    }
  } else {
    hideStaleBanner();
    elTabInfo.innerHTML = `<strong>当前页未识别到视频</strong><br>${escapeHtml(shortUrl(tab.url))}`;
    elTabHint.textContent = (reply && reply.error) || '刷新页面后重试。';
    elTabDownload.disabled = true;
    elTabCopy.disabled = true;
  }
}

/**
 * 用 content script 报上来的状态渲染「当前标签页」卡片。
 *
 * summary = 页面里"有什么可下的"（候选条数、整片大小、缓存字节…），
 * state   = "正在做什么"（阶段、进度、消息）。
 */
function renderPage(summary, state) {
  lastSummary = summary || null;
  lastState = state || null;
  if (summary && summary.kind !== 'none') {
    hideStaleBanner();
    elTabDownload.classList.add('primary');
  }

  if (!summary || summary.kind === 'none') {
    elTabInfo.innerHTML = `<strong>当前页未识别到视频</strong><br>`
      + escapeHtml(shortUrl(activeTab.url));
    const msg = state && state.message && state.message !== '就绪' ? state.message : '';
    elTabHint.textContent = msg || '先把视频播放几秒让它开始缓冲，再打开这里。';
    elTabHint.style.color = state && state.tone === 'err' ? 'var(--err)' : '';
    elTabDownload.disabled = true;
    elTabCopy.disabled = true;
    return;
  }

  const bits = [];
  // 档位选择同理：那些"档位"是 Telegram 语义（每个画质是独立 docId），
  // 在 ytdlpOnly 站点上没有意义，点它只会误导。
  if (!summary.ytdlpOnly) renderVariants(summary.variants);
  else { elTabVariants.hidden = true; elTabVariants.innerHTML = ''; pickedVariant = -1; }
  if (summary.ytdlpOnly) bits.push('音视频分离，走 yt-dlp');
  // ⚠️ `ytdlpOnly` 站点**不显示**同源流端点与档位大小。
  // 那些数字来自页面嗅探，而 `hls_stream/{docId,dcId,size,mimeType}` 是
  // **Telegram** 的端点格式：B 站页面上出现同源流候选纯属巧合，把它的 size
  // 当"整片大小"报出来就是假信息（1.9.2 实测：摘要写 31MiB，实际 84.36MiB）。
  // 真实大小由 yt-dlp 在下载时给出，不该在这里猜。
  if (summary.ytdlpOnly) {
    bits.push('文件大小由 yt-dlp 解析后给出');
  } else if (summary.streams) {
    bits.push(`同源流端点 ${summary.streams} 条`);
    // ⚠️ 必须报**选中档**的大小，不能报候选里最大的那个。
    // 1.6.0 首日实测：同页 4 条画质候选，面板写「整片约 127MB」（最高档），
    // 而画质选的是 720p、实际下下来 73.5MiB —— 差了 1.7 倍，用户以为下错了。
    const sel = Number(summary.selectedSize) || 0;
    const max = Math.max(0, ...(summary.streamSizes || [0]));
    if (sel) bits.push(`当前画质整片约 ${fmtBytes(sel)}`);
    if (max > sel) bits.push(`最高画质档约 ${fmtBytes(max)}`);
  }
  if (summary.mseBytes) bits.push(`播放器缓存 ${fmtBytes(summary.mseBytes)}`);
  if (!summary.hook) bits.push('采集钩子未装（刷新页面）');

  elTabInfo.innerHTML = `<strong>${escapeHtml(state.title || summary.site || '视频')}</strong><br>`
    + escapeHtml(bits.join(' · ') || shortUrl(activeTab.url));

  // ⚠️ 不再因为"有任务在跑"而禁用下载按钮 —— 那会让「下 A 时切到 B」下不了 B
  // （1.7.0 实测）。禁用只保留给"本页需要刷新"那种真做不了的情况。
  elTabDownload.disabled = false;
  elTabCopy.disabled = false;

  // 「整片下载失败，可以退而求其次导出播放器缓存」—— 这是**唯一**的人工出口，
  // 所以按钮要跟着状态改名，否则那条路根本点不到。
  if (state && state.action === 'mse') {
    elTabDownload.textContent = '改用播放器缓存导出';
    elTabDownload.dataset.action = 'mse';
  } else {
    elTabDownload.textContent = '下载此页视频';
    delete elTabDownload.dataset.action;
  }
  renderStateLine(state);
}

function renderStateLine(state) {
  renderRunning(state && state.running);
  if (!state) return;
  const parts = [state.message || ''];
  if (state.percent) parts.push(`${state.percent}%`);
  if (state.detail) parts.push(state.detail);

  if (state.action === 'reload') {
    elTabHint.style.color = 'var(--err)';
    elTabHint.textContent = '扩展刚被重载，本页脚本已过期 —— 刷新页面后重试。';
    return;
  }
  elTabHint.style.color = state.tone === 'err' ? 'var(--err)'
    : (state.tone === 'ok' ? 'var(--ok)' : '');
  elTabHint.textContent = parts.filter(Boolean).join(' · ');
}

$('tabDiagnose').addEventListener('click', async () => {
  const btn = $('tabDiagnose');
  if (!activeTab || !activeTab.id) {
    elTabHint.textContent = '当前标签页不可用。';
    return;
  }

  btn.disabled = true;
  btn.textContent = '收集中…';
  const reply = await sendTab(activeTab.id, { type: 'pageStatus' }, 3000);
  const text = buildDiagnostics(activeTab, reply);

  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '已复制';
    elTabHint.style.color = 'var(--ok)';
    elTabHint.textContent = '诊断信息已复制到剪贴板。';
  } catch (e) {
    btn.textContent = '复制失败';
    elTabHint.style.color = 'var(--err)';
    elTabHint.textContent = `复制失败：${(e && e.message) || e}`;
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = '复制诊断信息'; }, 2200);
});

/**
 * popup 开着的时候每 900ms 拉一次页面状态。
 *
 * 这不是"实时进度条"级别的需求，而是**唯一**的进度出口：页面里没有 UI 了，
 * 整片拉取又跑得久；用户点完下载往往就停在 popup 上看着。
 */
let stateTimer = null;
function startStatePolling() {
  if (stateTimer) return;
  stateTimer = setInterval(async () => {
    if (!activeTab || !activeTab.id) return;
    const reply = await sendTab(activeTab.id, { type: 'pageStatus' }, 2500);
    if (reply && reply.ok) renderPage(reply.summary, reply.state);
  }, 900);
}

/**
 * 把这一页的可诊断信息拼成一段纯文本，交给「复制诊断信息」按钮。
 *
 * 为什么需要它：页面里已经没有 UI 了，失败原因只出现在 popup 的一行提示和
 * Console 里 —— 而 popup 一关那行提示就没了。前几轮排查都卡在"没拿到 Console"，
 * 所以这里把两处合并成一段可以直接粘贴的文本。
 */
function buildDiagnostics(tab, reply) {
  const s = (reply && reply.summary) || lastSummary || {};
  const st = (reply && reply.state) || lastState || {};
  const lines = [];
  const push = (k, v) => { if (v !== undefined && v !== null && v !== '') lines.push(`${k}: ${v}`); };

  lines.push('=== MediaGrab 诊断 ===');
  push('时间', new Date().toISOString());
  push('页面', (tab && tab.url) || '');
  push('标题', (tab && tab.title) || '');

  lines.push('');
  lines.push('--- 页面识别 ---');
  push('kind', s.kind);
  push('site', s.site);
  push('runtimeOnly（页面运行时流）', s.runtimeOnly);
  push('ytdlpOnly', s.ytdlpOnly);
  push('采集钩子', s.hook ? 'on' : 'off');
  push('候选总数', s.candidates);
  push('同源流端点', `${s.streams} 条 · 声明大小 ${(s.streamSizes || []).join(' / ') || '-'}`);
  push('MSE 字节', s.mseBytes);
  push('endOfStream 次数', s.eos);
  push('bestUrl', s.bestUrl);

  lines.push('');
  lines.push('--- 最近一次动作 ---');
  push('phase', st.phase);
  push('tone', st.tone);
  push('busy', st.busy);
  push('percent', st.percent);
  push('detail', st.detail);
  push('action', st.action);
  push('message', st.message || s.message);

  lines.push('');
  lines.push('--- MSE 缓存轨 ---');
  const tracks = s.tracks || [];
  if (!tracks.length) lines.push('(无)');
  tracks.forEach((t, i) => lines.push(
    `#${i} ${t.bytes}B ${t.w || '?'}x${t.h || '?'} 片长${t.duration || '?'} 缓冲至${t.buffered || '?'} 面积${t.layout || '?'}`
  ));

  lines.push('');
  lines.push('（如方便，另附 Console 里以 [MediaGrab] 开头的行）');
  return lines.join('\n');
}

function shortUrl(u) {
  try {
    const parsed = new URL(u);
    return `${parsed.hostname}${parsed.pathname}${parsed.search}`.slice(0, 90);
  } catch (e) {
    return String(u).slice(0, 90);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '';
  // 1024 进制就得标 KiB/MiB/GiB —— 与 content.js 的 fmtBytes 保持一致。
  // 标成 MB 会让面板的 73MiB 与 Finder 的 77.1MB 看起来差了近 5MB。
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}

/**
 * 给 content script 发消息。
 *
 * 页面里已经没有按钮了（用户要求"下载只通过菜单栏下"），所以下载动作必须由
 * 这里下指令、页面执行 —— Telegram 的 /stream/ 与 /hls_stream/ 端点只在页面
 * 上下文里才有意义（Service Worker 靠 event.clientId 反查账号），MSE 缓存字节
 * 也只存在页面内存里。
 *
 * 带超时：content script 不在（刚装扩展 / 页面是 chrome:// / 页面还没注入）时
 * chrome.tabs.sendMessage 的回调**不一定**会被调用，只靠 lastError 会永远挂着。
 */
function sendTab(tabId, message, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: '页面脚本无响应（刷新页面后重试）' }),
      timeoutMs
    );

    try {
      chrome.tabs.sendMessage(tabId, message, (reply) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        finish(err ? { ok: false, error: err.message } : (reply || { ok: false, error: 'no reply' }));
      });
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, error: String(e) });
    }
  });
}

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

const PHASE_TEXT = {
  probe: '解析中',
  download: '下载中',
  running: '下载中',
  browser: '下载中',
  done: '完成',
  error: '失败',
};

function renderJobs(jobs) {
  if (!jobs || !jobs.length) {
    elJobs.innerHTML = '<div class="empty">暂无记录</div>';
    return;
  }
  elJobs.innerHTML = '';
  for (const job of jobs) {
    const row = document.createElement('div');
    row.className = 'job';

    const title = document.createElement('div');
    title.className = 'jt';
    title.textContent = (job.title || job.url || '').slice(0, 60);
    title.title = job.title || job.url || '';

    const state = document.createElement('div');
    state.className = 'js' + (job.phase === 'done' ? ' ok' : job.phase === 'error' ? ' err' : '');
    const pct = typeof job.percent === 'number' ? ` ${job.percent}%` : '';
    state.textContent = (PHASE_TEXT[job.phase] || job.phase || '') + pct;

    row.append(title, state);

    if (job.phase === 'done' && job.file && job.mode !== 'browser') {
      const btn = document.createElement('button');
      btn.textContent = '显示';
      btn.addEventListener('click', () => send({ type: 'reveal', path: job.file }));
      row.appendChild(btn);
    } else if (job.phase !== 'done' && job.phase !== 'error') {
      const btn = document.createElement('button');
      btn.textContent = '取消';
      btn.addEventListener('click', async () => {
        await send({ type: 'cancel', jobId: job.jobId });
        refreshJobs();
      });
      row.appendChild(btn);
    }

    elJobs.appendChild(row);
  }
}

async function refreshJobs() {
  const reply = await send({ type: 'list' });
  renderJobs(reply && reply.jobs);
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

$('pageStaleReload').addEventListener('click', async () => {
  if (!activeTab || !activeTab.id) return;
  try { await chrome.tabs.reload(activeTab.id); } catch (e) { /* ignore */ }
  window.close();
});

$('pageStaleYtdlp').addEventListener('click', async () => {
  if (!activeTab || !activeTab.id) return;
  const btn = $('pageStaleYtdlp');
  btn.disabled = true;
  btn.textContent = '已提交…';
  const reply = await send({
    type: 'start',
    url: activeTarget.url,
    title: activeTab.title || activeTarget.site || '',
    pageUrl: activeTab.url,
  });
  if (!reply || !reply.ok) {
    btn.disabled = false;
    btn.textContent = '仍用 yt-dlp 解析';
    elTabHint.style.color = 'var(--err)';
    elTabHint.textContent = `启动失败：${(reply && reply.error) || '未知错误'}`;
    return;
  }
  elTabHint.style.color = 'var(--ok)';
  elTabHint.textContent = '已提交给 yt-dlp。速度与进度看下方「最近任务」，完成会发系统通知。';
  setTimeout(refreshJobs, 700);
});

elTabDownload.addEventListener('click', async () => {
  if (!activeTab || !activeTab.id) return;

  // 「刷新本页」：扩展更新后已打开的页面必须刷新一次。
  if (elTabDownload.dataset.action === 'reload') {
    elTabDownload.disabled = true;
    elTabDownload.textContent = '正在刷新…';
    try { await chrome.tabs.reload(activeTab.id); } catch (e) { /* 关掉窗口即可 */ }
    window.close();
    return;
  }

  elTabDownload.disabled = true;
  elTabDownload.textContent = '已提交';

  // 页面里没有按钮了，所以**下载必须由页面执行** —— 见 sendTab 上方注释。
  if (pageLive) {
    // 按钮上写着「改用播放器缓存导出」时，走的是另一条消息：只导出播放器
    // 已缓冲的那部分（不完整，但至少是用户明确要的）。
    const wantMse = elTabDownload.dataset.action === 'mse';
    const reply = await sendTab(activeTab.id, wantMse ? {
      type: 'pageMseExport',
    } : {
      type: 'pageDownload',
      quality: $('quality').value,
      mode: $('mode').value,
      outDir: $('outDir').value.trim(),
      variantIndex: pickedVariant,
    });

    if (!reply || !reply.ok) {
      elTabHint.style.color = 'var(--err)';
      elTabHint.textContent = (reply && reply.error) || '启动失败';
      elTabDownload.disabled = false;
      elTabDownload.textContent = '下载此页视频';
      return;
    }
    elTabHint.style.color = 'var(--ok)';
    elTabHint.textContent = '已开始。进度显示在这里；关掉本窗口不影响，完成时会发系统通知。';
    setTimeout(() => { if (activeTab) renderAfterStart(); }, 500);
    return;
  }

  // 没有 content script（chrome:// / PDF 等）：退回老路，把 URL 交给 background。
  const reply = await send({
    type: 'start',
    url: activeTarget.url,
    title: activeTab.title || activeTarget.site || '',
    pageUrl: activeTab.url,
  });

  if (!reply || !reply.ok) {
    elTabHint.textContent = `启动失败：${(reply && reply.error) || '未知错误'}`;
    elTabDownload.disabled = false;
    elTabDownload.textContent = '下载此页视频';
    return;
  }
  elTabHint.textContent = '任务已提交，可在下方“最近任务”查看进度。';
  setTimeout(refreshJobs, 700);
});

async function renderAfterStart() {
  if (!activeTab || !activeTab.id) return;
  const reply = await sendTab(activeTab.id, { type: 'pageStatus' });
  if (reply && reply.ok) renderPage(reply.summary, reply.state);
}

elTabCopy.addEventListener('click', async () => {
  elTabCopy.disabled = true;
  elTabCopy.textContent = '解析中…';
  try {
    let url = '';

    if (pageLive && activeTab && activeTab.id) {
      // 页面里已经有候选了，直接取那条最值得给的地址（同源流端点优先）——
      // 比让 yt-dlp 重新解析快得多，也不用碰原生宿主。
      const r = await sendTab(activeTab.id, { type: 'pageStatus' });
      url = (r && r.ok && r.summary && r.summary.bestUrl) || '';
      if (!url) throw new Error('页面里还没有可复制的地址（先播放几秒让它开始缓冲）');
    } else {
      const started = await send({ type: 'probe', url: activeTarget.url, pageUrl: activeTab && activeTab.url });
      if (!started || !started.ok) throw new Error((started && started.error) || '解析启动失败');
      url = await waitForDirectUrl(started.jobId, 45000);
      if (!url) throw new Error('没有可复制的单文件直链（可能是 HLS/DASH 分离流）');
    }

    await navigator.clipboard.writeText(url);
    elTabCopy.textContent = '已复制';
    elTabHint.style.color = 'var(--ok)';
    elTabHint.textContent = '地址已复制，可粘贴进任何下载器。';
  } catch (e) {
    elTabCopy.textContent = '复制直链';
    elTabCopy.disabled = false;
    elTabHint.style.color = 'var(--err)';
    elTabHint.textContent = `失败：${e.message || e}`;
  }
});

async function waitForDirectUrl(jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await send({ type: 'poll', jobId });
    if (!job || !job.ok) return null;
    if (job.phase === 'error') return null;
    const prog = job.host && job.host.probe && job.host.probe.progressive;
    if (job.host && job.host.state === 'done') {
      return prog && prog[0] ? prog[0].directUrl : null;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}

$('refresh').addEventListener('click', refreshJobs);
$('clear').addEventListener('click', async () => {
  await send({ type: 'forget' });
  refreshJobs();
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

(async function boot() {
  wireSettings();
  await loadSettings();

  const host = await send({ type: 'ping' });
  if (host && host.ok) {
    setStatus('on', '已连接');
    if (!host.ytdlp) {
      showHostProblem({ error: 'yt-dlp 未找到，请先执行：brew install yt-dlp' });
    }
  } else {
    setStatus('off', '未连接');
    showHostProblem(host);
  }

  await loadActiveTab();
  startStatePolling();
  await refreshJobs();
})();

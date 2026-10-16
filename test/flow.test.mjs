/**
 * flow.test.mjs —— 端到端：把「点下载 → 落到文件」整条链路搬进 Node 跑。
 *
 * 为什么需要它（这是它存在的唯一理由）：
 *
 * 前几轮每次改动都要用户在 Chrome 里手点、再把 Console 截图发回来 —— 一次迭代
 * 就是一整个来回。而反复出现的那几个 bug（点一次弹两次「另存为」、落成 0 字节、
 * 静默用播放器缓存顶替整片、只下前 5 秒）**全部位于 content.js**，偏偏
 * content.js 一直没有测试：它是个 IIFE，依赖 DOM / chrome.runtime / fetch，
 * 看起来"没法单测"。于是只有 rangeFetch / hooks / sites / netlog 四个纯模块
 * 有回归网，最容易出事的那一层反而裸奔。
 *
 * 这份测试的做法：把 sites.js + rangeFetch.js + content.js **原样**装进 vm，
 * 补上 DOM / chrome / OPFS / tweb 端点四个桩，然后走真实入口
 * （chrome.runtime.onMessage 上的 pageDownload，也就是 popup 点按钮时发的那条），
 * 断言**落在磁盘上的东西**。它跑的是真代码，不是复制品。
 *
 * 钉住的不变量（每条都对应一次真实故障）：
 *   1. 探测不可用的候选**不能建文件** —— v1.5.0「候选 N 条就弹 N 次另存为」的机械原因；
 *   2. 失败**不留残骸**：建过的暂存条目必须被删掉（0 字节文件的来源）；
 *   3. 成功时**只交付一个文件**，且字节**逐字节等于源**；
 *   4. 整片下载失败**绝不自动**改用播放器缓存（那是"下载下来只有 5 秒"的真身）；
 *      缓存导出只在用户显式触发 pageMseExport 时才做；
 *   5. 已知总长后必须发**闭区间** Range —— 发开区间在 `/hls_stream/` 上每轮只回
 *      1 个字节，1200 轮的活会变成几万轮（v1.4.0 前"只下到前几秒"的机械原因）；
 *   6. 运行时流页面上请求 yt-dlp 时，**页面地址不能被交给 yt-dlp**
 *      （那换来一句 `ERROR: Unsupported URL`）。
 *
 * 跑法：node test/flow.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', 'extension');
const readSrc = (f) => fs.readFileSync(path.join(EXT, f), 'utf8');
const [SITES_SRC, STAGING_SRC, RANGE_SRC, CONTENT_SRC, HOOKS_SRC] =
  ['sites.js', 'staging.js', 'rangeFetch.js', 'content.js', 'hooks.js'].map(readSrc);

/** 本轮建过的会话，收尾时统一销毁（清掉轮询定时器）。 */
const liveEnvs = [];

let failures = 0;
const failedNames = [];
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) { failures += 1; failedNames.push(name); }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

/** 收尾清单：失败项集中再列一遍，方便 `| tail` 一眼看全。 */
function summary() {
  if (!failedNames.length) { console.log('\n全部通过'); return; }
  console.log(`\n${failures} 项失败：`);
  for (const n of failedNames) console.log(`  · ${n}`);
}

// ── 通用小工具 ─────────────────────────────────────────────────────────────

const MB = 1024 * 1024;

function makeWhole(size) {
  const u = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) u[i] = (i * 31 + 7) & 0xff;
  return u;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/**
 * 普通 CDN 直链桩（X / 微博 / 抖音这类）：支持 Range、老实报 Content-Range。
 * 与 tweb 端点的区别只是没有 parseRange  quirks —— 跨域直链就是这么朴素。
 */
function plainCdn(whole) {
  return async (url, init) => {
    const m = String((init && init.headers && init.headers.Range) || '')
      .match(/^bytes=(\d+)-(?:(\d+))?$/);
    if (!m) {
      return makeResp({
        status: 200, contentLength: whole.byteLength, body: whole,
      });
    }
    const start = Number(m[1]);
    const end = m[2] === undefined
      ? whole.byteLength - 1
      : Math.min(Number(m[2]), whole.byteLength - 1);
    if (start >= whole.byteLength) return makeResp({ status: 416 });
    return makeResp({
      contentRange: `bytes ${start}-${end}/${whole.byteLength}`,
      contentLength: end - start + 1,
      body: whole.slice(start, end + 1),
    });
  };
}

/** 只看"导出播放器缓存"这条通道的派发记录（dispatches 里还混着 __mg_dl_* 协议事件）。 */
const assembles = (env) => env.dispatches.filter((d) => d.type === '__mg_assemble');

/**
 * 给页面世界的**真钩子**喂 n 字节缓存，并等它 flush 进 dataset。
 *
 * 不能直接写 `dataset.mgMse`：真 hooks.js 装载时会立刻 flush()，把 mgMse 覆盖成
 * 自己的真实值 0 —— 这是 v1.6.0 换成真钩子之后才暴露的测试桩问题。
 */
async function feedCache(env, n) {
  env.appendMse([new Uint8Array(n)]);
  await settle(320);
}

/** 造一个 MP4 box：4 字节大端 size + 4 字节 type + 载荷。 */
function box(type, payloadLen) {
  const size = 8 + payloadLen;
  const b = new Uint8Array(size);
  b[0] = (size >>> 24) & 0xff; b[1] = (size >>> 16) & 0xff;
  b[2] = (size >>> 8) & 0xff; b[3] = size & 0xff;
  for (let i = 0; i < 4; i += 1) b[4 + i] = type.charCodeAt(i);
  for (let i = 8; i < size; i += 1) b[i] = (i * 13) & 0xff;
  return b;
}

const seg = (...parts) => concat(parts);

const sameBytes = (a, b) => !!a && !!b && a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

/**
 * 让尾随的 publish 落地。
 *
 * ⚠️ 这里**不能** unref 定时器：整条下载链路是纯 promise 的（所有 fetch 桩都
 * 立刻 resolve，一个宏任务都不用），事件循环在 `await` 挂起时已经是空的。
 * 一旦这个定时器被 unref，Node 会直接以 exit 0 退出 —— 测试看起来"通过"，
 * 后面的断言一条都没跑。这个坑我踩过一次：现象是只打印了一个用例标题就结束。
 */
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function makeResp({ status = 206, contentType = 'video/mp4', contentRange = null, contentLength = null, body = new Uint8Array(0) }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k) => ({
        'Content-Type': contentType,
        'Content-Range': contentRange,
        'Content-Length': contentLength === null ? null : String(contentLength),
      })[k] ?? null,
    },
    body: { cancel: async () => {} },
    async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength); },
    async blob() { return new Blob([body], { type: contentType }); },
  };
}

// ── tweb 两个端点：照抄页面 Service Worker 的真实行为 ─────────────────────

/**
 * `/k/stream/{JSON}` —— progressive 端点（tweb 的 Stream.requestRange）。
 *
 * 两个必须还原的细节：
 *   · 开区间会被**补全**：`if(!end) end = min(offset+limit, size-1)`；
 *     （注意 `!end` 对 end=0 也为真 —— 这正是不带 Range 的请求会被当成"整片"的原因）
 *   · 单次最多回 1 MiB（MTProto 的 file part 上限），所以请求 4 MiB 会分多轮。
 */
function streamEndpoint(whole) {
  const LIMIT = MB;
  const size = whole.byteLength;
  return async (url, init) => {
    const m = String(init.headers.Range).match(/^bytes=(\d+)-(?:(\d+))?$/);
    const start = Number(m[1]);
    let end = m[2] === undefined ? 0 : Number(m[2]);
    if (!end) end = Math.min(start + LIMIT, size - 1);
    else end = Math.min(end, start + LIMIT - 1, size - 1);
    if (start >= size) return makeResp({ status: 416 });
    return makeResp({
      contentRange: `bytes ${start}-${end}/${size}`,
      contentLength: end - start + 1,
      body: whole.slice(start, end + 1),
    });
  };
}

/**
 * `/k/hls_stream/{JSON}` —— HLS 端点（tweb 的 onHlsStreamFetch）。
 *
 *   onHlsStreamFetch(event, inParams) {
 *     const [lower, upper] = parseRange(event.request.headers.get('Range'));
 *     const {ranges, alignedLowerBound} = splitRangeForGettingFileParts(lower, upper);
 *     headers['Content-Range'] = `bytes ${lower}-${upper}/${size}`;
 *   }
 *
 * parseRange 照抄 serviceWorker/stream.ts:394 —— `+end || 0`，所以**开区间被解析成
 * `[lower, 0]`，只回 1 个字节**（v1.4.0 之前"每轮 1 字节"的机械原因）。
 * splitRange 的 4096 对齐 + 2 的幂 limit 是 MTProto getFile 的硬要求，也正是
 * "我们请求 bytes=a-b、服务端内部却取了别处一片"的来源。
 *
 * `tweak` 用来注入故障：`(ctx) => resp|null`。
 */
function hlsEndpoint(whole, tweak = null) {
  const size = whole.byteLength;
  const parseRange = (header) => {
    if (!header) return [0, 0];
    const [, chunks] = String(header).split('=');
    const [offset, end] = chunks.split('-');
    return [Number(offset), Number(end) || 0];
  };
  const snapLimit = (n) => Math.max(2 ** Math.ceil(Math.log2(n)), 4096);

  return async (url, init) => {
    const [lower, upper] = parseRange(init.headers.Range);
    const chunkStart = Math.floor(lower / 4096) * 4096;
    const nextChunkStart = (Math.floor(upper / 4096) + 1) * 4096;
    const fragStart = Math.floor(lower / MB) * MB;
    const nextFragStart = (Math.floor(lower / MB) + 1) * MB;
    const inThisFrag = Math.min(nextFragStart, nextChunkStart);
    const limitFirst = snapLimit(inThisFrag - chunkStart);
    const alignedLowerBound = Math.max(inThisFrag - limitFirst, fragStart);
    const need = upper - alignedLowerBound + 1;
    const take = Math.max(need, limitFirst);
    const part = whole.slice(alignedLowerBound, Math.min(alignedLowerBound + take, size));
    const body = part.slice(lower - alignedLowerBound, upper - alignedLowerBound + 1);

    if (tweak) {
      const forced = tweak({ lower, upper, body, size });
      if (forced) return forced;
    }
    return makeResp({
      contentRange: `bytes ${lower}-${upper}/${size}`,
      contentLength: upper - lower + 1,
      body,
    });
  };
}

/** 真实形态：`/hls_stream/{docId,dcId,size,mimeType}` —— **没有 fileName**，路径也不带 /k/。 */
function twebUrlNoName(size, kind = 'hls_stream') {
  const params = { docId: '5046529303706076975', dcId: 1, size, mimeType: 'video/mp4' };
  return `https://web.telegram.org/${kind}/${encodeURIComponent(JSON.stringify(params))}`;
}

/**
 * **页面自己 origin** 的流端点（不是 Telegram）。
 *
 * 23e 要复现的症状是"B 站页面上出现同源流端点"—— 而"同源"是必要条件：
 * `isSameOriginStream` 要求 origin 与页面一致。所以夹具必须用页面自己的
 * origin，否则一条候选都进不去（第一版夹具用 web.telegram.org 的 URL，
 * 于是 streams=0，用例变成装饰，R29 抓不到 —— 是反向验证照出来的）。
 */
function sameOriginStreamUrl(origin, size, docId) {
  const params = { docId: docId || '5046529303706076975', dcId: 1, size, mimeType: 'video/mp4' };
  return `${origin.replace(/\/$/, '')}/hls_stream/${encodeURIComponent(JSON.stringify(params))}`;
}

/** 带 docId 的档位 URL：同一个 docId = 同一文档的兄弟档位；不同 docId = 不同视频。 */
function twebVariantUrl(size, docId, fileName) {
  const params = { docId, dcId: 1, size, mimeType: 'video/mp4' };
  if (fileName) params.fileName = fileName;
  return `https://web.telegram.org/hls_stream/${encodeURIComponent(JSON.stringify(params))}`;
}

function twebUrl(size, fileName, kind = 'stream', qs = '') {
  const params = { dcId: 5, size, mimeType: 'video/mp4', fileName };
  return `https://web.telegram.org/k/${kind}/${encodeURIComponent(JSON.stringify(params))}${qs}`;
}

// ── DOM / chrome 桩 ───────────────────────────────────────────────────────

function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {}, dataset: {}, hidden: false, disabled: false,
    textContent: '', className: '', value: '', placeholder: '', title: '', content: '',
    parentElement: null,
    _at: {}, _ev: {}, _kids: null,
    getAttribute(k) { return k in el._at ? el._at[k] : null; },
    setAttribute(k, v) { el._at[k] = String(v); },
    addEventListener(t, fn) { (el._ev[t] = el._ev[t] || []).push(fn); },
    removeEventListener(t, fn) { el._ev[t] = (el._ev[t] || []).filter((f) => f !== fn); },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    appendChild() {}, remove() {}, click() {},
    querySelector(sel) { return (el._kids || {})[sel] || null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
    attachShadow() { return { appendChild() {}, querySelector() { return null; } }; },
  };

  // innerHTML 赋值时把带 class 的子元素登记进 _kids —— content.js 之后全靠
  // panel.querySelector('.title') 这类选择器拿元素，桩必须让它们能命中。
  let inner = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return inner; },
    set(v) { inner = String(v); materialize(el, inner); },
    configurable: true,
  });
  return el;
}

const SELECT_DEFAULTS = { quality: 'best', mode: 'browser', outdir: '' };

function materialize(el, html) {
  const kids = {};
  const tagRe = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const cls = /class="([^"]*)"/.exec(m[2] || '');
    if (!cls) continue;
    const child = makeEl(m[1]);
    for (const token of cls[1].split(/\s+/).filter(Boolean)) {
      kids['.' + token] = child;
      if (token in SELECT_DEFAULTS) child.value = SELECT_DEFAULTS[token];
    }
  }
  // `.bar > i` —— 进度条内层元素没有 class，单独补一个。
  if (kids['.bar']) kids['.bar > i'] = makeEl('i');
  el._kids = kids;
}

function makeOpfsRoot(state) {
  return {
    async getFileHandle(name) {
      state.created.push(name);
      let rec = state.files.get(name);
      if (!rec) {
        // 暂存文件按**字节**寻址（真实 FileSystemWritableFileStream 就是这样：
        // seek(pos) 之后再 write(view) 覆盖 pos 之后的字节）。第一版把文件
        // 建模成"分块数组"，于是 seek(4MiB) 会去 push 四百万个空块 → OOM，
        // 而且根本没有真正检验"续写落在正确偏移"这件事。
        rec = { name, buf: new Uint8Array(0), closed: false, aborted: false };
        state.files.set(name, rec);
      }
      return {
        name,
        async createWritable(opts) {
          // truncate 是默认行为：不显式给 keepExistingData 就把已有内容清空。
          // 这正是"页面刷新后下载从头再来"的直接原因 —— 暂存文件明明还在，
          // 却被下一个写入器抹平了。
          if (!opts || opts.keepExistingData !== true) {
            state.truncated.push(name);
            rec.buf = new Uint8Array(0);
          }
          let cursor = 0;
          const put = (view) => {
            const need = cursor + view.byteLength;
            if (need > rec.buf.byteLength) {
              const grown = new Uint8Array(need);
              grown.set(rec.buf);
              rec.buf = grown;
            }
            rec.buf.set(view, cursor);
            cursor = need;
          };
          return {
            async write(view) {
              if (rec.aborted) throw new Error('写入器已 abort');
              if (state.writeError) {
                const e = new Error(state.writeError === 'quota'
                  ? 'The quota has been exceeded.'
                  : state.writeError);
                e.name = state.writeError === 'quota' ? 'QuotaExceededError' : 'InvalidStateError';
                throw e;
              }
              put(view);
              state.written += view.byteLength;
            },
            async seek(pos) { cursor = Number(pos) || 0; },
            async close() { rec.closed = true; },
            async abort() { rec.aborted = true; state.aborted.push(name); },
          };
        },
        async getFile() {
          const bytes = rec.buf;
          return {
            name: rec.name,
            size: bytes.byteLength,
            async arrayBuffer() {
              return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            },
          };
        },
      };
    },
    async removeEntry(name) { state.removed.push(name); state.files.delete(name); },
  };
}

/**
 * 建一个装了真实 content.js 的执行环境。
 *
 * 返回的 `fire` 走的是 **chrome.runtime.onMessage** —— 也就是 popup 点按钮时
 * 真正发的那条消息，不是内部函数直调。
 */
function makeEnv(opts = {}) {
  const {
    page = 'https://web.telegram.org/k/#@channel',
    pageTitle = 'Telegram Web · 演示视频',
    mgUrls = '',
    mgVideos = '',
    mgMse = 0,
    mgEos = 0,
    // 页面世界的 fetch：SW 会兑现字节（照抄 tweb 的端点实现）。
    mainFetch = async () => { throw new Error('页面世界 fetch 未被桩住'); },
    // 隔离世界的 fetch：**不被页面 SW 拦截**，直连 Telegram 服务器被 302 到 CDN。
    // 这是 v1.5.2 定位到的根本原因，桩必须如实复现 —— 否则测试会自证。
    isoStatus = 302,
    storageMode = 'opfs',
    onMseAssemble = null,
    mseReply = null,
    withVideo = true,
    opfsWriteError = null,
    withMain = true,
    // sessionStorage：跨刷新的事实来源。不传就每次都是"空白标签页"。
    sessionStorage: optSessionStorage = null,
    // opfsFiles：复用同一份"磁盘"，用来模拟"刷新后 OPFS 里的文件还在"。
    opfsFiles: optOpfsFiles = null,
  } = opts;

  const logs = [];
  const msgs = [];
  const states = [];
  const downloads = [];
  const objectUrls = new Map();
  const dispatches = [];
  const docListeners = {};
  const opfs = {
    created: [], removed: [], aborted: [], truncated: [],
    // 复用外部传入的 Map 就是"刷新后文件还在"；否则每个会话都是一块空盘。
    files: optOpfsFiles || new Map(), written: 0,
    // 非 null 时 write() 抛这个错误 —— 用来模拟真实浏览器里的 QuotaExceededError。
    writeError: opfsWriteError,
  };
  const waiters = [];
  // 由桩的 setInterval 登记，env.destroy() 时统一清掉（否则测试之间互相污染）
  const liveIntervals = new Map();      // timer -> 周期(ms)
  // poll / start 的可覆盖回复（默认按 background 的真实形状回）
  let pollReply = { jobId: 'mgjob1', mode: 'ytdlp', phase: 'download',
    percent: 0, downloaded: '', speed: '', eta: '' };
  let startReply = null;
  // 两个世界各自发过的请求。isoCalls 必须是空的（除非刻意测兜底路径）——
  // 这条断言就是「字节只在页面世界拉」这条不变形的守卫。
  const isoCalls = [];
  const mainCalls = [];
  let listener = null;
  let reloads = 0;

  const pageUrl = new URL(page);
  const videos = withVideo ? [(() => {
    const v = makeEl('video');
    // MSE 播放器的 <video>：属性 src 没有、property/currentSrc 是 MediaSource 的
    // blob: 引用。这正是 `directSource()` 必须返回 null 的那种形态。
    v.src = `blob:${pageUrl.origin}/7f2c-uuid`;
    v.currentSrc = v.src;
    v.readyState = 4; v.videoWidth = 1920; v.videoHeight = 1080; v.duration = 612;
    v.buffered = { length: 1, end: () => 5.2 };
    v.getBoundingClientRect = () => ({ width: 640, height: 360, top: 80, left: 100 });
    v.querySelectorAll = () => [];
    return v;
  })()] : [];

  const documentElement = makeEl('html');
  documentElement.dataset = {
    mgHook: 'on', mgUrls, mgVideos,
    mgMse: String(mgMse), mgEos: String(mgEos),
  };

  const body = makeEl('body');

  /**
   * 模拟 MAIN world 的 hooks.js：**真的把字节落盘**（createObjectURL + `<a download>`）。
   *
   * v1.6.0 起真实 hooks.js 已经装在这个世界里，所以这段只在显式提供
   * `onMseAssemble` 时才生效（用于模拟"钩子坏了"的分支）；默认走真钩子。
   */
  function fakeHooksExport(req) {
    const payload = (typeof mseReply === 'function' ? mseReply(req) : mseReply)
      || { ok: true, size: mgMse };
    if (payload.ok) {
      const blob = new Blob([new Uint8Array(payload.size || 1024)], { type: 'video/mp4' });
      const url = mkURL().createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = req.filename || 'video.mp4';
      a.click();
    }
    return payload;
  }

  const document = {
    documentElement,
    body,
    title: pageTitle,
    contentType: 'text/html',
    createElement(tag) {
      const el = makeEl(tag);
      if (String(tag).toLowerCase() === 'a') {
        el.click = () => {
          downloads.push({ name: el.download, url: el.href, blob: objectUrls.get(el.href) || null });
        };
      }
      return el;
    },
    querySelector() { return null; },
    querySelectorAll(sel) { return String(sel).toLowerCase() === 'video' ? videos : []; },
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener(t, fn) { docListeners[t] = (docListeners[t] || []).filter((f) => f !== fn); },
    dispatchEvent(ev) {
      dispatches.push({ type: ev.type, detail: ev.detail });
      for (const fn of [...(docListeners[ev.type] || [])]) fn(ev);
      if (ev.type === '__mg_assemble' && onMseAssemble) {
        const req = JSON.parse(ev.detail || '{}');
        const reply = onMseAssemble(req) || { ok: true, size: 1 };
        const back = new CustomEvent('__mg_assemble_done', { detail: JSON.stringify(reply) });
        for (const fn of [...(docListeners['__mg_assemble_done'] || [])]) fn(back);
      }
      return true;
    },
  };

  const location = {
    href: page,
    origin: pageUrl.origin,
    hostname: pageUrl.hostname,
    reload() { reloads += 1; },
  };

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage(msg, cb) {
        msgs.push(msg);
        let reply = { ok: true };
        if (msg.type === 'getSettings') reply = { ok: true, settings: {} };
        // poll 的回复可被测试覆盖。background 的 pollJob 原样返回 job record
        // （`Object.assign({}, record, {host, ok:true})`），content.js 的 tick()
        // 直接把它喂给 render() —— 所以桩只要回 record 的形状就对了。
        else if (msg.type === 'poll') reply = Object.assign({ ok: true }, pollReply);
        else if (msg.type === 'start') {
          reply = startReply || { ok: true, jobId: 'mgjob1' };
        }
        // poll 的回复可被测试覆盖：background 会把 job record 原样回传
        // （`Object.assign({}, record, {host, ok:true})`），而 content.js 的
        // tick() 直接把它喂给 render()。
        else if (msg.type === 'poll') reply = Object.assign({ ok: true }, pollReply);
        else if (msg.type === 'start') {
          if (startReply) reply = startReply;
          else reply = { ok: true, jobId: 'mgjob1' };
        }
        else if (msg.type === 'getHealth') reply = { ok: true, hasWebRequest: true, hasDownloads: true, hasSessionStorage: true, bootErrors: [] };
        else if (msg.type === 'getNetLog') reply = { ok: true, urls: [], events: 4, tabUrls: 0, sharedUrls: 0, unscopedUrls: 0 };
        else if (msg.type === 'pageState') {
          states.push(msg.state);
          const pending = waiters.splice(0);
          for (const fn of pending) fn(msg.state);
        }
        if (typeof cb === 'function') cb(reply);
        return Promise.resolve(reply);
      },
    },
  };

  // 每个世界一个 URL 类，但 blob URL 空间是**共享**的 —— 页面世界 createObjectURL
  // 出来的地址，隔离世界（经由 <a download>）要能取到同一个 Blob。
  function mkURL() {
    class TestURL extends URL {}
    TestURL.createObjectURL = (obj) => {
      const u = `blob:test/${objectUrls.size}`;
      objectUrls.set(u, obj);
      return u;
    };
    TestURL.revokeObjectURL = () => {};
    return TestURL;
  }

  const opfsStorage = {
    async getDirectory() {
      if (storageMode === 'throw') throw new Error('OPFS 不可用（桩）');
      return makeOpfsRoot(opfs);
    },
  };

  // MSE 桩：页面世界自己 appendBuffer，钩子会留副本。
  class FakeSourceBuffer { appendBuffer() {} }
  class FakeMediaSource {
    addSourceBuffer(mime) { const sb = new FakeSourceBuffer(); sb.__mime = mime; return sb; }
    endOfStream() {}
  }
  class FakeXHR {
    constructor() { this._l = new Map(); this.responseType = ''; this.responseText = ''; }
    open() {}
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  }

  // 桩的 console 必须**不会自己抛**：无原型对象（Object.create(null)）、
  // Symbol、BigInt 都能把 String() 弄炸。浏览器里的 console 不挑食，
  // 桩要是比浏览器更挑，就会把"日志把导出打断"这种真 bug 伪装成别的错。
  const safeStr = (x) => {
    try { return String(x); } catch (e) { return '[unprintable]'; }
  };
  const sandboxConsole = {
    log: (...a) => logs.push(['log', a.map(safeStr).join(' ')]),
    info: (...a) => logs.push(['info', a.map(safeStr).join(' ')]),
    warn: (...a) => logs.push(['warn', a.map(safeStr).join(' ')]),
    error: (...a) => logs.push(['error', a.map(safeStr).join(' ')]),
  };

  const setTimeoutU = (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (t && t.unref) t.unref();
    return t;
  };

  // sessionStorage 的默认实现：每次调用 makeEnv 都是一份**新**的存储，
  // 正好对应"标签页会话"。要测"刷新"就把同一个对象传给前后两次 makeEnv。
  const sessionStorage = optSessionStorage || (() => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  })();

  const common = {
    console: sandboxConsole,
    document, location, sessionStorage,
    performance: { setResourceTimingBufferSize() {}, getEntriesByType: () => [] },
    URL: mkURL(), Blob, CustomEvent, Uint8Array, ArrayBuffer,
    setTimeout: setTimeoutU, clearTimeout,
    // ⚠️ setInterval **必须真的会跑**，否则 content.js 里的
    //    `pollTimer = setInterval(tick, 1200)` 永远不触发 —— 于是
    //    render() / publish() 这条链在测试里**完全没被执行过**，
    //    yt-dlp 的进度显示也因此"看起来没 bug"（1.9.1 实测卡在"正在启动"）。
    //
    //    之前这里是 `() => 0`（no-op），本意是"别让事件循环被定时器占住"，
    //    但那等于把一整条真实链路排除在测试之外。用**真实定时器** +
    //    unref 是正解：定时器照跑，但不阻止进程退出。
    //
    //    unref 只在这里用（被测代码自己的等待定时器绝不能 unref）。
    setInterval: (fn, ms) => {
      const t = setInterval(fn, ms);
      if (t && typeof t.unref === 'function') t.unref();
      liveIntervals.set(t, ms);
      return t;
    },
    clearInterval: (t) => {
      if (t) liveIntervals.delete(t);
      clearInterval(t);
    },
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  };

  // ---- 页面世界（MAIN）-----------------------------------------------------
  // 关键：这里的 fetch 会被页面自己的 Service Worker 拦截并兑现字节。
  // rangeFetch.js / staging.js / hooks.js 都装在这一侧，整片拉取在这里执行。
  const mainSandbox = {
    ...common,
    navigator: { storage: opfsStorage },
    MediaSource: FakeMediaSource,
    SourceBuffer: FakeSourceBuffer,
    XMLHttpRequest: FakeXHR,
    fetch: async (url, init) => {
      mainCalls.push({ url, range: String((init && init.headers && init.headers.Range) || '') });
      return mainFetch(url, init);
    },
  };
  mainSandbox.window = mainSandbox;
  mainSandbox.globalThis = mainSandbox;
  const mainCtx = vm.createContext(mainSandbox);
  if (withMain) {
    vm.runInContext(STAGING_SRC, mainCtx, { filename: 'staging.js' });
    vm.runInContext(RANGE_SRC, mainCtx, { filename: 'rangeFetch.js' });
    vm.runInContext(HOOKS_SRC, mainCtx, { filename: 'hooks.js' });
  }

  // ---- 隔离世界（content script）------------------------------------------
  // 关键：它的 fetch **不会**被页面 SW 拦截 —— 桩直接返回 302，与 v1.5.2 实测一致。
  const isoSandbox = {
    ...common,
    chrome,
    navigator: { storage: opfsStorage },
    fetch: async (url, init) => {
      isoCalls.push({ url, range: String((init && init.headers && init.headers.Range) || '') });
      return makeResp({ status: isoStatus });
    },
  };
  isoSandbox.window = isoSandbox;
  isoSandbox.globalThis = isoSandbox;
  const isoCtx = vm.createContext(isoSandbox);
  vm.runInContext(SITES_SRC, isoCtx, { filename: 'sites.js' });
  vm.runInContext(STAGING_SRC, isoCtx, { filename: 'staging.js' });
  vm.runInContext(RANGE_SRC, isoCtx, { filename: 'rangeFetch.js' });
  vm.runInContext(CONTENT_SRC, isoCtx, { filename: 'content.js' });

  const env = {
    context: isoCtx, mainCtx, logs, msgs, states, downloads, opfs, dispatches, videos,
    isoCalls, mainCalls, withMain,
    get reloads() { return reloads; },
    /**
     * 手动驱动一次轮询（与真实链路同一个 tick）。
     *
     * 面板的进度不是由 pageStatus 驱动的，而是 content.js 里
     * `pollTimer = setInterval(tick, 1200)`。桩的 setInterval 是 no-op
     * （不然事件循环永远不空、测试挂死），所以这里手动调一次 ——
     * 走的仍是真实的 tick → send({type:'poll'}) → render()。
     */
    /**
     * 手动等一次轮询周期（1200ms）。
     *
     * content.js 的 `pollTimer = setInterval(tick, 1200)` 现在**真的会跑**
     * （桩的 setInterval 改成了真定时器），所以进度会随时间自己更新。
     * 这个方法只是"等一会儿再看状态"。
     *
     * ⚠️ 每个用例之间**必须** destroy()：否则上一个用例留下的轮询定时器会
     * 在下一个用例里继续跑，把自己那份 pollReply 打到新的 content script 上，
     * 于是状态被覆盖成 `running`（这个坑真的踩到了，用例 12/25 全红）。
     */
    async tick(ms = 1400) {
      await settle(ms);
      return env.lastState();
    },
    /**
     * 驱动一轮轮询后，**立刻**取回快照（不等 700ms 的兜底 publish）。
     *
     * content.js 里有两条发布路径：tick 里的 publish(true)（跟着进度走）与
     * `setInterval(publish, 700)`（兜底）。断言"进度有没有被上报"时必须
     * 只看第一条 —— 否则第二条会把第一条的缺失掩盖掉，断言恒真。
     */
    async snapshotAfterTick() {
      await settle(1320);          // 略大于 1200ms 的轮询周期
      const r = env.fire({ type: 'pageStatus' });
      return r && r.state;
    },
    /**
     * 只数「tick 自己发的」pageState 消息。
     *
     * ⚠️ content.js 里有两条发布路径：tick 里的 `publish(true)`（跟着进度走）
     * 与 `setInterval(publish, 700)`（兜底）。第二条会在任何 700ms 边界上把
     * 快照补上 —— 于是"tick 到底 publish 没有"这条断言恒真（R26 第一次报
     * 「仍然全过」就是这个原因：拿 pageStatus 的返回值当判据更糟，它是
     * buildState() 当场造的，与 publish 无关）。
     *
     * 办法：**在两条定时器之间取样**。轮询周期 1200ms、兜底周期 700ms，
     * 所以在 tick 触发后的 ~250ms 内（远早于下一个 700ms 边界）统计
     * pageState 消息数，只有 tick 那条路径来得及发。
     */
    countPageStates() {
      return env.msgs.filter((x) => x.type === 'pageState').length;
    },
    /** 清掉本会话的定时器（用例收尾必调）。 */
    destroy() {
      for (const t of liveIntervals.keys()) { try { clearInterval(t); } catch (e) { /* ignore */ } }
      liveIntervals.clear();
    },
    /**
     * 停掉周期为 ms 的那个定时器（用来隔离被测的那条路径）。
     *
     * 例：停掉 700ms 的兜底 publish，于是只剩 tick 里的 publish 在发消息 ——
     * 这时"tick publish 缺席"才是可观测的。
     */
    stopTimer(ms) {
      let n = 0;
      for (const [t, period] of [...liveIntervals]) {
        if (Number(period) !== Number(ms)) continue;
        try { clearInterval(t); } catch (e) { /* ignore */ }
        liveIntervals.delete(t);
        n += 1;
      }
      return n;
    },
    /** 覆盖 poll 的回复（模拟 background 处于某个阶段）。 */
    setPollReply(r) { pollReply = r || {}; },
    /** 覆盖 start 的回复。 */
    setStartReply(r) { startReply = r; },
    /** 走真实的消息入口（popup 点按钮发的那条）。 */
    fire(msg) {
      if (!listener) throw new Error('content.js 没有注册 onMessage 监听');
      let out = null;
      listener(msg, { id: 'test-extension-id', tab: { id: 1 }, url: page }, (r) => { out = r; });
      return out;
    },
    nextState(ms = 5000) {
      // ⚠️ 这个超时**不能** unref：整条链路是纯 promise 的，一旦哪一环永远不
      // resolve，事件循环里就什么都不剩，Node 会以 exit 0 静默退出 —— 测试看起来
      // "通过"了，其实什么都没跑。这个坑我踩过一次。
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('超时：没有等到 pageState')), ms);
        waiters.push((s) => { clearTimeout(t); resolve(s); });
      });
    },
    lastState: () => states[states.length - 1] || null,
    logText: () => logs.map((l) => l[1]).join('\n'),
    hasLog: (re) => logs.some((l) => re.test(l[1])),
    /**
     * 模拟"播放器开始请求某条流"。
     *
     * 这是候选被记下来的**唯一真实途径**：MAIN world 的钩子包了 `window.fetch`，
     * 页面的每一次请求都会经过它 → `record()` → 写 `dataset.mgUrls`。
     * 测试里直接改 dataset 是不行的：钩子的 flush 会用自己那份列表覆盖回去
     * （第一版就这么写，于是"切到 B"那步被悄悄抹掉，用例照出的是 A）。
     */
    async playerFetch(url) {
      try { return await mainSandbox.fetch(url, { headers: { Range: 'bytes=0-0' } }); }
      catch (e) { return null; }
    },
    /** 喂给页面世界的 MSE 钩子：真的走 MediaSource + SourceBuffer.appendBuffer。 */
    appendMse(chunks) {
      const ms = new mainSandbox.MediaSource();
      const href = mainSandbox.URL.createObjectURL(ms);
      const sb = ms.addSourceBuffer('video/mp4');
      for (const c of chunks) sb.appendBuffer(c);
      if (videos[0]) { videos[0].src = href; videos[0].currentSrc = href; }
      return href;
    },
    /** 下载完成的统一判据：等 pageState，再让尾随的第二次 publish 落地。 */
    async download(opts2 = {}) {
      const p = env.nextState();
      env.fire({ type: 'pageDownload', quality: 'best', mode: 'browser', outDir: '', ...opts2 });
      await p;
      await settle();
      return env.lastState();
    },
    async savedBytes() {
      const out = [];
      for (const d of downloads) out.push(new Uint8Array(await d.blob.arrayBuffer()));
      return out;
    },
  };
  // 新会话诞生时，把**所有**旧会话的定时器清掉。见函数上方的说明。
  for (const e of liveEnvs) e.destroy();
  liveEnvs.push(env);
  return env;
}

// ── 用例 ──────────────────────────────────────────────────────────────────

async function main() {
  const HLS_SIZE = 5 * MB + 777;          // 跨越多个 1MiB fragment，且带非对齐尾巴
  const hlsWhole = makeWhole(HLS_SIZE);
  // 带上 tweb 为绕 Chrome bug 追加的标记 —— 归一化必须把它剥掉，否则 Service Worker
  // 会走 patchChromiumMp4() 返回改过字节的补丁版。**这条断言曾经是空的**：
  // URL 上压根没这个 query，断言恒真，是反向验证把它照出来的。
  const HLS_URL = twebUrl(HLS_SIZE, 'movie.MP4', 'hls_stream', '?_crbug1250841=1');

  console.log('=== 1. 长视频走 /hls_stream/：第一条候选 5xx → 回退到第二条，成功交付 ===');
  {
    const STREAM_SIZE = 9_000_000;        // 声明更大 → 会被优先选中（也是要失败的那条）
    const streamUrl = twebUrl(STREAM_SIZE, 'movie.MP4', 'stream');
    const impl = async (url, init) => {
      impl.ranges.push({ url, range: String(init.headers.Range) });
      if (/\/stream\//.test(url)) return makeResp({ status: 500 });
      return hlsEndpoint(hlsWhole)(url, init);
    };
    impl.ranges = [];

    const env = makeEnv({ mgUrls: [streamUrl, HLS_URL].join('|'), mgMse: 12_000_000, mainFetch: impl });
    const state = await env.download();
    const saved = await env.savedBytes();

    check('交付了且只交付了一个文件', env.downloads.length === 1, `downloads=${env.downloads.length}`);
    check('文件名取自端点 URL 的 fileName 字段', env.downloads[0] && env.downloads[0].name === 'movie.MP4',
      env.downloads[0] && env.downloads[0].name);
    check('落地字节逐字节等于源', sameBytes(saved[0], hlsWhole),
      saved[0] ? `${saved[0].byteLength}/${HLS_SIZE}` : 'no bytes');
    // ↓ 这条就是「点一次弹两次另存为、都是 0 字节」的回归闸门：
    //   探测失败的候选绝不能建出文件来。
    check('探测失败的候选没有建任何文件（暂存条目只建了 1 个）',
      env.opfs.created.length === 1, JSON.stringify(env.opfs.created));
    check('成功路径没有 abort 残骸', env.opfs.aborted.length === 0, JSON.stringify(env.opfs.aborted));
    check('状态是完成且色调为 ok', state && state.phase === 'done' && state.tone === 'ok',
      JSON.stringify({ phase: state && state.phase, tone: state && state.tone }));
    check('消息里报了「已保存」', /已保存/.test((state && state.message) || ''), (state && state.message) || '');
    // 单位口径：1024 进制必须标 MiB，并且同时给出精确字节数 ——
    // v1.6.0 首日「面板 73MB / Finder 77.1MB」的疑问就是这么来的。
    check('单位标成 MiB（不是 MB）', /MiB/.test((state && state.message) || '')
      && !/\d\s?MB/.test((state && state.message) || ''), (state && state.message) || '');
    check('同时给出精确字节数（带千分位）', /[\d,]+\s?字节/.test(state.message), state.message);
    check('精确字节数与实际交付的字节数一致',
      state.message.includes(`${saved[0].byteLength.toLocaleString('en-US')} 字节`),
      `${saved[0].byteLength} vs ${state.message}`);
    check('摘要行按真实交付结果重写（不再显示别的档位的"整片约"）',
      /浏览器下载/.test((state && state.meta) || '') && /字节/.test((state && state.meta) || ''),
      (state && state.meta) || '');

    // Range 语义：首轮探测用开区间，之后**必须**全是闭区间（否则 /hls_stream/ 每轮 1 字节）
    const chunk = impl.ranges.filter((r) => r.range !== 'bytes=0-0');
    // extra 只列前若干条：反向验证（Range 退化成开区间）时会跑满 MAX_CHUNKS，
    // 全量打印两万条会把输出淹掉。
    const head = chunk.slice(0, 6).map((r) => r.range);
    check('带 Range 的请求里没有开区间（除首轮）',
      chunk[0].range === 'bytes=0-' && chunk.slice(1).every((r) => /^bytes=\d+-\d+$/.test(r.range)),
      `${JSON.stringify(head)}${chunk.length > head.length ? ` …共 ${chunk.length} 轮` : ''}`);
    check(`轮数受控（没有退化成"每轮 1 字节"）：${chunk.length} 轮`, chunk.length <= 5, String(chunk.length));
    check('URL 里的 ?_crbug1250841 被剥掉了（否则 SW 会返回改过字节的补丁版本）',
      impl.ranges.every((r) => !/_crbug1250841/.test(r.url)));
    // ↓↓ v1.5.2 的根本原因守卫：隔离世界的 fetch 不被页面 SW 拦截（实测 302），
    // 所以整片拉取**必须**在页面世界执行。这里的隔离 fetch 一次都不能被调用。
    check('隔离世界一次请求都没发（字节只在页面世界拉）',
      env.isoCalls.length === 0, JSON.stringify(env.isoCalls.map((c) => c.range)));
    check('页面世界发起了请求（探测 + 分块）', env.mainCalls.length >= 2, String(env.mainCalls.length));
  }

  console.log('\n=== 2. 两条候选探测全失败：不建文件、不自动导出缓存、把原因留在面板上 ===');
  {
    const streamUrl = twebUrl(9_000_000, 'movie.MP4', 'stream');
    const impl = async () => makeResp({ status: 500 });
    // 缓存 3MB < 端点声明的 8.6MB —— 走「已缓存 X / 整片约 Y（Z%）」那个分支。
    const env = makeEnv({ mgUrls: [streamUrl, HLS_URL].join('|'), mainFetch: impl });
    await feedCache(env, 3_000_000);
    const state = await env.download();

    check('一个文件都没建（探测失败 = 不落盘）', env.opfs.created.length === 0, JSON.stringify(env.opfs.created));
    check('没有交付任何文件', env.downloads.length === 0, String(env.downloads.length));
    check('状态是失败', state && state.phase === 'error', JSON.stringify({ phase: state && state.phase }));
    check('消息里明确写了「未生成文件」', /未生成文件/.test((state && state.message) || ''), (state && state.message) || '');
    check('消息里报出了「已缓存 / 整片」的比例',
      /已缓存/.test((state && state.message) || '') && /整片约/.test((state && state.message) || ''),
      (state && state.message) || '');
    check('按钮被改成「改用播放器缓存导出」（等用户主动点）', state && state.action === 'mse',
      JSON.stringify(state && state.action));
    // ↓ 「下载下来只有 5 秒」的根治点：失败之后**不能**悄悄拿缓存顶替整片
    check('整片下载失败时没有自动导出播放器缓存', assembles(env).length === 0,
      JSON.stringify(assembles(env).map((d) => d.type)));
  }

  console.log('\n=== 3. 服务端提前结束流（声明完整、实收不足）：不交付半截文件、清掉暂存 ===');
  {
    // 探针说总长 = HLS_SIZE，实际只肯给到 1MiB 就谎报区间
    const cut = MB;
    const impl = hlsEndpoint(hlsWhole, ({ lower, body }) => {
      if (lower < cut && lower + body.byteLength > cut) {
        // 谎报 bytes lower-upper/size，但只给到 cut —— 正是"能播几秒就没了"的机械版本
        return makeResp({
          contentRange: `bytes ${lower}-${lower + body.byteLength - 1}/${HLS_SIZE}`,
          contentLength: null,
          body: body.slice(0, cut - lower),
        });
      }
      if (lower >= cut) {
        const short = body.slice(0, Math.min(100, body.byteLength));
        return makeResp({
          contentRange: `bytes ${lower}-${lower + short.byteLength - 1}/${HLS_SIZE}`,
          contentLength: null,
          body: short,
        });
      }
      return null;
    });
    const env = makeEnv({ mgUrls: HLS_URL, mainFetch: impl });
    await feedCache(env, 12_000_000);
    const state = await env.download();

    check('没有交付任何文件（宁可报错也不给半截）', env.downloads.length === 0, String(env.downloads.length));
    check('建过的暂存条目被清掉了（不留 0 字节残骸）',
      env.opfs.created.length === 1 && env.opfs.removed.length === 1,
      JSON.stringify({ created: env.opfs.created, removed: env.opfs.removed }));
    check('abort 了写入器', env.opfs.aborted.length === 1, JSON.stringify(env.opfs.aborted));
    check('失败原因里带上了真实字节数或长度不符',
      /字节数不足|字节数与文件声明不符|分块长度不符|响应体不完整/.test((state && state.message) || ''),
      (state && state.message) || '');
    check('仍然没有自动导出播放器缓存', assembles(env).length === 0,
      JSON.stringify(assembles(env).map((d) => d.type)));
    // 12MB 缓存 > 5MB 片长：不能写「已缓存 229%」（那是在制造困惑），
    // 要说清"这份缓存里混着本页其它视频的字节"。
    check('缓存比声明还大时不写百分比，而是说清混着别的视频',
      /比端点声明的整片/.test((state && state.message) || '') && !/%/.test((state && state.message) || ''),
      (state && state.message) || '');
    check('把现场信息（detail）打进了 Console', env.hasLog(/分块下载失败|端点探测失败/), '');
  }

  console.log('\n=== 4. 用户主动点「改用播放器缓存导出」：真钩子 + box 去重 ===');
  {
    // 这一条现在跑的是**真的 hooks.js**：真的 MediaSource / SourceBuffer /
    // appendBuffer，真的 exportAssembly 与 stripExtraInit。
    // 分片序列照 HLS 的真实形态：播放器重建 MediaSource 时会再 append 一遍
    // ftyp+moov —— 不剥离的话，文件能打开、时长栏是全片，却只播第一个 init
    // 描述的那几秒（v1.5.1 的病根）。
    const init = seg(box('ftyp', 32), box('moov', 64));
    const seg1 = seg(box('moof', 24), box('mdat', 4096));
    const seg2 = seg(box('moof', 24), box('mdat', 4096));
    const seg3 = seg(box('moof', 24), box('mdat', 2048));
    const chunks = [init, seg1, seg2, init, seg3];

    const env = makeEnv({
      mgUrls: HLS_URL,
      mgMse: 0,                 // 让真钩子自己写 dataset（下面 appendMse 之后）
      mgEos: 0,                  // 播放器没报流结束 → 必须标 .partial
      mainFetch: async () => makeResp({ status: 500 }),
    });
    env.appendMse(chunks);
    await settle(320);           // 等真钩子的 200ms flush 把 mgMse 写进 dataset
    check('真钩子把捕获字节写进了 dataset', Number(env.context.document.documentElement.dataset.mgMse) > 0,
      String(env.context.document.documentElement.dataset.mgMse));

    const fail = await env.download();
    check('整片下载失败（端点 500）', fail && fail.action === 'mse', JSON.stringify(fail && fail.action));

    const p = env.nextState();
    env.fire({ type: 'pageMseExport' });
    await p;
    await settle();
    const state = env.lastState();
    const saved = await env.savedBytes();

    check('这次确实走了 MAIN world 的拼装通道', assembles(env).length === 1,
      JSON.stringify(assembles(env).map((d) => d.type)));
    const fname = assembles(env)[0] && JSON.parse(assembles(env)[0].detail).filename;
    check('文件名带 .partial（没看到 endOfStream 就不能冒充完整片）',
      !!fname && /\.partial\.mp4$/.test(fname), String(fname));
    check('消息里报出「已剥离 1 个重复流头」', /已剥离 1 个重复流头/.test(state.message), state.message);
    check('消息里报出片长与已缓冲位置',
      /片长 10:12/.test(state.message) && /已缓冲至 0:05/.test(state.message), state.message);
    check('交付了且只交付了一个缓存文件', env.downloads.length === 1, String(env.downloads.length));
    // 逐字节核对：第二个 init 段（ftyp+moov）必须被剥掉，其余一个字节不少。
    const expected = concat([init, seg1, seg2, seg3]);
    check('导出字节 = 源字节 − 被剥离的重复初始化段',
      sameBytes(saved[0], expected), saved[0] ? `${saved[0].byteLength}/${expected.byteLength}` : 'no bytes');
  }

  console.log('\n=== 5. OPFS 不可用 → 回落内存打包，仍然只交付一个正确文件 ===');
  {
    const impl = hlsEndpoint(hlsWhole);
    const env = makeEnv({ mgUrls: HLS_URL, mainFetch: impl, storageMode: 'throw' });
    const state = await env.download();
    const saved = await env.savedBytes();

    check('没有建 OPFS 条目', env.opfs.created.length === 0, JSON.stringify(env.opfs.created));
    check('交付了且只交付了一个文件', env.downloads.length === 1, String(env.downloads.length));
    check('内存打包的字节同样逐字节正确', sameBytes(saved[0], hlsWhole),
      saved[0] ? `${saved[0].byteLength}/${HLS_SIZE}` : 'no bytes');
    check('日志里说明了回落原因', env.hasLog(/OPFS 暂存不可用/), '');
    check('状态是完成', state && state.phase === 'done', JSON.stringify(state && state.phase));
  }

  console.log('\n=== 6. 运行时流页面上请求 yt-dlp：页面地址绝不能被交给 yt-dlp ===');
  {
    const impl = hlsEndpoint(hlsWhole);
    const env = makeEnv({ mgUrls: HLS_URL, mgMse: 12_000_000, mainFetch: impl });
    const state = await env.download({ mode: 'ytdlp' });

    const startMsgs = env.msgs.filter((m) => m.type === 'start');
    check('没有向宿主发起 yt-dlp 任务（那会换来一句 Unsupported URL）',
      startMsgs.length === 0, JSON.stringify(startMsgs));
    check('被强制切回浏览器下载并完成了', env.downloads.length === 1, String(env.downloads.length));
    check('状态是完成', state && state.phase === 'done', JSON.stringify(state && state.phase));
  }

  console.log('\n=== 7. 只有 /stream/（progressive）一条候选也能整片下完 ===');
  {
    // progressive 端点的两个特点都要覆盖到：开区间会被**补全**（不会只回 1 字节），
    // 但单次最多回 1MiB —— 所以请求 4MiB 会被服务端切成 1MiB 一片，我们必须
    // 靠 Content-Range 逐片推进，而不是假设"一次要多少给多少"。
    const size = 3 * MB + 123;
    const whole = makeWhole(size);
    const url = twebUrl(size, 'clip.MP4', 'stream');
    const impl = streamEndpoint(whole);
    const calls = [];
    const wrapped = async (u, init) => { calls.push(String(init.headers.Range)); return impl(u, init); };

    const env = makeEnv({ mgUrls: url, mainFetch: wrapped });
    const state = await env.download();
    const saved = await env.savedBytes();
    // 注意 `bytes=0-0` 是 probeStream 的只读探测，不是分块请求 —— 要剔掉它再看首轮。
    const chunkCalls = calls.filter((r) => r !== 'bytes=0-0');

    check('先做了一次只读探测', calls[0] === 'bytes=0-0', JSON.stringify(calls[0]));
    check('交付字节逐字节等于源', sameBytes(saved[0], whole),
      saved[0] ? `${saved[0].byteLength}/${size}` : 'no bytes');
    check('分块首轮是开区间（还不知道总长），之后全是闭区间',
      chunkCalls[0] === 'bytes=0-' && chunkCalls.slice(1).every((r) => /^bytes=\d+-\d+$/.test(r)),
      JSON.stringify(chunkCalls));
    check(`服务端把 4MiB 请求切成 1MiB 也没被带偏（${chunkCalls.length} 轮）`,
      chunkCalls.length >= 4 && chunkCalls.length <= 6, String(chunkCalls.length));
    check('状态是完成', state && state.phase === 'done', JSON.stringify(state && state.phase));
  }

  console.log('\n=== 8. 页面上没有视频：quiet fail，不建文件不报错崩溃 ===');
  {
    const env = makeEnv({ withVideo: false, mgUrls: '' });
    const reply = env.fire({ type: 'pageDownload', quality: 'best', mode: 'browser', outDir: '' });
    await settle(30);
    check('同步回执明确说"没识别到"', reply && reply.ok === false && /识别到/.test(reply.error || ''),
      JSON.stringify(reply));
    check('没有建任何文件', env.opfs.created.length === 0 && env.downloads.length === 0);
  }

  console.log('\n=== 9. B 站这类 ytdlpOnly 站点：交给宿主，且页面 URL 完整传下去 ===');
  {
    // 浏览器通道在 B 站必然拿不到字节（DASH 分离 + CDN 校验 Referer），
    // 所以判据是「发了 mode=ytdlp 的 start 消息，且 url 是规范化后的页面地址」，
    // 同时**没有**任何文件被创建。
    const pageUrl = 'https://www.bilibili.com/video/BV1GJ411x7h7';
    const env = makeEnv({ page: pageUrl, withVideo: false, mgUrls: '' });
    env.fire({ type: 'pageDownload', quality: 'best', mode: 'browser', outDir: '' });
    await settle(30);
    const starts = env.msgs.filter((m) => m.type === 'start');
    check('向宿主提交了 yt-dlp 任务', starts.length === 1, JSON.stringify(starts));
    check('传给宿主的是规范化后的页面地址',
      starts[0] && starts[0].mode === 'ytdlp' && /^https:\/\/www\.bilibili\.com\/video\/BV1/.test(starts[0].url || ''),
      starts[0] && starts[0].url);
    check('浏览器通道一个文件都没建', env.opfs.created.length === 0 && env.downloads.length === 0);
  }

  console.log('\n=== 10. 暂存写不下（OPFS 配额）：说清原因、不留残骸、不交付半截 ===');
  {
    const impl = hlsEndpoint(hlsWhole);
    const env = makeEnv({ mgUrls: HLS_URL, mainFetch: impl, opfsWriteError: 'quota' });
    await feedCache(env, 2_000_000);
    const state = await env.download();

    check('没有交付任何文件', env.downloads.length === 0, String(env.downloads.length));
    check('暂存条目被清掉了（不留残骸）',
      env.opfs.created.length === 1 && env.opfs.removed.length === 1,
      JSON.stringify({ created: env.opfs.created, removed: env.opfs.removed }));
    check('消息里说清是"存储额度不够"，而不是让用户以为网络坏了',
      /存储额度不够/.test((state && state.message) || ''), (state && state.message) || '');
    check('仍然没有自动导出播放器缓存', assembles(env).length === 0,
      JSON.stringify(assembles(env).map((d) => d.type)));
  }

  console.log('\n=== 11. 连页面世界也被 302：说清"这条路在当前上下文走不通" ===');
  {
    // 页面世界拿到的也是 302 —— 例如页面自己的 SW 没注册 / 没控制这个页面。
    // 这时**不能**退回隔离世界再试一遍（那里必然也是 302），也不能只丢一句
    // "HTTP 302"：必须说清这是上下文问题、并给出该做的动作。
    const env = makeEnv({ mgUrls: HLS_URL, mainFetch: async () => makeResp({ status: 302 }) });
    await feedCache(env, 3_000_000);
    const state = await env.download();

    check('没有交付任何文件', env.downloads.length === 0, String(env.downloads.length));
    check('没有建任何文件', env.opfs.created.length === 0, JSON.stringify(env.opfs.created));
    check('没有退回隔离世界再试（那里必然也是 302）', env.isoCalls.length === 0,
      JSON.stringify(env.isoCalls.map((c) => c.range)));
    check('消息里点明是 Service Worker 没拦截，并给出该做的动作',
      /Service Worker/.test(state.message) && /刷新本页/.test(state.message), state.message);
    check('状态是失败且按钮变成「改用播放器缓存导出」',
      state.phase === 'error' && state.action === 'mse', JSON.stringify({ p: state.phase, a: state.action }));
  }

  console.log('\n=== 12. 页面世界没装钩子（扩展重载前页面就已加载）：兜底路径照实报 302 ===');
  {
    // withMain: false = MAIN world 一个脚本都没装 → 握手超时 → 走隔离世界兜底。
    // 兜底在 Telegram 上必然 302，面板必须照实说，不粉饰成"网络问题"。
    const env = makeEnv({ mgUrls: HLS_URL, withMain: false });
    await feedCache(env, 3_000_000);
    // 兜底失败后要等下一轮轮询（1200ms）才把失败态 render 出来。
    // 桩的 setInterval 现在是真定时器（必须真跑，否则 poll/render 整条链路
    // 在测试里根本没被执行过 —— yt-dlp 进度不显示的 bug 就是这么漏掉的），
    // 所以这里必须等够一个周期。
    const p0 = env.nextState();
    env.fire({ type: 'pageDownload', quality: 'best', mode: 'browser', outDir: '' });
    await p0;
    await env.tick();
    const state = env.lastState();

    check('确实退到了隔离世界（那里发了请求）', env.isoCalls.length > 0,
      String(env.isoCalls.length));
    check('隔离世界的请求全部是探测（没有建文件）',
      env.isoCalls.every((c) => c.range === 'bytes=0-0'), JSON.stringify(env.isoCalls.map((c) => c.range)));
    check('没有交付任何文件', env.downloads.length === 0 && env.opfs.created.length === 0);
    check('面板照实报出 302', /302/.test(state.message), state.message);
    // 扩展一更新，页面世界就少了 staging/rangeFetch 两个注入脚本 —— 用户看到的
    // 302 绝大多数是"该刷新本页"，必须先说该做的事。
    check('先说该做的事（刷新本页），而不是只丢一个 302',
      /页面世界没有响应/.test(state.message) && /刷新本页/.test(state.message), state.message);
    check('状态是失败', state.phase === 'error', JSON.stringify(state.phase));
  }

  console.log('\n=== 13. 真实形态的 HLS 端点（URL 无 fileName、路径不带 /k/）===');
  {
    // 用户 1.6.0 首日实测的 URL 形态：路径是 /hls_stream/（不是 /k/hls_stream/），
    // 参数里只有 docId/dcId/size/mimeType —— **没有 fileName**。
    // v1.6.0 的 MAIN 路径当时把兜底名写漏了，于是全部下载都叫 video.mp4。
    const url = twebUrlNoName(HLS_SIZE);
    const impl = hlsEndpoint(hlsWhole);
    const env = makeEnv({ mgUrls: url, mainFetch: impl });
    const state = await env.download();

    check('交付了且只交付了一个文件', env.downloads.length === 1, String(env.downloads.length));
    check('文件名用页面标题兜底，而不是 video.mp4',
      env.downloads[0] && env.downloads[0].name === 'Telegram_Web_·_演示视频.mp4',
      env.downloads[0] && env.downloads[0].name);
    check('没有把 /hls_stream/ 误认成需要排除的 playlist 端点',
      /已保存/.test(state.message), state.message);
  }

  console.log('\n=== 14. 诊断信息自洽：候选数与 bestUrl 同一口径 ===');
  {
    // 1.6.0 首日的诊断里出现过「候选总数: 0」却同时给出一条 hls_stream 地址 ——
    // 因为计数取自 sniffer、bestUrl 现算 sniffDirect()。这种自相矛盾会让排查多绕一圈。
    const env = makeEnv({ mgUrls: HLS_URL, mainFetch: hlsEndpoint(hlsWhole) });
    // 候选是 collectStreamUrl() 异步收进 streamCollector 的，pageDetect 直接
    // 同步回话 —— 真实场景页面早就开着，这里必须等它收完，否则读到 0 条。
    await settle();
    const reply = env.fire({ type: 'pageDetect' });
    const sum = reply && reply.summary;
    check('pageDetect 回得通', !!(reply && reply.ok && sum), JSON.stringify(reply && reply.ok));
    check('候选已收进 streamCollector', sum && sum.candidates > 0, String(sum && sum.candidates));
    check('有 bestUrl 时候选数不可能是 0',
      !sum || !sum.bestUrl || sum.candidates > 0,
      JSON.stringify({ bestUrl: sum && !!sum.bestUrl, candidates: sum && sum.candidates }));
    check('同源流端点数与声明大小条数一致',
      !sum || sum.streams === sum.streamSizes.length,
      JSON.stringify({ streams: sum && sum.streams, sizes: sum && sum.streamSizes.length }));
  }

  console.log('\n=== 15. 选中档：同 docId 才按体积映射，否则只认"最近被请求过的" ===');
  {
    // 真实语义（Telegram 的端点形态）：
    //   · 每个画质档位是**独立的 docId**（不同文档），URL 里没有分辨率也没有档位名；
    //   · 一个页面会先后播放多个视频，候选集里堆着整页历史。
    // 所以：**没有 docId 可依据时，只认"最近被请求过的那条"**，
    // 绝不用体积去猜"哪个是当前画质"（1.7.0 实测因此连下三次都是同一条视频）。
    const sizes = [127 * MB, 64 * MB, 40 * MB, 20 * MB];
    const urls = sizes.map((n, i) => twebVariantUrl(n, `doc-${i}`, `q${i}.MP4`));
    const env = makeEnv({ mgUrls: urls.join('|'), mainFetch: hlsEndpoint(hlsWhole) });
    await settle();

    // 记录顺序即时间顺序 → 最后一条最新 → 应当选它（20 MiB 那个），而不是最大的
    const best = env.fire({ type: 'pageDetect', quality: 'best' });
    check('不同 docId 时选的是最近被请求的那条，不是体积最大的',
      best.summary.selectedSize === 20 * MB && best.summary.selectedUrl === urls[3],
      `${best.summary.selectedSize} vs ${20 * MB}`);

    const anyQ = env.fire({ type: 'pageDetect', quality: '720' });
    check('换个画质档位也不会改目标（不同 docId = 不同视频，不存在"另一档"）',
      anyQ.summary.selectedUrl === urls[3], String(anyQ.summary.selectedUrl).slice(-24));
    check('档位列表只列当前那一条（不把别的视频当"另一档画质"）',
      anyQ.summary.variants.length === 1, JSON.stringify(anyQ.summary.variants));
  }

  console.log('\n=== 15b. 同一个 docId 的多个档位：这时才可以按体积映射 ===');
  {
    const sizes = [128 * MB, 64 * MB, 40 * MB, 20 * MB];
    const urls = sizes.map((n, i) => twebVariantUrl(n, 'same-doc', `q${i}.MP4`));
    const env = makeEnv({ mgUrls: urls.join('|'), mainFetch: hlsEndpoint(hlsWhole) });
    await settle();

    const best = env.fire({ type: 'pageDetect', quality: 'best' });
    check('best 档选中的是最大那条', best.summary.selectedSize === 128 * MB,
      String(best.summary.selectedSize));
    const sel = env.fire({ type: 'pageDetect', quality: '720' });
    check("'720' 档选中的是第二大的那条", sel.summary.selectedSize === 64 * MB,
      `${sel.summary.selectedSize} vs ${64 * MB}`);
    const low = env.fire({ type: 'pageDetect', quality: '480' });
    check("'480' 档选中的是第三大的那条", low.summary.selectedSize === 40 * MB,
      String(low.summary.selectedSize));
    const unknown = env.fire({ type: 'pageDetect', quality: '不存在的档位' });
    check('未知画质安全回落到最高档（而不是崩掉或选到 0 字节档）',
      unknown.summary.selectedSize === 128 * MB, String(unknown.summary.selectedSize));
    check('候选集与声明大小条数仍然一致',
      sel.summary.streams === 4 && sel.summary.streamSizes.length === 4,
      JSON.stringify({ streams: sel.summary.streams, n: sel.summary.streamSizes.length }));
    check('bestUrl 指向选中档那一条', sel.summary.bestUrl === urls[1],
      sel.summary.bestUrl.slice(-26));
    check('四个档位都列出来了（可让用户按体积挑）',
      sel.summary.variants.length === 4, JSON.stringify(sel.summary.variants.length));
  }

  console.log('\n=== 16. 普通 https 直链（X 等）也走页面世界，不交给 chrome.downloads ===');
  {
    // 1.6.1 实测：X 视频页「下载一直卡在等待中」，而 Rayburst 自己弹了
    // 「下载完成」—— 因为那条路是 chrome.downloads（渲染器发起的 https），
    // 下载管理器扩展按设计接管它（motrix-next-extension/lib/download/filter.ts：
    // scheme 阶段只放行 http/https）。我们全程看不到进度。
    const size = 12 * MB + 345;
    const whole = makeWhole(size);
    const mp4 = 'https://video.twimg.com/amplify_video/1234567890/vid/avc1/1280x720/f8VZ8aMmpYs4.mp4';
    const env = makeEnv({
      page: 'https://x.com/someone/status/1899999999999999999',
      mgVideos: mp4,
      mainFetch: plainCdn(whole),
    });
    const state = await env.download();
    const saved = await env.savedBytes();

    check('交付了且只交付了一个文件', env.downloads.length === 1, String(env.downloads.length));
    check('字节逐字节等于源', sameBytes(saved[0], whole),
      saved[0] ? `${saved[0].byteLength}/${size}` : 'no bytes');
    // ↓ 这条是本用例的核心：一旦走 startDirect，Rayburst 就会接管，进度对我们变瞎。
    check('没有把 URL 交给 chrome.downloads（下载管理器就无从接管）',
      env.msgs.filter((m) => m.type === 'startDirect').length === 0,
      JSON.stringify(env.msgs.filter((m) => m.type === 'startDirect')));
    check('隔离世界依然零请求', env.isoCalls.length === 0,
      JSON.stringify(env.isoCalls.map((c) => c.range)));
    check('消息里报了已保存与精确字节数', /已保存/.test(state.message) && /字节/.test(state.message),
      state.message);
  }

  console.log('\n=== 17. 直链被 CORS 挡住时，如实回落 Chrome 下载器 ===');
  {
    // 跨域 CDN 没 ACAO 头 → 页面世界的 fetch 失败。这是必须保留的退路，
    // 但要说清"页面内拉取失败"而不是静默换路。
    const mp4 = 'https://video.twimg.com/amplify_video/1234567890/vid/avc1/1280x720/f8VZ8aMmpYs4.mp4';
    const env = makeEnv({
      page: 'https://x.com/someone/status/1899999999999999999',
      mgVideos: mp4,
      mainFetch: async () => { throw new TypeError('Failed to fetch'); },
    });
    const state = await env.download();

    check('回落到 chrome.downloads（startDirect）',
      env.msgs.filter((m) => m.type === 'startDirect').length === 1,
      JSON.stringify(env.msgs.filter((m) => m.type === 'startDirect').map((m) => m.url)));
    check('面板说明了"页面内拉取失败"再回落，不是静默换路',
      /页面内拉取失败/.test(state.message), state.message);
  }

  console.log('\n=== 18. 文件名分级：拒绝"Telegram_Web.mp4"这种无意义名字 ===');
  {
    // 1.7.0 实测：下出来叫 Telegram_Web.mp4 —— 那是 document.title，
    // 同一站点下所有文件都叫这个。用户要求"用原文件名或相关的名字"。
    const url = twebUrlNoName(HLS_SIZE);
    const env = makeEnv({
      pageTitle: 'Telegram Web',      // 无意义标题
      mgUrls: url,
      mainFetch: hlsEndpoint(hlsWhole),
    });
    await env.download();
    const name = env.downloads[0] && env.downloads[0].name;

    check('不再产出 Telegram_Web.mp4',
      name !== 'Telegram_Web.mp4' && name !== 'Telegram_Web_.mp4', String(name));
    check('兜底名形如 telegram_YYYYMMDD-HHMMSS_docId尾6.mp4',
      /^telegram_\d{8}-\d{6}_\d{6}\.mp4$/.test(name || ''), String(name));
    check('站点标签取的是 telegram 而不是 org（web.telegram.org 的倒数第二段）',
      /^telegram_/.test(name || ''), String(name));
    check('兜底名带上了 docId 尾 6 位（可回溯、同页不重名）',
      /_\d{6}\.mp4$/.test(name || ''), String(name));
  }

  console.log('\n=== 19. 文件名分级：URL 原名 > 有意义的页面标题 ===');
  {
    const envA = makeEnv({
      pageTitle: 'Telegram Web',
      mgUrls: twebUrl(HLS_SIZE, '原名视频.MP4', 'hls_stream'),
      mainFetch: hlsEndpoint(hlsWhole),
    });
    await envA.download();
    check('URL 里的 fileName 优先', envA.downloads[0] && envA.downloads[0].name === '原名视频.MP4',
      envA.downloads[0] && envA.downloads[0].name);

    const envB = makeEnv({
      pageTitle: '产品发布会 完整录屏',
      mgUrls: twebUrlNoName(HLS_SIZE),
      mainFetch: hlsEndpoint(hlsWhole),
    });
    await envB.download();
    check('有意义的页面标题可用', envB.downloads[0] && envB.downloads[0].name === '产品发布会_完整录屏.mp4',
      envB.downloads[0] && envB.downloads[0].name);
  }

  console.log('\n=== 20. 同一页两个视频：A 在跑时切到 B 能下 B（1.7.0 实测下到的还是 A）===');
  {
    // 根因有两层：① 进度与按钮状态全局共享，A 把按钮禁用；② 候选集是整页累积的，
    // 旧逻辑按 size 降序猜"当前画质"，于是永远挑体积最大的那个（视频 A）。
    // 现在：当前这条 = 最近被请求过的那条；按钮不禁用；每个任务各写各的进度。
    // ⚠️ 关键：**B（新切过去的）比 A（旧的那个）小**。
    // 这正是实测形态：历史上已经下过/看过的视频留在候选集里，体积往往更大
    // （旧的那条 128 MiB，新打开的这条 29 MiB）。按体积猜就会挑回旧的那条 ——
    // 而"最近被请求过"才等于用户眼前这条。两条实现的差别只有这一条断言能区分。
    const sizeA = 6 * MB;
    const sizeB = 4 * MB;
    const wholeA = makeWhole(sizeA);
    const wholeB = makeWhole(sizeB);
    // 用真实的 URL 形态（带 docId）：A 与 B 是**不同文档** = 不同视频。
    // 这正是"候选集里堆着整页历史"的样子。
    const urlA = twebVariantUrl(sizeA, 'doc-A', 'A.mp4');
    const urlB = twebVariantUrl(sizeB, 'doc-B', 'B.mp4');

    let releaseA = null;
    const gateA = new Promise((r) => { releaseA = r; });
    const impl = async (url, init) => {
      if (url === urlA) { await gateA; return hlsEndpoint(wholeA)(url, init); }
      return hlsEndpoint(wholeB)(url, init);
    };

    // 起始只有 A —— 真实场景就是先打开视频 A
    const env = makeEnv({ mgUrls: urlA, mainFetch: impl });

    const pa = env.download();          // A 开始，故意吊住
    await settle(30);
    // pageStatus 当场造状态（定时器被节流时也能读到实时进度）
    const st1 = env.fire({ type: 'pageStatus' });
    check('第一次下的是 A（当时页面上只有 A）',
      st1.state.running.some((j) => j.name === 'A.mp4'),
      JSON.stringify(st1.state.running.map((j) => j.name)));
    // 这一刻 A 还在跑、且**还没有任何任务完成** —— 是"按钮被禁用"唯一可观测的时刻。
    // （放到 B 下完之后再断言不算数：B 会在几十毫秒内下完，然后代码把 disabled
    // 清掉，补丁被掩盖 —— R14 一开始就是这么"通过"的。）
    check('下载期间按钮没有被禁用（这正是下不了 B 的原因）',
      st1.state.buttonDisabled === false, JSON.stringify(st1.state.buttonDisabled));

    // 切到 B：播放器这时才会去请求 B 的分片，钩子随之把 B 记进候选集。
    // ⚠️ 必须等 200ms 以上：钩子 record() 之后是 scheduleFlush()（200ms 定时器）
    // 才写进 dataset，content.js 读的就是 dataset。第一版只等 20ms，
    // 于是"切到 B"这一步在断言时还没生效，用例照出来的仍是 A。
    // 真实场景里人手点击远大于 200ms，所以这不是缺陷，但测试必须如实等。
    await env.playerFetch(urlB);
    await settle(320);

    env.fire({ type: 'pageDownload', quality: 'best', mode: 'browser', outDir: '' });
    await settle(40);
    const mid = env.fire({ type: 'pageStatus' });

    check('A 在跑时按钮没有被禁用（这正是下不了 B 的原因）',
      mid.state.buttonDisabled === false, JSON.stringify(mid.state.buttonDisabled));
    check('两个任务同时在列表里', mid.state.running.length === 2,
      JSON.stringify(mid.state.running.map((j) => j.name)));
    check('选中的那条是 B（最近被请求过的），不是体积最大的',
      mid.summary.selectedUrl === urlB, String(mid.summary.selectedUrl).slice(-30));

    releaseA();
    await pa;
    await settle(60);
    const saved = await env.savedBytes();

    check('两个文件都交付了', env.downloads.length === 2, String(env.downloads.length));
    check('两个文件字节都对', saved.reduce((n, b) => n + b.byteLength, 0) === sizeA + sizeB,
      String(saved.reduce((n, b) => n + b.byteLength, 0)));
    check('两个文件名不同（不会互相覆盖）',
      new Set(env.downloads.map((d) => d.name)).size === 2,
      JSON.stringify(env.downloads.map((d) => d.name)));
  }

  console.log('\n=== 21. 同一条重复点击：先说明"已经下过"，再点一次才真下 ===');
  {
    const url = twebUrl(HLS_SIZE, 'movie.MP4', 'hls_stream');
    const env = makeEnv({ mgUrls: url, mainFetch: hlsEndpoint(hlsWhole) });

    await env.download();
    check('第一次真的下了', env.downloads.length === 1, String(env.downloads.length));

    // 第二次点：不应立刻再下一遍
    env.fire({ type: 'pageDownload', quality: 'best', mode: 'browser', outDir: '' });
    await settle(40);
    const second = env.fire({ type: 'pageStatus' }).state;
    check('第二次没有重复下载', env.downloads.length === 1, String(env.downloads.length));
    check('并说清"已经下过"与再来一次的后果',
      /已经下过/.test(second.message) && /再点一次/.test(second.message), second.message);

    // 第三次点（确认过）才真下
    env.fire({ type: 'pageDownload', quality: 'best', mode: 'browser', outDir: '' });
    await settle(60);
    check('确认后确实重下了一遍', env.downloads.length === 2, String(env.downloads.length));
  }

  console.log('\n=== 22. 档位列表：只列当前这条的兄弟（同 docId），带真实大小 ===');
  {
    // 三个**不同 docId**（= 三条不同视频，各只有一个档位）
    const urls = [64, 29, 128].map((n, i) => twebVariantUrl(n * MB, `doc${i}`));
    const env = makeEnv({ mgUrls: urls.join('|'), mainFetch: hlsEndpoint(hlsWhole) });
    await settle();
    const v = env.fire({ type: 'pageDetect' }).summary.variants || [];
    check('不同 docId 时只列当前那一条（不把别的视频当"另一档画质"）',
      v.length === 1, JSON.stringify(v.map((x) => x.size)));
  }

  {
    const sizes = [64 * MB, 29 * MB, 128 * MB];
    const urls = sizes.map((n, i) => twebUrl(n, `v${i}.MP4`, 'hls_stream'));
    const env = makeEnv({ mgUrls: urls.join('|'), mainFetch: hlsEndpoint(hlsWhole) });
    await settle();
    const rep = env.fire({ type: 'pageDetect' });
    const v = rep.summary.variants || [];
    check('档位列表非空且每项都带真实字节数',
      v.length > 0 && v.every((x) => typeof x.size === 'number' && x.size > 0),
      JSON.stringify(v.map((x) => x.size)));
    check('恰好一项被标为 current',
      v.filter((x) => x.current).length === 1, JSON.stringify(v.map((x) => x.current)));
    check('按大小降序，便于用户挑',
      v.every((x, i) => i === 0 || v[i - 1].size >= x.size), JSON.stringify(v.map((x) => x.size)));
  }

  console.log('\n=== 23. 用户可以按体积挑档位（这是唯一诚实的指标）===');
  {
    // 同一个 docId 的三个档位：29 / 64 / 128 MiB
    const sizes = [29 * MB, 64 * MB, 128 * MB];
    const urls = sizes.map((n) => twebVariantUrl(n, 'same-doc', `v${n}.MP4`));
    const bodies = new Map(urls.map((u, i) => [u, makeWhole(sizes[i])]));
    const env = makeEnv({
      mgUrls: urls.join('|'),
      mainFetch: async (url, init) => plainCdn(bodies.get(url) || makeWhole(1024))(url, init),
    });
    await settle();
    const sum = env.fire({ type: 'pageDetect' }).summary;
    check('三个档位都列出来了，且按体积降序',
      sum.variants.length === 3
        && sum.variants.map((x) => x.size).join(',')
          === [128 * MB, 64 * MB, 29 * MB].join(','),
      JSON.stringify(sum.variants.map((x) => x.size)));

    // 明确选第 2 档（64 MiB）
    env.fire({ type: 'pageDownload', quality: 'best', mode: 'browser', outDir: '', variantIndex: 1 });
    await settle(200);
    const st = env.fire({ type: 'pageStatus' }).state;
    check('下了用户指定的那一档（64 MiB，不是最大的 128）',
      /64\s?MiB/.test(st.message) && !/128\s?MiB/.test(st.message), st.message);
    const saved = await env.savedBytes();
    check('交付字节等于所选档位的真实大小', saved[0] && saved[0].byteLength === 64 * MB,
      saved[0] ? String(saved[0].byteLength) : 'none');
  }

  console.log('\n=== 24. 页面刷新把下载打断了：必须说清"没在后台继续"，而不是回到"就绪" ===');
  {
    // 用户原话（1.8.0 实测）：「页面一刷新，下载就重置了。反正插件里面是发现
    // 那个东西不见了，也不知道是不是在后台下载」。
    //
    // 事实：字节只能在页面世界拉（Telegram 的端点靠页面自己的 SW 兑现），
    // 页面一卸载 fetch 就中止 —— **没有任何东西在后台跑**。但以前插件对此
    // 一言不发，面板回到"就绪"，用户只能猜。
    //
    // 做法：未完成的任务写进 sessionStorage（关标签页即失效，正好符合"它的
    // 生命周期就是这个页面"），新页面读回来明确说"被中断、没有在后台继续"。
    const store = new Map();
    const sessionStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };

    const size = 8 * MB;
    const url = twebVariantUrl(size, 'doc-refresh', 'movie.MP4');

    // ---- 第一次会话：下到一半"刷新" ----
    const gate = new Promise(() => {});      // 永不 resolve = 下载进行中
    const env1 = makeEnv({
      mgUrls: url,
      sessionStorage,
      mainFetch: async (u, init) => { await gate; return hlsEndpoint(makeWhole(size))(u, init); },
    });
    env1.fire({ type: 'pageDownload', quality: 'best', mode: 'browser', outDir: '' });
    await settle(40);

    const st1 = env1.fire({ type: 'pageStatus' });
    check('刷新前任务确实在列表里且未完成',
      st1.state.running.length === 1 && !st1.state.running[0].done,
      JSON.stringify(st1.state.running.map((j) => ({ n: j.name, d: j.done }))));
    check('未完成的任务被写进了 sessionStorage（跨刷新的事实来源）',
      (sessionStorage.getItem('mediagrab.jobs.v1') || '').includes('movie.MP4'),
      String(sessionStorage.getItem('mediagrab.jobs.v1')).slice(0, 90));

    // ---- 第二次会话：同一个页面重新加载了（共用 sessionStorage）----
    const env2 = makeEnv({
      mgUrls: url,
      sessionStorage,
      mainFetch: hlsEndpoint(makeWhole(size)),
    });

    const st2 = env2.fire({ type: 'pageStatus' });
    const jobs = st2.state.running;
    check('刷新后仍能看到那个被打断的任务（不是凭空消失）',
      jobs.some((j) => j.name === 'movie.MP4'), JSON.stringify(jobs.map((j) => j.name)));
    const it = jobs.find((j) => j.name === 'movie.MP4');
    check('它被标为 interrupted（不是 failed，也不是"完成"）',
      it && it.done === 'interrupted', it && String(it.done));
    check('说明里明确写了"没有在后台继续下载"',
      it && /没有在后台继续/.test(it.note), it && it.note);
    check('面板消息同样说清这件事',
      /没有在后台继续下载/.test(st2.state.message), st2.state.message);
    check('被打断的历史任务**不**让按钮变灰（1.7.0 那个"下不了"的坑）',
      st2.state.buttonDisabled === false && st2.state.busy === false,
      JSON.stringify({ d: st2.state.buttonDisabled, b: st2.state.busy }));
  }

  console.log('\n=== 25. 刷新后再点下载：从断点续传，不从头重来 ===');
  {
    // 前提：暂存文件在刷新后**仍然活着**（只有失败才会 discard，卸载不执行清理）。
    // 但 `createWritable()` 默认 truncate，会把它抹平 —— 所以必须
    // keepExistingData + seek(rangeFetch 的 startOffset)。
    const size = 6 * MB;
    const whole = makeWhole(size);
    const name = 'movie.MP4';
    const url = twebVariantUrl(size, 'doc-resume', name);

    const store = new Map();
    const sessionStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };

    // 第一次会话：只服务前 carry 字节就中断（模拟"下了一半"）
    const carry = 2 * MB;
    const base = hlsEndpoint(whole);
    // 只服务前 carry 字节，之后的请求一律 416 —— rangeFetch 收不满就会
    // 因「字节数不足」失败并 discard 暂存。
    //
    // ⚠️ 之前这里写的是 `throw new Error('模拟连接中断')`，那会走**可重试**
    //    路径：重试 3 次之后才失败，于是 `settle(1400)` 之内它还"在跑"
    //    （phase=running，进度条 31%）—— 断言看到的是中间态而不是终态。
    //    真实场景（页面被刷新 / 连接被掐）也该是"拿不满就停"，所以用 416。
    const partialImpl = async (u, init) => {
      const range = String(init.headers.Range).match(/bytes=(\d+)-(\d+)/);
      const from = range ? Number(range[1]) : 0;
      if (from >= carry) return makeResp({ status: 416 });
      const to = Math.min(carry - 1, from + 4 * MB - 1);
      return makeResp({
        contentRange: `bytes ${from}-${to}/${size}`,
        contentLength: to - from + 1,
        body: whole.slice(from, to + 1),
      });
    };
    const env1 = makeEnv({ mgUrls: url, sessionStorage, mainFetch: partialImpl });
    const p1 = env1.nextState();
    env1.fire({ type: 'pageDownload', quality: 'best', mode: 'browser', outDir: '' });
    await p1;
    await env1.tick();          // 等一轮轮询把失败态 render 出来（见用例 12 的注释）
    const st1 = env1.lastState();
    check('第一次会话以"字节不足"失败（不交付半截文件）',
      st1 && st1.phase === 'error', st1 && String(st1.phase));
    check('失败后暂存被 discard —— 这正是我们要绕开 refresh 的原因',
      env1.opfs.removed.includes(`${name}.part`),
      JSON.stringify(env1.opfs.removed));

    // ⚠️ 失败会 discard，所以"刷新时残留着 2 MiB"这个前提得**手工造**出来。
    //    真实场景是：页面被刷新（不是下载失败）→ 没有 catch、没有 discard，
    //    OPFS 里那份 part 文件原封不动地留着。
    env1.opfs.files.set(`${name}.part`, {
      name: `${name}.part`, buf: whole.slice(0, carry), closed: false, aborted: false,
    });
    const haveBytes = env1.opfs.files.get(`${name}.part`).buf.byteLength;
    check('造出"刷新时已下 2 MiB"的残留暂存',
      haveBytes === carry, String(haveBytes));

    // ---- 第二次会话：共用同一份 OPFS + sessionStorage ----
    const asked = [];
    const env2 = makeEnv({
      mgUrls: url,
      sessionStorage,
      opfsFiles: env1.opfs.files,          // 复用同一份"磁盘"
      mainFetch: async (u, init) => {
        asked.push(String(init.headers.Range));
        return base(u, init);
      },
    });
    await env2.download();
    const saved = await env2.savedBytes();

    check('续传后的文件逐字节等于源（最终判据）',
      saved[0] && sameBytes(saved[0], whole),
      saved[0] ? `${saved[0].byteLength}/${size}` : 'no bytes');
    // ⚠️ 两个陷阱叠在一起，本项目都已经踩过：
    //   1. asked[0] 是**探测**请求（Range: bytes=0-0），不是分块请求；
    //   2. `bytes=0-0` **本身也是合法的闭区间**（起点 0、终点 0），
    //      所以 /^bytes=\d+-\d+$/ 这个"看起来对"的过滤**留住了探测请求**。
    //      第一次就栽在这里：chunks[0] 是 "bytes=0-0"，断言于是报"从 0 开始拉"。
    //    正确做法是显式剔掉探测那一轮，而不是靠正则去区分。
    const chunks = asked.slice(1).filter((a) => /^bytes=\d+-\d+$/.test(a));
    check('存在闭区间分块请求（续传走的是闭区间，不是开区间）',
      chunks.length > 0, JSON.stringify(asked.slice(0, 4)));
    check('第一个分块请求就从断点之后开始（不重拉已下载的字节）',
      chunks.length > 0 && Number(chunks[0].match(/^bytes=(\d+)-/)[1]) >= carry,
      JSON.stringify(chunks.slice(0, 3)));
    check('没有任何分块请求落在暂存已有的那一段里',
      chunks.every((a) => Number(a.match(/^bytes=(\d+)-/)[1]) >= carry),
      JSON.stringify(chunks.slice(0, 4)));
    check('探测请求仍然是 bytes=0-0（与续传无关，是拿总长度用的）',
      asked[0] === 'bytes=0-0', asked[0]);
    check('续传没有触发 truncate（保住已下载的字节）',
      env2.opfs.truncated.length === 0, JSON.stringify(env2.opfs.truncated));
    check('同一个文件只交付了一次', env2.downloads.length === 1, String(env2.downloads.length));
  }

  console.log('\n=== 23b. yt-dlp 通道：连点两次只起一个任务（1.9.1 实测 Errno 2）===');
  {
    // 实测：YouTube Shorts 页连点两次「下载此页视频」→ 两个 yt-dlp 进程写同一个
    // 输出文件 → `ERROR: Unable to rename file: [Errno 2] ... .mp4.part -> .mp4`。
    // 而且第一份截图里面板**永久**停在「正在启动后台下载…」，用户看不到进度，
    // 理所当然会再点一次 —— 两个问题互相放大。
    //
    // 这里要验两件事：
    //   1. 第二次点击不再向宿主提交 start 消息（去重）
    //   2. phase='download' 时面板必须有可见反馈（不再停在"正在启动"）
    const page = 'https://www.youtube.com/shorts/wCXkgdbVTdl';
    const env = makeEnv({ page, withVideo: false, mgUrls: '' });

    // 第一次：起一个 yt-dlp 任务，假装还在跑
    env.fire({ type: 'pageDownload', quality: 'best', mode: 'ytdlp', outDir: '' });
    await settle(40);
    const starts = env.msgs.filter((m) => m.type === 'start');
    check('第一次点击向宿主提交了 yt-dlp 任务', starts.length === 1,
      JSON.stringify(starts.map((m) => m.mode)));
    check('提交的是页面地址（Shorts 会被 sites.js 规范化成 watch?v=）',
      starts[0] && /youtube\.com/.test(starts[0].url || ''), starts[0] && starts[0].url);

    // 第二次点击：必须被去重挡下
    env.fire({ type: 'pageDownload', quality: 'best', mode: 'ytdlp', outDir: '' });
    await settle(40);
    const st = env.fire({ type: 'pageStatus' });
    check('第二次点击没有再提交任务（不会再抢同一个 .part）',
      env.msgs.filter((m) => m.type === 'start').length === 1,
      String(env.msgs.filter((m) => m.type === 'start').length));
    check('面板说明"已经在下载了"，而不是又转一圈',
      /已经在下载/.test(st.state.message), st.state.message);
    // 注：这里不断言 buttonDisabled —— 去重本身已经在**入口**处挡住了第二次
    // 点击（根本没走到发消息那一步），按钮状态只是第二道闸。真正要守的是
    // "第二个 yt-dlp 进程不能被起起来"，上面两条就是。
  }

  console.log('\n=== 23c. phase="download" 期间面板必须有反馈（1.9.1 永久"正在启动"）===');
  {
    // background 起 yt-dlp 任务时 phase 就是 'download'（见 background.js 的
    // trackJob / pollJob）。render() 以前只认 probe/running/browser/done/error，
    // 于是整个下载过程面板一个字都不更新 —— 用户看到的就是永久的
    // 「正在启动后台下载…」，完全无法判断该不该再点。
    //
    // 直接驱动 render()：通过 poll 拿一个 download 阶段的 job 回来。
    const env = makeEnv({ page: 'https://www.youtube.com/shorts/wCXkgdbVTdl',
      withVideo: false, mgUrls: '' });
    await settle();

    // 让桩按 background 的真实行为回一个 download 阶段的 job
    // 先起一个任务，currentJob 才有值（tick 靠它决定要不要轮询）
    env.fire({ type: 'pageDownload', quality: 'best', mode: 'ytdlp', outDir: '' });
    await settle(30);

    env.setPollReply({
      jobId: 'mgjob1', mode: 'ytdlp', phase: 'download',
      percent: 42, downloaded: '3.1MiB / 7.4MiB', speed: '1.2MiB/s', eta: '00:04',
    });

    // ⚠️ 断言必须落在「**这一轮 tick 之内**快照有没有变」上。
    // content.js 另有 `setInterval(publish, 700)` 在兜着 —— 如果只看
    // "等一会儿之后快照对不对"，那条断言恒真（哪怕 tick 根本不 publish），
    // 于是反向验证报「仍然全过」。这里改用 send 同步取回 tick 那一刻的快照。
    const snap = await env.snapshotAfterTick();
    let m = snap;
    check('download 阶段被算作"在忙"（按钮禁用）',
      m && m.buttonDisabled === true, JSON.stringify(m && m.buttonDisabled));
    check('download 阶段显示进度而不是"正在启动"',
      m && /yt-dlp 下载中/.test(m.message), m && m.message);
    check('download 阶段显示已下载/总量与速度',
      m && /3\.1MiB \/ 7\.4MiB/.test(m.detail) && /1\.2MiB\/s/.test(m.detail),
      m && m.detail);
    check('进度条被更新（不是停在 0%）', m && m.percent > 0, String(m && m.percent));

    // done 也要收尾：写进 deliveredYtdlp，第二次点变成"再点一次才重下"
    // ---- 完成：必须把结果**上报给 background** ----------------------------
    //
    // 这才是 publish 的真实作用，也是用户能感知的：background 靠 pageState
    // 发系统通知（popup 早就关掉了）与更新角标。pageStatus 自己走
    // buildState() 当场造快照，所以拿它当判据是恒真的 —— 必须看**消息本身**。
    // ⚠️ 停掉 700ms 的兜底 publish —— 否则它在任何 700ms 边界上都会抢先发，
    // 这条断言恒真（第一次 R26 报"仍然全过"就是这个原因，已写进长期记忆）。
    const stopped = env.stopTimer(700);
    check('找到并停掉了 700ms 的兜底 publish 定时器', stopped >= 1, String(stopped));
    await settle(760);
    const before = env.countPageStates();
    env.setPollReply({ jobId: 'mgjob1', mode: 'ytdlp', phase: 'done', file: 'x.mp4' });
    await settle(1400);          // 覆盖 1200ms 的轮询周期
    const afterEarly = env.countPageStates();
    check('轮询把结果**自己**上报给 background（兜底已停，只剩这一条路径）',
      afterEarly > before, `${afterEarly} vs ${before}`);
    const pageStates = env.msgs.filter((x) => x.type === 'pageState');
    const doneMsg = pageStates[pageStates.length - 1];
    check('上报的快照带着 done 状态与文件名',
      doneMsg && doneMsg.state && doneMsg.state.phase === 'done' && /x\.mp4/.test(doneMsg.state.file || ''),
      JSON.stringify(doneMsg && doneMsg.state && { p: doneMsg.state.phase, f: doneMsg.state.file }));

    m = env.lastState();
    check('完成后不再禁用按钮', m && m.buttonDisabled === false,
      JSON.stringify(m && m.buttonDisabled));
    check('完成后该任务记进"已下过"（第二次点要确认才重下）',
      env.lastState() && /完成|已保存/.test(env.lastState().message || ''),
      env.lastState() && env.lastState().message);
  }

  console.log('\n=== 23d. 宿主报错翻人话：顺序敏感，具体的必须排在笼统之前 ===');
  {
    // 所有原文都取自 ~/Library/Application Support/MediaGrab/jobs 里**真实**的
    // job 日志（41 个 job：30 成功、11 失败）。这不是编造的字符串。
    const REAL_ERRORS = [
      {
        name: 'B 站经代理读超时（1.9.2 实测）',
        raw: "ERROR: [BiliBili] 1RSe46pEJU: Unable to download webpage: HTTPSConnectionPool(host='www.bilibili.com', port=443): Read timed out. (read timeout=30.0)",
        must: /重试|再点一次/,
        mustNot: /打不开这个页面$/,
      },
      {
        name: 'SSL 意外中断',
        raw: 'ERROR: [generic] #@x: Unable to download webpage: [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol',
        must: /重试|再点一次/,
      },
      {
        name: '对端直接关闭连接',
        raw: 'ERROR: [generic] 1: Remote end closed connection without response',
        must: /重试|再点一次/,
      },
      {
        name: '改名失败 Errno 2（1.9.1 实测）',
        raw: "ERROR: Unable to rename file: [Errno 2] No such file or directory: '/tmp/dl/x.mp4.part' -> '/tmp/dl/x.mp4'",
        must: /改名失败|两个进程/,
      },
      {
        // ⚠️ 必须与「参数写错」区分开：`Unsupported URL` 说的是**输入地址**
        //    不认识（要换通道），而 `invalid ... expression` 说的是**参数**
        //    写错了（重试无用）。1.9.3 两者混在一起，把用户引向反方向。
        name: 'Telegram 页面地址（死路，要说清换方式）',
        raw: 'ERROR: Unsupported URL: https://web.telegram.org/k/#@x',
        must: /浏览器下载/,
        mustNot: /参数本身|重试没有意义/,
      },
      {
        name: '403 需要登录态',
        raw: 'ERROR: Unable to download video page: HTTP Error 403: Forbidden',
        must: /登录/,
      },
      {
        name: '视频不可用',
        raw: 'ERROR: [BiliBili] x: Video unavailable',
        must: /浏览器下载/,
      },
      {
        // 2026-10-16 实测：代理隧道 502。**重试无用**，该做的是修代理。
        name: '代理隧道 502（10-16 实测）',
        // ⚠️ 用反引号模板串：原文里有 ProxyError("...") 的**双引号**，
        //    放进双引号 JS 字符串必然 SyntaxError（第一版就栽在这）。
        raw: `ERROR: [youtube] h6fGWMB39Bw: Unable to download API page: ('Unable to connect to proxy', OSError('Tunnel connection failed: 502 Bad Gateway')) (caused by ProxyError("('Unable to connect to proxy', OSError('Tunnel connection failed: 502 Bad Gateway'))"))`,
        must: /代理/,
        // ⚠️ 这条是重点：不能被"直接再点一次下载即可"那类规则兜住
        //    （那会让用户一直白点）。注意本条文案**故意**含"重试没有意义"，
        //    所以 mustNot 只排"再点一次"，不能排整个词组（第一版排错了）。
        mustNot: /再点一次/,
      },
      {
        name: '代理连不通（简写形式）',
        raw: "ERROR: [generic] x: Unable to connect to proxy",
        must: /代理/,
        mustNot: /再点一次/,
      },
      // ---- 参数错误 ≠ 输入地址不支持 --------------------------------------
      {
        // 1.9.3：我自己造的 bug，退出码 2，一个字节都没下到
        name: '裸 linear（参数写错，1.9.3 实测）',
        raw: "Usage: yt-dlp [OPTIONS] URL [URL...]\nyt-dlp: error: invalid http retry sleep expression 'linear'",
        must: /参数/,
        mustNot: /浏览器下载/,
      },
      {
        name: '无法识别的命令行参数',
        raw: "Usage: yt-dlp [OPTIONS] URL [URL...]\nyt-dlp: error: Unrecognized arguments: --retry-sleep",
        must: /参数/,
        mustNot: /浏览器下载/,
      },
    ];

    // explainHostError 是 content.js 的内部函数，通过环境消息触发一次真实失败
    // 来读它的输出：起一个必然失败的任务（端点 403），把 stderr 塞进去。
    for (const c of REAL_ERRORS) {
      const env = makeEnv({ page: 'https://www.youtube.com/shorts/x', withVideo: false, mgUrls: '' });
      env.fire({ type: 'pageDownload', quality: 'best', mode: 'ytdlp', outDir: '' });
      await settle(30);
      // 让 start 失败：把 pollReply 的 error 设成这条原文，模拟宿主的回执
      env.setPollReply({ jobId: 'mgjob1', mode: 'ytdlp', phase: 'error', error: c.raw });
      await env.tick();
      const m = env.lastState();
      const msg = (m && m.message) || '';
      check(`${c.name} → 翻成了人话`, c.must.test(msg), msg.slice(0, 150));
      if (c.mustNot) {
        check(`${c.name} → 没有被笼统规则抢走`, !c.mustNot.test(msg), msg.slice(0, 90));
      }
    }
  }

  console.log('\n=== 23e. ytdlpOnly 站点（B 站）不报"同源流端点/整片约 31MiB"（1.9.2 实测）===');
  {
    // 用户截图：B 站页面上摘要写「同源流端点 4 条 · 当前画质整片约 31MiB」，
    // 而真实视频是 **84.36MiB**（yt-dlp 实测下到 76% 时显示的总量）。
    //
    // 根因：`hls_stream/{docId,dcId,size,mimeType}` 是 **Telegram** 的端点格式。
    // B 站页面上出现同源流候选纯属巧合（内容里恰好有类似路径），
    // 把它的 size 当"整片大小"报出来就是**假信息** —— 用户会以为下错文件。
    //
    // B 站这类 ytdlpOnly 站点一律走 yt-dlp 合并，页面嗅探到的字节与之无关。
    const size = 31 * MB;   // 假信息：页面上嗅探到的"整片"大小
    // ⚠️ 必须与页面**同源**：isSameOriginStream 要求 origin 一致。第一版夹具用了
    // web.telegram.org 的 URL，于是 streams=0，"ytdlpOnly 门禁"去掉也照样过 ——
    // 用例成了装饰，是反向验证 R29 报"仍然全过"照出来的。
    const page = 'https://www.bilibili.com/video/BV1RSe46pEJU';
    const url = sameOriginStreamUrl('https://www.bilibili.com', size, 'bilibili-doc-1');
    const env = makeEnv({
      page,
      withVideo: false,
      mgUrls: url,
      mainFetch: async () => makeResp({ status: 403 }),
    });
    await settle();
    const sum = env.fire({ type: 'pageDetect' }).summary;

    check('被识别为 ytdlpOnly（这是本用例的前提）', sum.ytdlpOnly === true,
      JSON.stringify(sum.ytdlpOnly));
    // 桩保真度自检：必须真的"页面上有同源流候选"，否则下面两条断言恒真
    // （第一版就是栽在这里：streams=0 却还以为在测门禁）。
    check('页面上确实嗅探到了同源流候选（否则本用例是装饰）',
      sum.streams > 0, `streams=${sum.streams}`);
    check('ytdlpOnly 页面上不给档位列表（那些是 Telegram 语义）',
      Array.isArray(sum.variants) && sum.variants.length === 0,
      JSON.stringify(sum.variants));

    // 反过来：Telegram 页面必须仍然给档位（别把这块功能一起关掉）。
    // ⚠️ 这里也必须**同源**：Telegram 页面的 origin 是 web.telegram.org，
    // 沿用上面那个 bilibili URL 的话 streams=0，"没有误伤"就成了恒真断言。
    const env2 = makeEnv({
      page: 'https://web.telegram.org/k/#@channel',
      mgUrls: sameOriginStreamUrl('https://web.telegram.org', 84 * MB, 'tg-doc-1'),
      mainFetch: async () => makeResp({ status: 403 }),
    });
    await settle();
    const sum2 = env2.fire({ type: 'pageDetect' }).summary;
    check('Telegram 页面仍然照常给同源流端点与档位（没有误伤）',
      sum2.ytdlpOnly !== true && sum2.streams > 0 && sum2.variants.length > 0,
      JSON.stringify({ ytdlpOnly: sum2.ytdlpOnly, streams: sum2.streams,
        variants: sum2.variants.length }));
  }

  console.log('\n=== 24. 桩保真度自检：加载期没有异常 ===');
  {
    const env = makeEnv({ withVideo: false });
    // refresh() 在加载时就跑过一次，任何 resolve 不到的元素都会在这一步暴露。
    check('加载 content.js 没有抛异常', true);
    check('加载期日志里没有「读取 <video> 元素失败」之外的异常',
      !/is not a function|undefined is not/.test(env.logText()),
      env.logText().split('\n').filter((l) => /is not a function|undefined is not/.test(l)).join(' | '));
  }

  // 清掉所有会话的定时器：桩的 setInterval 现在是真定时器（必须真跑，
  // 否则 poll/render 这条链路在测试里根本没被执行过），不清理就会串场 ——
  // 上一个用例的轮询把自己的 pollReply 打到下一个用例的 content script 上，
  // 状态被覆盖成 `running`（用例 12/25 曾因此全红）。
  for (const e of liveEnvs) e.destroy();
  summary();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(2);
});

/**
 * MediaGrab MAIN-world hooks.
 *
 * 这份脚本以 `world: "MAIN"` + `run_at: "document_start"` 注入页面本身，
 * 因此：
 *   - 绕开页面 CSP（不像 content script 那样受隔离世界限制）；
 *   - 在任何页面脚本之前装好钩子 —— MSE 捕获必须抢在播放器第一次
 *     appendBuffer 之前，否则拿不到开头的数据。
 *
 * 采集结果只写两个地方：
 *   document.documentElement.dataset.*   —— 字符串，供隔离世界的 content script 读；
 *   window.__mgMedia                     —— 二进制分片，只供同世界的 assembleMse 用。
 *
 * 幂等：重复注入安全。
 *
 * ⚠️ 这里有一条用血换来的教训：**不要用 `document.documentElement` 的存在与否
 * 决定要不要装钩子**。`run_at: document_start` 时 DOM 还没开始建，
 * `document.documentElement` 可能是 null；早期版本在文件开头写了
 * `if (!root) return;`，结果钩子一条都没装上，而 Console 里看起来和
 * 「装了但没抓到」完全一样，白白耗掉好几轮排查。
 *
 * 正确做法：钩子立刻装（包 fetch / XHR / appendBuffer 不需要 DOM），
 * 只有**写 dataset** 那一步才需要 root，写不了就排队等一会儿再写。
 */

(() => {
  // ⚠️ 整文件幂等闸门，必须放在最前面。
  //
  // 这份脚本有**两条**注入路径：
  //   1. manifest 的 content_scripts（world: MAIN, document_start）—— 主路径；
  //   2. content.js 启动时发的 installFetchHook → executeScript(files) —— 补装路径，
  //      用于"页面在扩展更新之前就已经加载完"的情况。
  //
  // 如果只靠下面 `window.__mgHooked` / `window.__mgMediaHooked` 那两个分块开关，
  // 第二次注入仍然会重建一份**全新的 state**（mse = 0），并抢着往
  // dataset.mgMse 写 '0'；旧实例的心跳又写真实值 —— 两个 setInterval 互相覆盖，
  // mgMse 在真实值和 0 之间来回跳，captureMseFile() 时有时无地判成"没捕获到"。
  // 这类间歇性失败最难查，所以整份文件只允许跑一次。
  if (window.__mgHooksInstalled) return;
  window.__mgHooksInstalled = true;

  // ---------------------------------------------------------------------
  // 采集状态（全部存内存，异步落进 dataset）
  // ---------------------------------------------------------------------
  const state = {
    urls: [],
    // 与 urls 平行：每条 URL **首次**被看到的时间戳（ms）。
    //
    // 为什么必须记时间：Telegram 的每个画质档位是**独立的 docId**（不同文档），
    // 而一个页面上会先后播放多个视频，于是 dataset.mgUrls 里堆着历史上所有
    // 视频的所有档位。没有时间戳，content.js 只能按 size 猜"哪个是当前画质"
    // —— 于是切到视频 B 之后下到的仍是视频 A，或者同一条视频挑了另一档
    // （1.7.0 实测：连下三次都是同一条视频，清晰度还不一样）。
    urlSeen: [],
    videos: [],
    mse: 0,          // 单个 SourceBuffer 的最大累计字节数（导出的量不会超过它）
    mseTotal: 0,     // 所有 SourceBuffer 合计
    blobFiles: 0,
    eos: 0,          // MediaSource.endOfStream 调用次数 —— 播放器自己宣告"流结束"
    seq: 0,          // 每次有新数据 +1，content script 用它判断"钩子还活着"
    flushTimer: 0,
  };

  const rootNow = () => document.documentElement || null;

  /**
   * 诊断日志：**绝不允许它抛**。
   *
   * 这不是洁癖。`console.info(..., boxInfo.counts, ...)` 里 `counts` 是
   * `Object.create(null)`（无原型），某些 console 实现 / 序列化路径会对它做
   * `String()` 而抛错；一旦日志抛在 `exportAssembly` 中间，**已经拼好的
   * 100MB 分片就全废了** —— 用户看到的是"导出失败"，日志里却什么都查不到。
   *
   * 这条坑是 v1.6.0 的仿真台照出来的：桩的 console 用 String() 拼参数，
   * 于是"日志打断导出"被伪装成了"回执没有 size"。浏览器里也可能复现（不同
   * 浏览器对无原型对象的处理不同），所以日志一律走这两个包装。
   */
  function diag(level, ...args) {
    try {
      const fn = console && console[level];
      if (typeof fn === 'function') fn.apply(console, args);
    } catch (e) { /* 诊断失败不影响交付 */ }
  }

  /**
   * MSE 钩子块填进来的运行期接口。导出通道在这个块**外面**（它必须无条件存在，
   * 哪怕 MediaSource 不存在），所以选轨要用到的 trackInfo / pickTrackIndex
   * 只能通过这个句柄拿，不能直接引用块内变量。
   */
  let mediaApi = null;

  function flush() {
    state.flushTimer = 0;
    const root = rootNow();
    if (!root) { scheduleFlush(); return; }
    try {
      // mgHook 是"钩子已装"的存活标记：content script 靠它区分
      // 「钩子没装」和「装了但页面确实没请求任何东西」。
      root.dataset.mgHook = 'on';
      root.dataset.mgSeq = String(state.seq);
      if (state.urls.length) {
        root.dataset.mgUrls = state.urls.join('|');
        // 平行数组：第 i 个 URL 的首次出现时间。
        root.dataset.mgUrlSeen = JSON.stringify(state.urlSeen);
      }
      if (state.videos.length) root.dataset.mgVideos = state.videos.join('|');
      root.dataset.mgMse = String(state.mse);
      root.dataset.mgEos = String(state.eos);
      if (state.blobFiles) root.dataset.mgBlobFiles = String(state.blobFiles);

      // 每条 MSE 缓存轨的画像（属于哪个 <video>、分辨率、时长、已缓冲到哪）。
      // content script 用它把「已缓存 75s / 整片 523s」直接写在面板上 ——
      // 用户看到"下载下来只有 5 秒"时，这一行就能说明是缓存本身只有那么长。
      if (mediaApi) {
        try {
          root.dataset.mgMseTracks = JSON.stringify(
            mediaApi.buckets.slice(0, 8).map((b) => mediaApi.trackInfo(b))
          );
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* dataset 写失败不致命 */ }
  }

  function scheduleFlush() {
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(flush, 200);
  }

  function bump() {
    state.seq += 1;
    scheduleFlush();
  }

  // 心跳：即使一直没有新请求，也保证 dataset 与内存一致（也覆盖
  // documentElement 晚一步才建出来的情况）。
  setInterval(flush, 1500);

  // ---------------------------------------------------------------------
  // 通道 1：记录页面发出的请求 URL
  //
  // 靠 URL 形态认媒体的兜底通道。不少站点把 mp4 直链藏在某个 XHR/fetch
  // 里，页面上既不进 performance 也不落到 DOM。
  // ---------------------------------------------------------------------
  if (!window.__mgHooked) {
    window.__mgHooked = true;

    function record(url) {
      if (!url || typeof url !== 'string') return;
      if (state.urls.length >= 200) return;
      if (state.urls.includes(url)) return;
      state.urls.push(url);
      state.urlSeen.push(Date.now());
      bump();
    }

    // -------------------------------------------------------------------
    // 通道 2：从 API 响应体里挖 mp4
    //
    // 抄 loki-zhou/twitter_video_down 的思路：X 的 progressive 单文件 mp4 只
    // 出现在 GraphQL 响应的 video_info.variants 里，页面上看不到。取最高码率
    // 的 video/mp4。
    //
    // ⚠️ 过滤条件必须与 content.js 的 `partial` 判定**完全一致**：
    //   DASH 分离轨 = codec 后面跟「两段纯数字」（init 序号 + 分片序号），
    //     例：.../vid/avc1/0/0/1280x720/x.mp4  、.../aud/mp4a/0/0/128000/x.mp4
    //   而 progressive 单文件 = codec 后面**直接**跟分辨率，
    //     例：.../vid/avc1/1280x720/x.mp4
    // 早期版本这里写的是「路径含 /vid/ 或 /avc1/ 就丢」，把 progressive 单文件
    // 一起丢了 —— 于是 variants 明明解析出来了，videoUrls 却永远是空，
    // Console 上表现为 `API 视频: 0`。这是 v1.3.1 实测失败的真正原因。
    // -------------------------------------------------------------------
    const DASH_TRACK_RE = /\/(?:vid|aud)\/(?:avc1|mp4a)\/\d+\/\d+\//i;

    /** 已 parse 过的响应 URL，避免同一个响应被重复遍历。 */
    const seenApi = new Set();

    function pushVideo(url) {
      if (!url || typeof url !== 'string') return;
      if (!/^https?:/i.test(url)) return;
      if (!/\.(mp4|m4v|mov|webm)(?:[?#]|$)/i.test(url)) return;
      if (DASH_TRACK_RE.test(url)) return;
      if (/\.m4s(?:[?#]|$)/i.test(url)) return;
      if (state.videos.includes(url)) return;
      if (state.videos.length >= 100) return;
      state.videos.push(url);
      bump();
      console.info('[MediaGrab] API 响应里提取到视频:', url.slice(0, 110));
    }

    // 递归遍历。已知限制：timeline / 首页的响应里有**多条**推文，这里会把它们
    // 全挖出来，无法区分哪条对应当前正在看的视频。单条推文页（/status/<id>）
    // 只含一条。content.js 侧用 <video poster> 里的 mediaId 做二次筛选
    // （见 currentMediaId），所以这里全收下来是正确的。
    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 24) return;

      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }

      // (a) X 的标准结构：video_info.variants[]，最高码率优先。
      //
      // 注意 (a) 与下面的 (b) 不是二选一：(b) 会把 variants 里**每一条** mp4
      // 都收进来（它们就是普通的 url 字符串字段）。这是有意的——面板上的画质
      // 选择需要一份候选清单才能挑，只留最高码率等于把选择权丢掉。
      // (a) 的价值在结构不叫 `url` 的站点上兜住最高码率那一条。
      const info = node.video_info;
      if (info && Array.isArray(info.variants)) {
        const best = info.variants
          .filter((v) => v && v.content_type === 'video/mp4' && v.url)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (best) pushVideo(best.url);
      }

      // (b) 其它站点把单文件 mp4 直接放在某个字符串字段里；
      //     还有站点（X 的 media_entities 就属这一类）把**整段媒体元数据**
      //     塞进一个字符串字段里——是 JSON 文本，不 parse 就永远看不到里面的
      //     video_info.variants。
      //
      // 这条是抄 loki-zhou/twitter_video_down 的 `string_value` 分支：
      //    findInObject(response, "string_value")
      //      .map(item => JSON.parse(item.string_value))
      //      .map(parsed => Object.values(parsed.media_entities)...)
      // 它的注释直接写了「Parse string_value fields that might contain media data」，
      // 说明这是 X 上真实存在的一条数据通路，不是假想。
      //
      // ⚠️ 别对任意字符串都 JSON.parse：页面上每个字符串都试一遍会白白烧掉
      // 主线程（响应体动辄几 MB）。所以先按「首字符是 { 或 [」+「含媒体关键字」
      // 两道闸门筛，再用 try 兜住解析失败。
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (typeof value === 'string') {
          if (/^https?:\/\/\S+\.(?:mp4|m4v|mov|webm)(?:\?\S*)?$/i.test(value)) {
            pushVideo(value);
          } else if (
            value.length > 8 && value.length < 2 * 1024 * 1024 &&
            (value.charCodeAt(0) === 0x7b /* { */ || value.charCodeAt(0) === 0x5b /* [ */) &&
            /media_entities|extended_entities|video_info|variants/.test(value)
          ) {
            try { walk(JSON.parse(value), depth + 1); } catch (e) { /* 不是 JSON 文本 */ }
          }
        } else if (value && typeof value === 'object') {
          walk(value, depth + 1);
        }
      }
    }

    function digest(text, url) {
      if (!text || typeof text !== 'string') return;
      // 太小 / 太大的响应体都不值得 parse（大响应 parse 会卡主线程）。
      if (text.length < 20 || text.length > 8 * 1024 * 1024) return;
      // 快速预筛：不含这些关键字就不可能是媒体数据。
      if (!/video_info|extended_entities|media_entities|variants/i.test(text)) return;
      if (seenApi.has(url)) return;
      seenApi.add(url);
      try { walk(JSON.parse(text), 0); } catch (e) { /* 不是 JSON */ }
    }

    // X / Twitter 的 API 前缀（正则抄自 loki-zhou/twitter_video_down）。
    const API_RE = /(api\.)?(twitter|x)\.com\/(i\/api\/)?(2|graphql|1\.1)\//i;

    function safeResponseText(xhr) {
      try {
        if (xhr.responseType === '' || xhr.responseType === 'text') return xhr.responseText;
        if (typeof xhr.response === 'string') return xhr.response;
      } catch (e) { /* responseType 不匹配时 responseText 会抛 */ }
      return null;
    }

    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = async function (...args) {
        const input = args[0];
        let url = typeof input === 'string' ? input : (input && input.url);
        if (typeof Request !== 'undefined' && input instanceof Request && input.url) url = input.url;
        record(url);
        const resp = await origFetch.apply(this, args);
        if (url && API_RE.test(url)) {
          try {
            // clone() 后才能读 body，原响应照常给页面用。
            resp.clone().text().then((t) => digest(t, url)).catch(() => {});
          } catch (e) { /* body 已被消费等情况 */ }
        }
        return resp;
      };
    }

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u, ...rest) {
      record(u);
      if (typeof u === 'string' && API_RE.test(u)) {
        this.addEventListener('load', () => digest(safeResponseText(this), u));
      }
      return origOpen.call(this, m, u, ...rest);
    };
  }

  // ---------------------------------------------------------------------
  // 通道 3：MSE 字节捕获
  //
  // Telegram Web K / X.com 这类站点用 MediaSource 播放：真实视频字节经
  // SourceBuffer.appendBuffer 进入播放器，<video> 上只留一个 MediaSource 的
  // blob: 引用。那个 blob 不是 Blob，页面里 fetch 必报 net::ERR_FILE_NOT_FOUND
  // （主线程 blob registry 里根本没有它），浏览器下载通道也取不到字节。
  //
  // 页面侧唯一能拿到字节的地方就是 appendBuffer 的入参——这里给每个
  // SourceBuffer 留一份分片副本，需要时由 assembleMse 拼成文件。
  // 这是所有「MSE 视频下载器」的通用做法，与站点无关。
  // ---------------------------------------------------------------------
  if (!window.__mgMediaHooked) {
    window.__mgMediaHooked = true;

    const buckets = new WeakMap();   // SourceBuffer -> { chunks, bytes, mime, blobUrl }
    const all = [];
    const blobFiles = [];            // 真 Blob（少数站点直接给 <video> 一个 Blob）
    const mediaSources = new WeakMap();  // MediaSource -> 它的 blob: URL

    /**
     * 一个 MediaSource 可能有两条 SourceBuffer（视频轨 + 音频轨）；一个页面上
     * 也可能有**十几个** MediaSource（Telegram 的聊天流里每条视频、每个表情/
     * 头像各一个）。
     *
     * 所以每条 SourceBuffer 都要能回答一个问题：**它属于页面上的哪个 <video>**。
     * 没有这条关联，"导出播放器缓存"就只能瞎猜（早期版本取"字节最多的一条"），
     * 在一个有十几条小视频的页面上，导错轨就是必然 —— 用户拿到一个能播几秒的
     * 文件，而真正要的那条 500MB 缓存还在旁边好好躺着。
     *
     * 关联链：MediaSource.addSourceBuffer 的 this → createObjectURL(ms) 拿到的
     * blob: URL → <video>.src / currentSrc 等于它。
     */
    const bucketFor = (sb, ms) => {
      let b = buckets.get(sb);
      if (!b) {
        b = {
          chunks: [],
          bytes: 0,
          mime: '',
          ms: ms || null,
          blobUrl: ms ? (mediaSources.get(ms) || null) : null,
        };
        buckets.set(sb, b);
        all.push(b);
      }
      return b;
    };

    /** 找出这条缓存轨对应的 <video> 元素（可能没有：视频已被移除）。 */
    const elementFor = (b) => {
      if (!b.blobUrl) return null;
      try {
        for (const v of document.querySelectorAll('video')) {
          if (v.src === b.blobUrl || v.currentSrc === b.blobUrl) return v;
        }
      } catch (e) { /* ignore */ }
      return null;
    };

    /** 一条缓存轨的完整画像 —— 面板与日志都用它，不再只看字节数。 */
    const trackInfo = (b) => {
      const v = elementFor(b);
      let buffered = null;
      let layout = null;
      try {
        if (v && v.buffered && v.buffered.length) {
          buffered = Math.round(v.buffered.end(v.buffered.length - 1) * 100) / 100;
        }
        if (v && v.getBoundingClientRect) {
          const r = v.getBoundingClientRect();
          layout = Math.round(r.width) * Math.round(r.height);
        }
      } catch (e) { /* ignore */ }
      return {
        bytes: b.bytes,
        mime: b.mime || '',
        w: (v && v.videoWidth) || null,
        h: (v && v.videoHeight) || null,
        duration: v && isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : null,
        buffered,
        layout,
        paused: v ? !!v.paused : null,
      };
    };

    /**
     * 选要导出的那条轨。
     *
     * 排序依据（依次比较）：
     *   1. 元素在**版面上的占位面积** —— 媒体查看器里的正片一定是最大的那个，
     *      聊天里的表情/头像小视频排在后面；
     *   2. 分辨率（videoWidth × videoHeight）；
     *   3. 字节数。
     * 没有任何一条轨能关联到元素时（视频已被移除 / 站点用的是 worker 里的
     * MediaSource），退回"字节最多"，与旧行为一致。
     */
    const trackScore = (b) => {
      const t = trackInfo(b);
      return [t.layout || 0, (t.w || 0) * (t.h || 0), b.bytes];
    };

    /** 字典序比较：a 是否优于 b。 */
    const betterTrack = (a, b) => {
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return a[i] > b[i];
      }
      return false;
    };

    const pickTrackIndex = () => {
      let bestIdx = -1;
      let bestScore = null;
      for (let i = 0; i < all.length; i += 1) {
        if (!all[i].bytes) continue;
        const s = trackScore(all[i]);
        if (!bestScore || betterTrack(s, bestScore)) {
          bestScore = s;
          bestIdx = i;
        }
      }
      return bestIdx;
    };

    /**
     * 跨 realm 安全的 ArrayBuffer 判定。
     *
     * ⚠️ 不能用裸 `instanceof ArrayBuffer`。页面完全可能把 worker / 同源
     * iframe 里造出来的 typed array 传给 appendBuffer —— 那些对象的原型链
     * 属于**另一个 realm**，`instanceof` 判 false，分片就被**静默丢掉**，
     * 表现为「钩子装了、mgMse 却一直是 0」。`ArrayBuffer.isView` 查的是
     * 对象内部槽，跨 realm 也认得；ArrayBuffer 本身则退回标签判断。
     */
    const isArrayBuffer = (v) => {
      if (!v || typeof v !== 'object') return false;
      if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return true;
      return Object.prototype.toString.call(v) === '[object ArrayBuffer]';
    };

    const isView = (v) => {
      if (!v || typeof v !== 'object') return false;
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView) {
        try { if (ArrayBuffer.isView(v)) return true; } catch (e) { /* ignore */ }
      }
      return /^\[object (?:Uint8|Int8|Uint16|Int16|Uint32|Int32|Float32|Float64|BigInt64|BigUint64|Uint8Clamped)Array\]$/
        .test(Object.prototype.toString.call(v));
    };

    const note = (bucket, data) => {
      let bytes = null;
      try {
        if (isArrayBuffer(data)) {
          bytes = data;
        } else if (isView(data)) {
          bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        }
      } catch (e) { return; }
      if (!bytes || !bytes.byteLength) return;
      bucket.chunks.push(new Uint8Array(bytes));
      bucket.bytes += bytes.byteLength;

      let max = 0;
      let total = 0;
      for (const b of all) { total += b.bytes; if (b.bytes > max) max = b.bytes; }
      state.mse = max;
      state.mseTotal = total;
      bump();
    };

    // addSourceBuffer 记 mime（决定最终文件的 type）并建立 MediaSource ↔ SourceBuffer
    // 关联（用于把缓存轨对回到页面上的某个 <video>，见 bucketFor 上方注释）。
    if (typeof MediaSource !== 'undefined' && MediaSource.prototype.addSourceBuffer) {
      const origAdd = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mime) {
        const ms = this;
        const sb = origAdd.apply(this, arguments);
        try { bucketFor(sb, ms).mime = mime || ''; } catch (e) { /* ignore */ }
        return sb;
      };
    }

    // appendBuffer 只在一处包装，避免重复计数。
    if (typeof SourceBuffer !== 'undefined' && SourceBuffer.prototype.appendBuffer) {
      const origAppend = SourceBuffer.prototype.appendBuffer;
      SourceBuffer.prototype.appendBuffer = function (data) {
        try { note(bucketFor(this), data); } catch (e) { /* ignore */ }
        return origAppend.apply(this, arguments);
      };
    }

    // endOfStream：播放器主动宣告「这条流给完了」。
    //
    // 抄 xifangczy/cat-catch（catch-script/catch.js 的 endOfStream 代理）。它只
    // 用来把状态从「捕获中」翻成「捕获完成」——对我们是判断「手上这份缓存到底
    // 是完整文件，还是只播了一小段」的唯一客观依据。UI 拿它决定要不要提示
    // 用户「先让它播完再导出」。
    if (typeof MediaSource !== 'undefined' && MediaSource.prototype.endOfStream) {
      const origEos = MediaSource.prototype.endOfStream;
      MediaSource.prototype.endOfStream = function () {
        try { state.eos += 1; bump(); } catch (e) { /* ignore */ }
        return origEos.apply(this, arguments);
      };
    }

    // createObjectURL 有两个用途：
    //   1. 少数站点直接给 <video> 一个真 Blob（而非 MediaSource），一并留下；
    //   2. 记住 MediaSource → blob: URL 的映射 —— 页面拿到这个 URL 赋给
    //      <video>.src，我们就能反查到"这条缓存轨属于哪个 <video>"。
    //      ⚠️ 顺序是 createObjectURL(ms) 先于 addSourceBuffer，所以映射要在这里
    //      先存下来，addSourceBuffer 时再去查（见 bucketFor）。
    if (window.URL && window.URL.createObjectURL) {
      const origCOU = window.URL.createObjectURL;
      window.URL.createObjectURL = function (obj) {
        try {
          if (typeof MediaSource !== 'undefined' && obj instanceof MediaSource) {
            const href = origCOU.apply(this, arguments);
            mediaSources.set(obj, href);
            // 同一 MediaSource 先加轨、后建 URL 的情况：补上关联。
            for (const b of all) if (b.ms === obj && !b.blobUrl) b.blobUrl = href;
            return href;
          }
          if (typeof Blob !== 'undefined' && obj instanceof Blob && obj.size
              && /^(video|audio)\//.test(obj.type || '')) {
            blobFiles.push({ blob: obj, mime: obj.type, bytes: obj.size });
            state.blobFiles = blobFiles.length;
            bump();
          }
        } catch (e) { /* ignore */ }
        return origCOU.apply(this, arguments);
      };
    }

    window.__mgMedia = {
      buckets: all,
      blobs: blobFiles,
      trackInfo,
      pickTrackIndex,
    };
    mediaApi = window.__mgMedia;
  }

  // ---------------------------------------------------------------------
  // 导出通道：把捕获到的分片拼成文件并交给浏览器保存
  //
  // ⚠️ 必须由**页面自己**触发，**不能**走 background 的
  // chrome.scripting.executeScript。
  //
  // 血泪教训（v1.3.3 实测）：扩展一重载，已打开页面里 content script 的
  // chrome.runtime 通道立刻作废（报 `Extension context invalidated`），
  // 但**这份 MAIN world 钩子和它抓到的字节完好无损**。偏偏拼装只能在 MAIN
  // world 里做（分片存在这边的内存里），而我把触发点放在了 background ——
  // 于是出现「数据明明抓到 7.7MB，导出却报 Extension context invalidated」，
  // 然后一路跌回 blob 分支，又下出一个 15KB 的垃圾文件。
  //
  // 改走 DOM 事件：content script 派发 `__mg_assemble`，这里拼装 + 触发下载，
  // 再用 `__mg_assemble_done` 把结果报回去。全程不碰 chrome.runtime，
  // 只要扩展没被卸载就一定能用。detail 用 JSON 字符串 —— 跨世界只传字符串可靠。
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // MP4 box 解析 —— 判断"捕获到的分片能不能直接拼"
  //
  // 为什么需要它：exportAssembly 早期是 `new Blob(best.chunks)`，把
  // appendBuffer 收到的东西按**调用顺序**直接拼起来。对"整条流只有一个初始化段"
  // 的情况这是对的，但播放器在分片切换 / 重建 MediaSource 时会把 `ftyp`+`moov`
  // 再 append 一遍 —— 拼出来的文件里就有多个 moov，播放器只认第一个，
  // 于是症状是「文件 80MB、却只播前 5 秒」（5 秒 = 单个 HLS 分片的时长）。
  // 字节一个不少，但第一个 init 之后的全部数据都不可达。
  //
  // 这里只读 box 头部（4 字节 size + 4 字节 type），不深挖内容，代价可忽略。
  // 若首个 box 就解析不出合法 size（例如 MPEG-TS 以 0x47 同步字节开头），
  // 返回空数组 —— 调用方据此判定"不是 fMP4 分片"，不做任何改动。
  // ---------------------------------------------------------------------

  const boxTypeAt = (u8, off) => String.fromCharCode(
    u8[off], u8[off + 1], u8[off + 2], u8[off + 3],
  );

  /**
   * MPEG-TS 分片的判据：以 0x47 同步字节开头，并在 188（或 192）字节周期上
   * 再次出现。TS 没有 box 结构，照 box 去解析只会得到垃圾 size —— 必须先挡住，
   * 否则后面的 init 识别就是在噪声上做判断。
   */
  function looksLikeTs(u8) {
    if (u8.length < 188 || u8[0] !== 0x47) return false;
    if (u8.length > 188 && u8[188] === 0x47) return true;
    if (u8.length > 192 && u8[192] === 0x47) return true;
    return false;
  }

  function scanBoxes(u8) {
    if (looksLikeTs(u8)) return [];

    const out = [];
    let off = 0;
    let guard = 0;
    while (off + 8 <= u8.length && guard < 4096) {
      guard += 1;
      const size = ((u8[off] << 24) | (u8[off + 1] << 16)
        | (u8[off + 2] << 8) | u8[off + 3]) >>> 0;
      const type = boxTypeAt(u8, off + 4);

      if (size === 1) {
        // 64 位 size 字段：紧跟 8 字节大端长度。
        if (off + 16 > u8.length) break;
        const hi = ((u8[off + 8] << 24) | (u8[off + 9] << 16)
          | (u8[off + 10] << 8) | u8[off + 11]) >>> 0;
        const lo = ((u8[off + 12] << 24) | (u8[off + 13] << 16)
          | (u8[off + 14] << 8) | u8[off + 15]) >>> 0;
        const big = hi * 0x100000000 + lo;
        out.push({ type, offset: off, size: big, truncated: big > u8.length - off });
        if (big <= 0) break;
        off += big;
        continue;
      }

      if (size < 8) break;   // 非法 → 后面不是 box 结构（TS 流 / 数据错位）
      out.push({ type, offset: off, size, truncated: size > u8.length - off });
      if (size === 0) break; // 延伸到末尾
      off += size;
    }
    return out;
  }

  /** 扫描全部分片，统计 box 构成。既用于诊断，也用于决定要不要剥离重复 init。 */
  function analyzeChunks(chunks) {
    const counts = Object.create(null);
    const layout = [];
    let initCount = 0;
    let nonBox = 0;
    let total = 0;
    for (const ch of chunks) {
      if (!ch || !ch.length) continue;
      total += 1;
      const boxes = scanBoxes(ch);
      if (!boxes.length) {
        nonBox += 1;
        if (layout.length < 40) layout.push('?');
        continue;
      }
      const seq = [];
      for (const b of boxes) {
        counts[b.type] = (counts[b.type] || 0) + 1;
        if (b.type === 'ftyp') initCount += 1;
        seq.push(b.type);
      }
      if (layout.length < 40) layout.push(seq.join('+'));
    }
    return { chunks: total, initCount, nonBox, counts, layout };
  }

  /**
   * 删掉**第二个及之后**的初始化段（`ftyp` + `moov`）。
   *
   * 判据是"已经见过一个 init"，不是"看到 ftyp 就删"——只出现一次的 init 必须
   * 原样保留，否则整条流都没法解码。跨 chunk 的 init（box 声明的 size 超出当前
   * chunk 范围）一律不碰：宁可留着多余的 init，也不能把数据切坏。
   */
  function stripExtraInit(chunks) {
    let seen = 0;
    let dropped = 0;
    let droppedBytes = 0;
    const out = [];

    for (const ch of chunks) {
      if (!ch || !ch.length) continue;
      const boxes = scanBoxes(ch);
      if (!boxes.length) { out.push(ch); continue; }

      let hasInit = false;
      let initEnd = 0;
      let unsafe = false;
      for (const b of boxes) {
        if (b.type === 'ftyp') hasInit = true;
        if (!hasInit) continue;
        // init 段只由 ftyp 与 moov 组成，遇到别的 box 就说明 init 到头了。
        if (b.type !== 'ftyp' && b.type !== 'moov') break;
        if (b.truncated) { unsafe = true; break; }
        initEnd = b.offset + b.size;
      }

      if (!hasInit || unsafe || initEnd <= 0) { out.push(ch); continue; }

      seen += 1;
      if (seen === 1) { out.push(ch); continue; }   // 第一个照留

      dropped += 1;
      droppedBytes += initEnd;
      out.push(initEnd < ch.length ? ch.subarray(initEnd) : new Uint8Array(0));
    }

    return { chunks: out, dropped, droppedBytes, seen };
  }

  /**
   * 把一个 Blob / File 交给浏览器下载。
   *
   * 两条通道（缓存导出、整片 Range 拉取）都在**页面世界**里落地文件，所以共用
   * 这一份实现。必须在页面世界做的原因：blob: URL 与字节都在这边，而且这条
   * 路径是唯一被实测证明不会被下载管理器扩展接管的（见 motrix-next-extension
   * 的 filter.ts：scheme 阶段只放行 http/https，blob: 免疫）。
   */
  function deliverBlob(blob, filename) {
    const href = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = href;
      a.download = filename || 'video.mp4';
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(href), 120000);
    }
    return href;
  }

  function exportAssembly(filename, trackIndex) {
    const media = mediaApi || window.__mgMedia;
    const buckets = (media && media.buckets) || [];
    if (!buckets.length) return { ok: false, error: '没有捕获到 MSE 数据' };

    // 每条轨的画像都回传：面板要拿它算"已缓存 X / 整片 Y"，也要靠 duration
    // 直接告诉用户"你手上这份只有 75 秒，而这条片子是 523 秒"。
    const tracks = buckets.map((b) => (media && media.trackInfo
      ? media.trackInfo(b)
      : { bytes: b.bytes, mime: b.mime || '' }));

    // 选轨：优先按「关联到的 <video> 在版面上的占位面积」——媒体查看器里的
    // 正片一定比聊天里的表情/头像大。指定了 trackIndex 就用指定的。
    const chosen = typeof trackIndex === 'number' && buckets[trackIndex]
      ? trackIndex
      : ((media && media.pickTrackIndex) ? media.pickTrackIndex() : 0);

    const best = buckets[chosen];
    if (!best || !best.bytes) return { ok: false, error: 'MSE 数据为空', tracks };

    // ---- 拼装前的 box 体检 + 重复初始化段剥离 ----------------------------
    //
    // 这一步是"导出只有前 5 秒"的修法。体检结果无论如何都回传 —— 剥离是
    // 启发式的，把依据公开出来，才能在下一次出问题时立刻分清是「重复 init」
    // 「分片乱序」还是「根本不是 fMP4（TS 流）」。
    const boxInfo = analyzeChunks(best.chunks);
    const fix = stripExtraInit(best.chunks);

    if (fix.dropped) {
      diag('warn', '[MediaGrab] 缓存里有', fix.dropped, '个重复初始化段（',
        fix.droppedBytes, '字节），已剥离');
    }
    diag('info', '[MediaGrab] MSE 拼装体检 —— 分片:', boxInfo.chunks,
      '· ftyp(初始化段):', boxInfo.initCount,
      '· 非 box 分片:', boxInfo.nonBox,
      '· box 统计:', boxInfo.counts,
      '· 前若干分片:', boxInfo.layout.slice(0, 10).join(' | '));

    const mime = /^audio\//i.test(best.mime || '') ? best.mime : 'video/mp4';
    const blob = new Blob(fix.chunks, { type: mime });
    deliverBlob(blob, filename);
    return {
      ok: true,
      size: blob.size,
      mime,
      tracks,
      chosen,
      picked: tracks[chosen] || null,
      boxInfo,
      strip: { dropped: fix.dropped, droppedBytes: fix.droppedBytes },
    };
  }

  document.addEventListener('__mg_assemble', (ev) => {
    let req = {};
    try { req = JSON.parse((ev && ev.detail) || '{}'); } catch (e) { /* 忽略非法 detail */ }

    let result;
    try {
      result = exportAssembly(req.filename, req.trackIndex);
    } catch (e) {
      result = { ok: false, error: String((e && e.message) || e) };
    }

    // 结果同时写 dataset（诊断用）和回发事件（content script 取值）。
    try { document.documentElement.dataset.mgLastExport = JSON.stringify(result); } catch (e) { /* ignore */ }
    try {
      document.dispatchEvent(new CustomEvent('__mg_assemble_done', {
        detail: JSON.stringify(result),
      }));
    } catch (e) { /* ignore */ }
  }, false);

  // ---------------------------------------------------------------------
  // 通道 5：整片 Range 拉取 —— **必须**在页面世界执行
  //
  // 这是 v1.5.2 才定位到的根本原因，值得完整写下来：
  //
  //   Telegram 的 `/stream/` 与 `/hls_stream/` 不是普通 HTTP 资源，它们由
  //   **页面自己的 Service Worker** 兑现（onStreamFetch / onHlsStreamFetch：
  //   SW 拿 MTProto 把分块喂进 ReadableStream，再自己造 Response）。
  //
  //   而**隔离世界发起的 fetch 不会被页面 SW 拦截** —— 请求直连 Telegram 的
  //   服务器，被 302 到 cdn-api.telegram.org；那个 CDN 没有 ACAO 头，于是页面
  //   世界之外一个字节也拿不到。
  //
  //   证据（v1.5.2 实测）：两条候选全部 `HTTP 302`；而 tweb 源码里**没有任何
  //   地方**返回 302（全仓只有 share.ts 的 `Response.redirect('..')`），所以那个
  //   302 一定来自网络层，不是 SW。同一条 URL 由**页面自己**请求就能正常播放 ——
  //   唯一的差别是发起请求的世界。
  //
  //   顺带解释了此前一连串"修上游却不见好"的现象：v1.3.9 漏认 `/hls_stream/`、
  //   v1.4.0 开区间只回 1 字节、v1.5.0 弹两次另存为 —— 全都在修一条**从未通电
  //   的通路**。Range 语义、完整性闸门、落盘顺序这些修得对不对都无所谓，
  //   因为请求根本没进 SW。
  //
  // 协议是 DOM 事件（跨世界只传 JSON 字符串），不碰 chrome.runtime：扩展一
  // 重载，隔离世界的通道立刻作废，而页面世界的这份脚本和数据都还在。
  //
  //   隔离 → 页面：__mg_dl_start   {reqId, url, declared, filename}
  //   页面 → 隔离：__mg_dl_status  {reqId, phase, ...}
  //                       phase = accepted | probe | progress | done | failed
  //
  // `phase: 'accepted'` 是**握手**：隔离世界等不到它就判定"页面世界没装钩子"
  // （扩展重载前页面就已加载完的场合），转而走自己那条已知会被 302 的兜底路。
  // ---------------------------------------------------------------------

  const RF = globalThis.MediaGrabRangeFetch;
  const Staging = globalThis.MediaGrabStaging;

  function emitStatus(reqId, patch) {
    try {
      document.dispatchEvent(new CustomEvent('__mg_dl_status', {
        detail: JSON.stringify(Object.assign({ reqId }, patch)),
      }));
    } catch (e) { /* ignore */ }
  }

  /**
   * 只读探测：`Range: bytes=0-0`。
   *
   * 存在的理由有两个，缺一不可：
   *   1. 拿到文件总长度 —— 它是完整性断言的依据（服务端提前结束流时能发现）；
   *   2. **确认这条端点真的兑现字节**。端点不可用时磁盘上一个文件都不会建。
   *      顺序反过来就是 v1.5.0 那个「候选 N 条弹 N 次另存为、每次留 0 字节」。
   */
  async function dlProbe(url) {
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        credentials: 'include',
        cache: 'no-store',
      });

      if (resp.status !== 200 && resp.status !== 206) {
        // 302 单独说：那是"请求没被页面 SW 拦截、去了 CDN"的指纹，
        // 也就是说这条路在当前上下文里根本走不通，而不是视频有问题。
        return { ok: false, reason: resp.status === 302 ? 'sw-bypass' : 'http', status: resp.status };
      }

      const range = resp.headers.get('Content-Range') || '';
      const m = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      const total = m ? Number(m[3]) : (Number(resp.headers.get('Content-Length')) || null);
      const mime = (resp.headers.get('Content-Type') || '').split(';')[0].trim();

      // 只探测，不消费 body。1 个字节，显式取消更干净。
      try { if (resp.body && resp.body.cancel) await resp.body.cancel(); } catch (e) { /* ignore */ }

      if (!total) return { ok: false, reason: 'no-length' };
      return { ok: true, total, mime: mime || null };
    } catch (e) {
      return { ok: false, reason: 'network', error: String((e && e.message) || e) };
    }
  }

  /** 把 rangeFetch 的错误分类成机器可读的 reason，交给隔离世界翻成人话。 */
  function classifyFailure(err) {
    if (Staging && Staging.isQuotaError(err)) return 'quota';
    const msg = String((err && err.message) || err);
    // 「挂起」要单独一类：它不是文件坏了，也不是网络断了，而是 tweb 的
    // RequestSynchronizer 里存了一个永不 settle 的 promise（见 rangeFetch
    // 的 DEFAULT_CHUNK_TIMEOUT_MS 注释）。用户该知道"重试或刷新"有意义。
    if (/挂起/.test(msg)) return 'stalled';
    if (/字节数不足|字节数与文件声明不符|分块长度不符|分块不连续|总长度前后不一致|Content-Range|响应体不完整|不是媒体/.test(msg)) {
      return 'integrity';
    }
    if (/HTTP 4\d\d/.test(msg)) return 'http';
    return 'network';
  }

  async function runStreamDownload(req) {
    const url = String(req.url || '');
    const reqId = String(req.reqId || '');

    // 握手：先告诉隔离世界"这条通道活着"，它才不会以为钩子没装。
    emitStatus(reqId, { phase: 'accepted', via: 'main' });

    if (!RF || !RF.fetchRangeToWriter) {
      emitStatus(reqId, { phase: 'failed', reason: 'no-module', error: 'rangeFetch 模块未加载' });
      return;
    }
    if (!Staging || !Staging.open) {
      emitStatus(reqId, { phase: 'failed', reason: 'no-module', error: 'staging 模块未加载' });
      return;
    }
    if (!url) {
      emitStatus(reqId, { phase: 'failed', reason: 'no-url', error: '缺少 URL' });
      return;
    }

    const probe = await dlProbe(url);
    if (!probe.ok) {
      console.warn('[MediaGrab] [页面世界] 端点探测失败', probe);
      emitStatus(reqId, {
        phase: 'failed', reason: probe.reason, status: probe.status || 0, error: probe.error || '',
      });
      return;
    }
    emitStatus(reqId, { phase: 'probe', total: probe.total, mime: probe.mime });

    const declared = Number(req.declared) || probe.total || null;
    const name = String(req.filename || 'video.mp4');

    // 探测通过之后才建写入器 —— 顺序不能反，理由见 dlProbe 的注释。
    // expectTotal 传下去是为了**断点续传**：页面刷新会中止下载（字节只能在
    // 页面世界拉，而页面一卸载就没了），但 OPFS 里的暂存文件还活着。
    // 不给它 expectTotal 的话 createWritable() 会 truncate，一刷新就从头再来
    // （1.8.0 实测：「页面一刷新，下载就重置了」）。
    const stage = await Staging.open(name, { expectTotal: declared });
    diag('info', '[MediaGrab] [页面世界] 落盘方式:', stage.kind === 'opfs' ? 'OPFS 暂存' : '内存打包',
      '· 总长:', probe.total,
      stage.resumeFrom ? `· 从断点续传（已有 ${stage.resumeFrom}）` : '');

    let result;
    try {
      result = await RF.fetchRangeToWriter({
        url,
        writer: stage.writer,
        // 端点 URL 自带的总字节数做最后一票否决：拉完的字节数必须等于它。
        expectBytes: declared,
        // 断点：OPFS 里已有的字节不再重拉。
        startOffset: stage.resumeFrom || 0,
        initialTotal: stage.resumeFrom ? probe.total : null,
        onProgress: ({ received, total, offset }) => {
          emitStatus(reqId, {
            phase: 'progress',
            received,
            // offset 是**绝对**位置；续传时 received 只是本次会话的增量，
            // 直接拿它画进度条会让百分比从 0 重新爬（用户看着像"下载重置"）。
            offset: offset === undefined ? received : offset,
            total: total || declared || 0,
          });
        },
      });
    } catch (e) {
      // 失败必须清干净：abort 句柄 + 删掉暂存条目，不留任何用户可见的文件。
      await stage.discard();
      console.error('[MediaGrab] [页面世界] 分块下载失败', e, e && e.detail);
      emitStatus(reqId, {
        phase: 'failed',
        reason: classifyFailure(e),
        error: String((e && e.message) || e),
        detail: (e && e.detail) || null,
        // 挂起类失败要单独标出来：它和"文件坏了"是两回事，用户该知道该做什么。
        stalled: !!(e && e.detail && e.detail.stalled),
      });
      return;
    }

    if (!result.bytes) {
      await stage.discard();
      emitStatus(reqId, { phase: 'failed', reason: 'empty', error: '拉取到空内容' });
      return;
    }

    diag('info', '[MediaGrab] [页面世界] 分块完成 —— 字节:', result.bytes,
      '/ 服务端声明:', result.total === null ? '未知' : result.total,
      '/ URL 声明:', declared === null ? '未知' : declared,
      '· mime:', result.mime || '未知');

    let file = null;
    try {
      file = await stage.finish();
    } catch (e) {
      emitStatus(reqId, {
        phase: 'failed', reason: classifyFailure(e),
        error: `写入落盘文件失败：${(e && e.message) || e}`,
      });
      return;
    }

    // OPFS 暂存 → File 由磁盘支撑，浏览器从磁盘流式读，不会把整片读进内存。
    // 内存路径 → 这里才把分块拼成 Blob（峰值内存 = 文件大小）。
    const body = file || new Blob(result.chunks, { type: result.mime || 'video/mp4' });
    deliverBlob(body, name);
    void stage.cleanup();

    emitStatus(reqId, {
      phase: 'done',
      size: result.bytes,
      total: result.total,
      carried: result.carried || 0,
      mime: result.mime || '',
      name,
      kind: stage.kind,
      via: 'main',
    });
  }

  document.addEventListener('__mg_dl_start', (ev) => {
    let req = {};
    try { req = JSON.parse((ev && ev.detail) || '{}'); } catch (e) { return; }
    if (!req || !req.reqId) return;
    runStreamDownload(req).catch((e) => {
      console.error('[MediaGrab] [页面世界] 下载通道异常', e);
      emitStatus(String(req.reqId), {
        phase: 'failed', reason: 'internal', error: String((e && e.message) || e),
      });
    });
  }, false);

  // 立刻尝试写一次，让 content script 尽早看到 mgHook 标记。
  flush();
})();

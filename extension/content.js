/**
 * MediaGrab content script.
 *
 * Detects the video on the current page, injects a small download control next
 * to the player, and drives the job through the service worker.
 *
 * Everything lives in a closed shadow root so host-page CSS cannot leak in and
 * our styles cannot leak out.
 */

(() => {
  if (window.__mediaGrabLoaded) return;
  window.__mediaGrabLoaded = true;

  // -------------------------------------------------------------------------
  // site recognition
  // -------------------------------------------------------------------------

  // Site rules live in sites.js so the popup can reuse the exact same logic.
  const Sites = globalThis.MediaGrabSites || {
    detectFromUrl: () => ({ kind: 'none' }),
    hostOf: () => '',
    isAuthHref: () => false,
  };

  function detect() {
    // 登录 / 账号页先拦一道。sites.js 的 detectFromUrl 已经会返回 none，但这里
    // 必须**在 DOM 兜底之前**返回 —— 否则登录页插画那种装饰性 <video> 会被
    // 下面的兜底重新捡回来，按钮照样飘出来（v1.3.5 实测现象）。
    if (Sites.isAuthHref(location.href)) {
      return { kind: 'none', reason: '登录 / 账号页，已跳过' };
    }

    const byUrl = Sites.detectFromUrl(location.href);
    if (byUrl.kind !== 'none') return byUrl;

    // A media file served directly as the document itself.
    if (/^video\//.test(document.contentType || '')) {
      return { kind: 'direct', site: '直链', url: location.href.split('#')[0] };
    }

    // Any page with an HTML5 player: fall back to the element's own source.
    // This also catches home/feed pages that sites.js deliberately rejects.
    const el = biggestVideo();
    if (el) {
      const src = directSource(el);
      if (src) return { kind: 'direct', site: Sites.hostOf(location.href), url: src };

      // 有 <video> 但拿不到 http(s) 直链 —— 只在这两种**有正向证据**的情况下
      // 才认定它是 MSE 播放器并给出下载入口：
      //   (a) 站点本来就是我们支持的 MSE 站点（X.com、Telegram）；
      //   (b) MAIN world 钩子真的抓到了字节或 API 里的 mp4。
      //
      // 早先这里是无条件的：只要页面上有个 blob: 视频就弹按钮，结果登录页、
      // 官网首页那种自动播放的装饰动画也会被判成"视频页"。
      if (MSE_SITE_RE.test(Sites.hostOf(location.href)) || hasCapturedMedia()) {
        return { kind: 'direct', site: Sites.hostOf(location.href), url: null, mse: true };
      }
    }

    return { kind: 'none' };
  }

  /**
   * 已知把视频藏在 MSE / API 元数据里的站点。别的地方就算出现 `blob:` 视频，
   * 也多半只是装饰性动画，不值得为它弹按钮。
   */
  const MSE_SITE_RE = /^(?:x|twitter)\.com$|^(?:t\.me|telegram\.me|web\.telegram\.org|webk\.telegram\.org|webz\.telegram\.org)$/;

  /**
   * MAIN world 的钩子有没有抓到真东西。dataset 由 hooks.js 写：
   *   mgMse    —— appendBuffer 累计字节数
   *   mgVideos —— 从 API 响应体里挖出的 mp4 直链（X 的 video_info.variants）
   * 任一非空，就说明这页确实有视频在播，弹按钮不会被骂。
   */
  function hasCapturedMedia() {
    const ds = document.documentElement && document.documentElement.dataset;
    if (!ds) return false;
    if (Number(ds.mgMse) > 0) return true;
    return (ds.mgVideos || '').split('|').filter(Boolean).length > 0;
  }

  /**
   * 装饰性 <video>（登录页插画、页头背景动画之类）不该被当成可下载视频。
   *
   * 判据只取「作者明确声明这是装饰」的两种高精度标记，**不用 muted/autoplay/loop
   * 去猜** —— X 和 Telegram 的自动播放视频正好同时满足那三条，按那个筛会把
   * 真正要下的视频一起误杀。
   */
  function isDecorativeVideo(el) {
    if (!el) return false;
    if (el.getAttribute('role') === 'presentation') return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    // 祖先只往上找 4 层：装饰容器的标记一般在就近的包裹元素上；再往上找会把
    // 「整块区域被标成 aria-hidden」的正常播放器也吞掉。
    let p = el.parentElement;
    for (let up = 0; p && up < 4; up += 1, p = p.parentElement) {
      if (p.getAttribute && p.getAttribute('aria-hidden') === 'true') return true;
    }
    return false;
  }

  function biggestVideo() {
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('video')) {
      if (isDecorativeVideo(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 160 || rect.height < 100) continue;
      const area = rect.width * rect.height;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  /**
   * 页面上最大的那个 <video> 是否正由 MediaSource 播放（src 是 blob:）。
   *
   * 这是「MSE 站点」的判据：X.com、Telegram 的 /a/ 播放器都属于这一类。
   * 它们的字节只能从 appendBuffer 钩子或 API 元数据里拿，不要走 URL 下载。
   */
  function hasMseVideo() {
    const el = biggestVideo();
    if (!el) return false;
    const s = el.getAttribute('src') || el.currentSrc || el.src || '';
    return /^blob:/i.test(s);
  }

  /**
   * 页面上正在播放的那条视频的 mediaId（X / Twitter）。
   *
   * 为什么需要：X 的 GraphQL timeline / 个人主页响应里含**多条**推文，
   * hooks.js 会把它们的 video_info.variants 全挖出来。想从 URL 反推哪条是
   * 当前这条是做不到的 —— video.twimg.com/amplify_video/<mediaId> 里的
   * mediaId 与 tweet id 不同源。
   *
   * 但页面上的 <video> 的 poster 就是
   *   https://pbs.twimg.com/amplify_video_thumb/<mediaId>/img/<hash>.jpg
   * 与视频 URL 里的 /amplify_video/<mediaId>/ 一致。取交集即可锁定当前这条。
   */
  function currentMediaId() {
    const el = biggestVideo();
    if (!el) return null;
    const poster = el.getAttribute('poster') || '';
    const m = poster.match(/amplify_video_thumb\/(\d+)/i)
           || poster.match(/amplify_video\/(\d+)/i);
    if (m) return m[1];
    const src = el.getAttribute('src') || '';
    const m2 = src.match(/amplify_video\/(\d+)/i);
    return m2 ? m2[1] : null;
  }

  /**
   * 从 <video> 取可下载 URL。
   *
   * 关键：**优先读 src 属性，而不是 currentSrc**。
   *
   * 这条经验是抄来的：Neet-Nestor/Telegram-Media-Downloader（Greasy Fork 上下载
   * 量最高的 Telegram 下载脚本）全文只做一件事——读 `video.src`，然后对它发
   * `Range: bytes=N-` 的 fetch。Telegram Web K 把
   *   stream/{"dcId":5,"location":{...},"fileName":"xxx.MP4"}
   * 这种**相对路径**写进 src 属性；而 `currentSrc` 是 MSE 生成的 blob
   * （主线程 blob registry 里不存在，fetch 必报 ERR_FILE_NOT_FOUND）。
   *
   * 我前几轮一直读 currentSrc，所以一路拿到 blob 往死胡同里撞。
   */
  function directSource(el) {
    // 1. src 属性 + <source> 的 src 属性。两者都可能是相对路径（Telegram 就是）。
    const attrs = [];
    if (el.getAttribute) {
      const own = el.getAttribute('src');
      if (own) attrs.push(own);
    }
    for (const source of el.querySelectorAll('source')) {
      const s = source.getAttribute('src') || source.src;
      if (s) attrs.push(s);
    }
    for (const raw of attrs) {
      if (typeof raw !== 'string' || !raw) continue;
      if (/^(blob|data|javascript):/i.test(raw)) continue;
      try {
        // 相对路径按当前页面解析 —— Telegram 的 stream/... 就靠这一步变成绝对 URL。
        const abs = new URL(raw, location.href).href;
        if (/^https?:/i.test(abs)) return abs;
      } catch (e) { /* ignore */ }
    }

    // 2. 兜底：currentSrc / src property，**只认 http(s)**。
    //
    // 绝不接受 `blob:`。MSE 站点（X.com、Telegram 的 /a/ 播放器）的
    // `<video src>` 就是 `blob:https://<origin>/<uuid>` —— 那是 MediaSource
    // 的引用，不是 Blob。页面里 fetch 它必报 net::ERR_FILE_NOT_FOUND，
    // 浏览器下载通道也取不到字节。
    // 把它当"直链"返回的代价是整页被判成 kind: 'direct'，按钮点下去必然失败
    // （v1.3.1 实测就是这个现象）。blob 仍会被 sniffDirect() 单独收进
    // sniffer.blobs，交给 MSE 拼装分支处理，不会丢。
    for (const candidate of [el.currentSrc, el.src]) {
      if (!candidate) continue;
      if (/^https?:/.test(candidate)) return candidate;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // direct-link sniffing
  //
  // Chrome's downloader can only take a *single-file* URL, so we look for one
  // the page has already fetched: the <video> element's own source, plus the
  // resource timeline (X fetches its mp4 renditions as ordinary resources).
  // Resolving this way means the browser channel starts instantly and never
  // touches yt-dlp.
  // -------------------------------------------------------------------------

  const FILE_EXT_RE = /\.(mp4|m4v|mov|webm)(?:[?#]|$)/i;
  const STREAM_EXT_RE = /\.(m3u8|mpd|m4s|ts)(?:[?#]|$)/i;
  const DIMS_RE = /(?:^|[/_\-.=])(\d{3,4})x(\d{3,4})(?:[/_\-.?]|$)/;

  // Telegram 的分块响应带 Content-Range，形如 "bytes 0-524287/12345678"。
  // 正则（照抄 Neet-Nestor/Telegram-Media-Downloader 的 contentRangeRegex）
  // 与整套分块循环都搬到了 rangeFetch.js —— 那儿能在 Node 里单测。
  // 用法见 downloadByChunks。

  /**
   * Rank a rendition by its *shorter* side, which is what "720p" means for
   * portrait and landscape alike (1080x1920 and 1920x1080 are both 1080p).
   * Using the longer side would make a portrait 1080p stream outrank a cap.
   */
  function qualityKey(f) {
    const w = f.width || 0;
    const h = f.height || 0;
    if (!w || !h) return 0;
    return Math.min(w, h);
  }

  // Telegram Web K 用页面自己的 Service Worker 兑现的媒体字节端点。真正有
  // 字节的是下面**两种**（都同源、都支持 Range、URL 末段都是 JSON 参数）：
  //
  //   /k/stream/{JSON}         progressive 播放：<video src> 直接指向它。
  //   /hls_stream/{JSON}       HLS 播放：hls.js 拉分片时请求它。
  //                            （媒体查看器在有 alt 画质文档时会走 HLS ——
  //                              见 web.telegram.org 的 mediaViewer/base.ts：
  //                              `isHlsStream = this.hasQualityOptions`，
  //                              然后 getDocumentURL(media, {supportsHlsStreaming:true})，
  //                              再由 createVideo.ts 的 src setter 交给 initVideoHls。）
  //
  // ⚠️ 必须排除 `/hls/{JSON}` 与 `/hls_quality_file/{id}` —— 那两个返回的是
  // **playlist 文本**，不是媒体字节，认进来会拼出一个纯文本文件。
  //
  // ⚠️ `/hls_stream/` 这条长期缺失，而且症状是**静默降级**而不是报错：
  // 旧正则 `/\/stream\//` 匹配不到 `hls_stream`（它前面是 `_` 不是 `/`），
  // 于是候选为空 → 掉到「播放器缓存导出」→ 只导出已经 append 过的那一小段。
  // 用户看到的就是「13 分钟的视频，下下来只有前几秒」。
  //
  // 另外这两个端点的 URL 里没有 <file_id>/<access_hash>，末段是
  // encodeURIComponent 后的 JSON（getFileURL = type + '/' + encodeURIComponent(...)），
  // 里面有 size / mimeType / fileName —— 见 streamParams()。
  const STREAM_PATH_RE = /(?:^|\/)(?:stream|hls_stream)\//i;

  /**
   * 同源流端点才算「站点自己的媒体流」。
   * 跨源 CDN 上恰好叫 /stream/ 的路径（video.twimg.com 之类）不在此列，
   * 那些走普通扩展名规则。
   */
  function isSameOriginStream(url) {
    try {
      const u = new URL(url, location.href);
      return u.origin === location.origin && STREAM_PATH_RE.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  /**
   * 本页的视频是否**只存在于页面运行时**。
   *
   * 判据是三件事之一：
   *   a. `current.mse` —— DOM 兜底认定这是 MSE 播放器页（<video src> 是 blob:），
   *      例如 Telegram 的媒体查看器、X 信息流里正在播的那条；
   *   b. `current.url` 本身就是同源流端点；
   *   c. 页面上最大的 <video> 的 src 是 blob:（还没有候选时也能判）。
   *
   * **为什么需要它**：这类页面的字节由页面自己的 Service Worker / hls.js 现造，
   * 地址里带着页面会话才有意义。把这些交给 yt-dlp，只要 yt-dlp 拿到的输入是
   * 页面地址本身，结果必然是 `ERROR: Unsupported URL: https://web.telegram.org/...`
   * —— 一句英文报错、零信息量，用户会以为是扩展坏了。
   *
   * 所以这类页面上：yt-dlp 选项直接禁用、强制走「浏览器下载」，
   * 并且 yt-dlp 那条路上再补一道守卫（防止有人从别的入口进来）。
   */
  function runtimeStreamOnly() {
    if (current && current.mse === true) return true;
    if (isSameOriginStream((current && current.url) || '')) return true;
    return false;
  }

  /**
   * 解析同源流端点 URL 末段那段 JSON 参数。
   *
   * tweb 的 `getFileURL(type, options)` 就是
   * `type + '/' + encodeURIComponent(JSON.stringify(options))`，所以最后一段
   * path 一定是 JSON，里面有我们需要的全部元数据：
   *
   *   size      —— 文件总字节数。**这是下载完整性断言的依据**：
   *                分块拉完之后字节数必须等于它，否则宁可报错也不交付半截文件。
   *   mimeType  —— 决定扩展名（video/mp4 → mp4）。
   *   fileName  —— 原始文件名，比我们自己拼的名字好。
   *
   * 拿不到（不是这种端点、或参数被改了）就返回 null，调用方各自兜底。
   */
  function streamParams(url) {
    try {
      const parts = new URL(url, location.href).pathname.split('/').filter(Boolean);
      const meta = JSON.parse(decodeURIComponent(parts[parts.length - 1] || ''));
      return meta && typeof meta === 'object' ? meta : null;
    } catch (e) {
      return null;
    }
  }

  function sniffDirect() {
    const found = new Map();
    const streamed = new Set();
    const blobs = new Set();

    const consider = (raw, origin) => {
      if (!raw || typeof raw !== 'string') return;
      let parsed;
      // base 用 location.href：Telegram 的 stream/... 是相对路径，
      // 属性里拿出来必须相对解析成绝对 URL 才能进 Map 去重。
      try { parsed = new URL(raw, location.href); } catch (e) { return; }
      const protocol = parsed.protocol;

      // blob: URL 只保留 http-origin 生成的，忽略其他页面的
      if (protocol === 'blob:') {
        if (parsed.origin === location.origin) blobs.add(parsed.href);
        return;
      }

      if (!/^https?:/i.test(protocol)) return;
      const path = parsed.pathname;

      if (STREAM_EXT_RE.test(path)) { streamed.add(parsed.href); return; }

      // Telegram stream 端点没扩展名，直接认路径特征（限同源）
      if (isSameOriginStream(parsed.href)) {
        if (!found.has(parsed.href)) {
          found.set(parsed.href, {
            url: parsed.href,
            ext: 'mp4',
            width: null,
            height: null,
            origin: 'network',
            direct: true,
            // 首次被看到的时间：判断"当前在播哪一条"就靠它
            at: streamUrlSeenAt(parsed.href),
          });
        }
        return;
      }

      if (!FILE_EXT_RE.test(path) || found.has(parsed.href)) return;

      const dims = path.match(DIMS_RE);
      // X.com 把音轨与视频轨拆成单独文件：
      //   .../vid/avc1/0/0/1280x720/xxxx.mp4   只有画面（DASH 视频轨）
      //   .../aud/mp4a/0/0/128000/xxxx.mp4      只有声音（DASH 音频轨）
      //   .../vid/avc1/0/3000/1280x720/xx.m4s   分片
      // 而 progressive 单文件是 .../vid/avc1/1280x720/xxxx.mp4 —— codec 之后
      // 直接跟分辨率，没有中间那两段纯数字。用「codec 后跟两段纯数字」精确
      // 区分，避免把 API 给回来的完整 mp4 一起误杀。
      const partial = /\/(?:vid|aud)\/(?:avc1|mp4a)\/\d+\/\d+\//i.test(path)
                   || /\.m4s(?:[?#]|$)/i.test(path);
      found.set(parsed.href, {
        url: parsed.href,
        ext: path.slice(path.lastIndexOf('.') + 1).toLowerCase(),
        width: dims ? parseInt(dims[1], 10) : null,
        height: dims ? parseInt(dims[2], 10) : null,
        origin,
        partial,
      });
    };

    // <video> 元素：先走 directSource（内部优先 src 属性，能把 Telegram 的
    // 相对 stream/... 解析成绝对 URL），再补一遍 currentSrc / <source> 兜底。
    for (const el of document.querySelectorAll('video')) {
      const attr = directSource(el);
      if (attr) consider(attr, 'element');
      consider(el.currentSrc, 'element');
      for (const source of el.querySelectorAll('source')) {
        consider(source.getAttribute('src') || source.src, 'element');
      }
    }

    // The timeline is capped at 250 entries by default, which a busy feed can
    // exhaust before the video is reached.
    try { performance.setResourceTimingBufferSize(1000); } catch (e) { /* not fatal */ }
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        consider(entry.name, 'network');
      }
    } catch (e) { /* resource timing unavailable */ }

    // 合并持久 stream URL 收集器——performance buffer 会被新加载的资源覆盖，
    // 用户在面板上多停留一会儿后原始 /k/stream/ 条目可能被踢掉，靠 collector 兜底。
    // 收集器是 Map（url → 首次出现时间），这里取 key。
    for (const raw of streamCollector.keys()) {
      consider(raw, 'network');
    }

    // API 响应体里挖出来的 mp4（X 的 GraphQL variants）——这是权威来源：
    // 它就是媒体元数据里"音视频唯一的 progressive 单文件"那一条，不做
    // partial 判定（其中不少路径带 /vid/avc1/，会被上面的启发式误杀）。
    for (const raw of apiVideoCollector) {
      let parsed;
      try { parsed = new URL(raw, location.href); } catch (e) { continue; }
      // Map 的键是解析后的 href，不是原始字符串 —— 用 parsed.href 去重才对。
      if (found.has(parsed.href)) continue;
      const dims = parsed.pathname.match(DIMS_RE);
      found.set(parsed.href, {
        url: parsed.href,
        ext: 'mp4',
        width: dims ? parseInt(dims[1], 10) : null,
        height: dims ? parseInt(dims[2], 10) : null,
        origin: 'api',
        partial: false,
      });
    }

    return {
      list: [...found.values()].sort((a, b) => qualityKey(b) - qualityKey(a)),
      streamed: [...streamed],
      blobs: [...blobs],
    };
  }

  // -------------------------------------------------------------------------
  // persistent stream URL collector
  //
  // Telegram Web /k/stream/ 端点会随时间从 performance buffer 里被挤出
  // （buffer 上限 1000 条，几十秒就能装满）。持续监听、见一次记一次，
  // 保证用户点"开始下载"时至少还能拿到一次 stream URL。
  // -------------------------------------------------------------------------

  /**
   * 收集到的同源流端点：url → **首次**被看到的时间戳。
   *
   * 为什么从 Set 换成 Map：Telegram 的每个画质档位是**独立的 docId**（不同文档），
   * 一个页面又会先后播放多个视频，所以 `dataset.mgUrls` 里堆的是"历史上所有视频
   * 的所有档位"。只存 url 就分不出"现在在播的是哪一条"—— 1.7.0 实测切到视频 B
   * 之后下到的仍是视频 A，而且连下三次拿到的清晰度还不一样。
   * 有时间戳之后，"当前视频" = 最近被请求过的那一条（播放器只会去取它在播的那档）。
   */
  const streamCollector = new Map();

  /**
   * 从 API 响应体里挖出来的可直接下载 mp4（目前是 X 的 GraphQL variants）。
   * 这类 URL 来自媒体元数据本身，是权威来源，sniffDirect 里不做 partial 判定。
   */
  const apiVideoCollector = new Set();

  /** 端点 URL 首次出现的时间（ms）；钩子没写时间戳时返回 0。 */
  function streamUrlSeenAt(url) {
    const t = streamCollector.get(url);
    if (t) return t;
    try {
      const raw = document.documentElement.dataset.mgUrlSeen || '[]';
      const arr = JSON.parse(raw);
      const i = (document.documentElement.dataset.mgUrls || '').split('|').indexOf(url);
      const v = Array.isArray(arr) ? Number(arr[i]) : 0;
      return Number.isFinite(v) ? v : 0;
    } catch (e) {
      return 0;
    }
  }

  let streamCollectorTimer = null;

  /**
   * 收集候选 URL，从两条路：
   *   1. MAIN world fetch/XHR 钩子（background.js 注入，URL 存到
   *      document.documentElement.dataset.mgUrls）。覆盖面最广——
   *      不管页面用 fetch / XHR / <img src> 抓什么，都被看到。
   *   2. performance.getEntriesByType('resource') 作为兜底。
   *
   * 认两类"看起来能下载"的 URL：
   *   - STREAM_PATH_RE（/stream/）—— Telegram Web 的原始流端点；
   *   - FILE_EXT_RE（.mp4 / .m4v / .webm / .mov）—— X.com / 其他站点的直链。
   *
   * 存 URL 而不是分类，sniffDirect() 里的 consider() 会自动按扩展名归类。
   */
  function looksLikeVideoUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      // 带 base：钩子记录的可能是相对路径（Telegram 的 stream/... 就是）。
      const u = new URL(url, location.href);
      const p = u.pathname;
      return STREAM_PATH_RE.test(p) || FILE_EXT_RE.test(p);
    } catch (e) {
      return false;
    }
  }

  let collectBusy = false;

  // --- capture health reporting ---------------------------------------------
  //
  // The failure mode that cost the most time was a *silent* one: the capture
  // channel returned zero URLs and the diagnostic stayed quiet, so "webRequest
  // is broken" and "webRequest works but nothing matched" looked identical.
  // Report unconditionally (rate-limited) instead of only on a non-empty result.

  const HEALTH_PRINT_MAX = 10;
  const HEALTH_MIN_GAP_MS = 2000;
  let healthPrints = 0;
  let healthKey = '';
  let healthLastAt = 0;

  function reportCaptureHealth(reply) {
    if (!reply) return;
    const now = Date.now();

    if (reply.ok === false) {
      if (healthPrints < HEALTH_PRINT_MAX) {
        healthPrints += 1;
        console.error('[MediaGrab] getNetLog 调用失败：', reply.error || 'unknown');
      }
      return;
    }

    const urls = reply.urls || [];
    const key = `${reply.events}|${reply.tabUrls}|${reply.sharedUrls}|${reply.unscopedUrls}|${urls.length}`;
    if (key === healthKey) return;
    if (now - healthLastAt < HEALTH_MIN_GAP_MS) return;
    if (healthPrints >= HEALTH_PRINT_MAX) return;

    healthKey = key;
    healthLastAt = now;
    healthPrints += 1;

    console.info(
      `[MediaGrab] 抓包自检 · webRequest 事件总数: ${reply.events}`
      + ` · 本页 URL: ${reply.tabUrls} · 同源共享: ${reply.sharedUrls}`
      + ` · 未归属: ${reply.unscopedUrls}${reply.staleTab ? ' · 已丢弃换站前的旧日志' : ''}`
      + ` · 合并: ${urls.length}`
    );

    if (!reply.events) {
      console.error('[MediaGrab] webRequest 一条事件都没收到 —— 是权限 / 后台注册的问题，与站点无关');
    } else if (!streamCollector.size && urls.length) {
      // 抓到了请求但一条都没被认成媒体：把队尾原样打出来，看真实端点长什么样。
      console.warn('[MediaGrab] 原始 URL 样本：', urls.slice(-12));
    }
  }

  /**
   * 收集候选 URL，三条路（可靠性从高到低）：
   *   1. background 的 chrome.webRequest 日志 —— 浏览器网络层，worker /
   *      service worker 发起的请求也能看到。Telegram Web K 只有这条抓得到。
   *   2. 主世界 fetch/XHR 钩子写的 dataset.mgUrls —— 覆盖主线程的 fetch/XHR。
   *   3. performance.getEntriesByType('resource') —— 兜底，同样只覆盖主线程。
   */
  async function collectStreamUrl() {
    if (collectBusy) return;
    collectBusy = true;
    try {
      const record = (url) => {
        if (!looksLikeVideoUrl(url)) return;
        if (streamCollector.has(url)) return;
        if (streamCollector.size >= 100) return;
        streamCollector.set(url, Date.now());
        console.info('[MediaGrab] 捕获视频 URL:', url.slice(0, 100));
      };

      // 1. background webRequest 日志
      try {
        const reply = await send({ type: 'getNetLog' });
        reportCaptureHealth(reply);
        const urls = reply && reply.ok ? reply.urls : null;
        if (Array.isArray(urls)) {
          for (const url of urls) record(url);
        }
      } catch (e) { /* background 暂时不可达，交给下面两条 */ }

      // 2. Main world hook 写的 URL
      try {
        const raw = document.documentElement.dataset.mgUrls || '';
        if (raw) {
          for (const url of raw.split('|')) record(url);
        }
      } catch (e) { /* not fatal */ }

      // 3. Performance entries（兜底）
      try {
        performance.setResourceTimingBufferSize(1000);
        for (const entry of performance.getEntriesByType('resource')) {
          record(entry.name);
        }
      } catch (e) { /* not fatal */ }

      // 4. MAIN world 钩子从 API 响应体里挖出的 mp4（X 的 GraphQL variants）。
      //    这条**不依赖页面是否请求过该 URL** —— X 播放走 MSE，那个
      //    progressive mp4 甚至可能一次都没被请求过，却正是我们要下的文件。
      //    所以它单独存进 apiVideoCollector，不经过 looksLikeVideoUrl 的形态过滤。
      try {
        const raw = document.documentElement.dataset.mgVideos || '';
        if (raw) {
          for (const url of raw.split('|')) {
            if (!url || apiVideoCollector.has(url)) continue;
            if (apiVideoCollector.size >= 100) break;
            apiVideoCollector.add(url);
            console.info('[MediaGrab] 捕获 API 视频 URL:', url.slice(0, 100));
          }
        }
      } catch (e) { /* not fatal */ }
    } finally {
      collectBusy = false;
    }
  }

  function startStreamCollector() {
    if (streamCollectorTimer) return;

    // 一次性自检：后台能力状态先打出来。没有这一步，「抓包通道坏了」和
    // 「通道正常但没抓到东西」在 Console 里长得一模一样。
    send({ type: 'getHealth' }).then((health) => {
      if (!health || !health.ok) {
        console.error('[MediaGrab] 后台自检失败：', (health && health.error) || '无响应');
        return;
      }
      console.info(
        `[MediaGrab] 后台自检 · webRequest: ${health.hasWebRequest ? 'OK' : '不可用'}`
        + ` · downloads: ${health.hasDownloads ? 'OK' : '不可用'}`
        + ` · sessionStorage: ${health.hasSessionStorage ? 'OK' : '不可用'}`
        + ` · 启动错误: ${(health.bootErrors || []).length}`
      );
      if (health.bootErrors && health.bootErrors.length) {
        console.error('[MediaGrab] 后台启动错误：', health.bootErrors);
      }
    }).catch(() => {});

    // 装 fetch 钩子（background 端用 sender.tab.id 自动补齐 tabId）。
    // hooks.js 现在已经是 manifest 里 world:MAIN / document_start 的常驻
    // content script，正常情况下**已经装好了**（dataset.mgHook === 'on'），
    // 不必再多一次 service worker 唤醒 + executeScript 往返。
    // 只在标记缺失时补装——那是"页面在扩展更新之前就已加载完"的场景。
    if (document.documentElement.dataset.mgHook !== 'on') {
      send({ type: 'installFetchHook' }).then((reply) => {
        if (reply && reply.ok === false) {
          console.warn('[MediaGrab] fetch 钩子注入失败：', reply.error);
        }
      }).catch(() => {});
    }

    collectStreamUrl();
    // 500ms：够快，又不会为了唤醒 service worker 把 CPU 拉满。
    streamCollectorTimer = setInterval(collectStreamUrl, 500);
  }

  /** Pick the rendition matching the requested quality, or null if unusable. */
  function pickDirect(sniff, quality) {
    if (!sniff || !sniff.list.length || quality === 'audio') return null;
    // 只挑完整视频；音/视频分离轨（X.com 的 /aud/、/vid/）排除在外。
    let usable = sniff.list.filter((f) => !f.partial);
    if (!usable.length) return null;

    // 多视频页面（timeline / 个人主页）里 API 会带出好几条推文的视频，
    // 用正在播放的 <video> 的 poster 里的 mediaId 锁定当前这条，避免下错。
    const mediaId = currentMediaId();
    if (mediaId) {
      const mine = usable.filter((f) => (f.url || '').includes(`/amplify_video/${mediaId}`));
      if (mine.length) usable = mine;
    }

    const cap = { best: 0, 1080: 1080, 720: 720, 480: 480 }[quality] || 0;
    if (!cap) return usable[0];
    const within = usable.filter((f) => qualityKey(f) && qualityKey(f) <= cap);
    return within[0] || usable[usable.length - 1];
  }

  /**
   * 在同源流端点里挑一条。
   *
   * 为什么会有多条：Telegram 每个 alt 画质文档对应一条 `/hls_stream/{JSON}`，
   * hls.js 拉到哪个档，网络层就能看到哪一条。分辨率信息只在 playlist 里，
   * 而那条响应由页面的 Service Worker 现造，网络层看不到 body ——
   * 唯一可用的画质信号就是 URL 参数里的 `size`。
   *
   * 所以规则是「按 size 降序 + 按画质档取序号」，依据是 tweb 的
   * createHlsVideoSource() 会 `qualityEntries.sort((a, b) => a.bandwidth - b.bandwidth)`
   * —— playlist 按带宽升序排列，而带宽 = size / duration × 8，于是 size 降序
   * 大致就等于 [最高, 次高, 最低]。
   *
   * 两条边界要说清楚：
   *   - 候选里**只有播放器实际取过的档**（hls.js 不会预取所有档）。所以"最高
   *     画质"很可能就是播放器当前那一档，这没有办法从网络层绕开。
   *   - 只有一条候选时直接用它，不做取舍。
   */
  const STREAM_QUALITY_INDEX = { best: 0, 1080: 0, 720: 1, 480: 2 };

  const streamSizeOf = (c) => Number((streamParams((c && c.url) || '') || {}).size) || 0;
  const streamDocIdOf = (c) => ((streamParams((c && c.url) || '') || {}).docId) || '';

  /**
   * 在同源流端点里挑出「用户眼前这一条」。
   *
   * ⚠️ 1.7.0 把这里整个重写了，原因是一次实测翻车：**连下三次拿到的都是同一条
   * 视频，清晰度还不一样**。两个设计错误叠在一起：
   *
   *   1. **Telegram 的每个画质档位是独立的 `docId`（不同文档）**，不是同一个文档的
   *      多个 size。旧代码按 size 降序取"档位序号"，等于在一堆**不同视频**里按体积
   *      猜哪个是当前画质 —— 于是切到 B 之后下到的仍是 A（体积最大的那个）。
   *   2. 候选集是**整页累积**的（`dataset.mgUrls` 存了历史上所有视频的所有档位），
   *      旧代码完全没有"当前是哪一个"的概念。
   *
   * 现在的规则：
   *   - **当前这条 = 最近被请求过的那一条**（`at` 最大）。播放器只会去取它在播的
   *     那一档，所以时间戳最新的就是用户眼前的视频；时间相同则取记录顺序靠后的。
   *   - 画质映射**只在同一 `docId` 的兄弟档位之间**做。跨 docId 意味着换了视频，
   *     绝不能当"另一档画质"去顶替。
   */
  function pickStreamCandidate(cands, quality) {
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];

    const at = (c) => (c && Number(c.at)) || 0;
    let freshest = cands[0];
    for (const c of cands) if (at(c) >= at(freshest)) freshest = c;

    const docId = streamDocIdOf(freshest);
    // ⚠️ 没有 docId 时**一个兄弟都不算**（siblings 只有它自己）：分不清
    // "另一档画质"和"另一个视频"，而这两种猜错的代价完全不同 ——
    // 猜错档位只是清晰度不对，猜错视频就是下错文件（1.7.0 实测）。
    // 第一版这里退化成 `cands`，等于把刚去掉的"按体积猜"换了个入口重犯，
    // 被用例 20 照了出来。
    const siblings = docId ? cands.filter((c) => streamDocIdOf(c) === docId) : [freshest];
    if (siblings.length <= 1) return freshest;

    const ranked = siblings.slice().sort((a, b) => streamSizeOf(b) - streamSizeOf(a));
    const want = STREAM_QUALITY_INDEX[quality];
    const idx = want === undefined ? 0 : Math.min(want, ranked.length - 1);
    return ranked[idx];
  }

  /**
   * 回退队列：**只允许同 `docId` 的兄弟档位**。
   *
   * 旧实现把其余所有候选都排进队列，于是"当前这条端点 5xx"时会静默去下
   * **另一个视频** —— 用户以为下的是 B，拿到的是 A 的另一档。
   */
  function streamFallbackSiblings(cands, target) {
    if (!target) return [];
    const docId = streamDocIdOf(target);
    if (!docId) return cands.filter((c) => c.url !== target.url);
    return cands.filter((c) => c.url !== target.url && streamDocIdOf(c) === docId);
  }

  // -------------------------------------------------------------------------
  // styles
  // -------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .layer {
      position: fixed; inset: 0; pointer-events: none;
      z-index: 2147483647;
      font: 500 13px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
      --mg-bg: #ffffff;
      --mg-fg: #16181d;
      --mg-dim: #6b7280;
      --mg-line: rgba(0,0,0,.10);
      --mg-soft: #f5f6f8;
      --mg-accent: #2563eb;
      --mg-accent-fg: #ffffff;
      --mg-shadow: 0 10px 34px rgba(15,23,42,.20), 0 2px 8px rgba(15,23,42,.10);
      --mg-ok: #15803d;
      --mg-err: #b91c1c;
    }
    @media (prefers-color-scheme: dark) {
      .layer {
        --mg-bg: #1d2026;
        --mg-fg: #eef0f4;
        --mg-dim: #9aa3af;
        --mg-line: rgba(255,255,255,.13);
        --mg-soft: #262a32;
        --mg-accent: #3b82f6;
        --mg-shadow: 0 10px 34px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.35);
        --mg-ok: #4ade80;
        --mg-err: #f87171;
      }
    }

    .fab {
      position: fixed; pointer-events: auto; cursor: pointer;
      display: flex; align-items: center; gap: 6px;
      height: 36px; padding: 0 12px 0 10px;
      border: 1px solid var(--mg-line); border-radius: 18px;
      background: var(--mg-bg); color: var(--mg-fg);
      box-shadow: var(--mg-shadow);
      transition: transform .12s ease, opacity .12s ease;
      user-select: none; white-space: nowrap;
    }
    .fab:hover { transform: translateY(-1px); }
    .fab:active { transform: translateY(0) scale(.98); }
    .fab svg { width: 15px; height: 15px; flex: none; }
    .fab .dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--mg-accent); flex: none;
    }
    .fab.busy .dot { animation: mg-pulse 1s ease-in-out infinite; }
    /* 扩展上下文失效：红点 + 常驻脉冲。按钮此刻唯一的作用是「刷新本页」。 */
    .fab.stale { border-color: var(--mg-err); }
    .fab.stale .dot {
      background: var(--mg-err);
      animation: mg-pulse 1.2s ease-in-out infinite;
    }
    @keyframes mg-pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }

    .panel {
      position: fixed; pointer-events: auto;
      width: 336px; padding: 14px;
      background: var(--mg-bg); color: var(--mg-fg);
      border: 1px solid var(--mg-line); border-radius: 14px;
      box-shadow: var(--mg-shadow);
    }
    .panel[hidden] { display: none; }

    .head { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px; }
    .head h1 { flex: 1; margin: 0; font-size: 13px; font-weight: 650; line-height: 1.4;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .x {
      flex: none; width: 22px; height: 22px; border: 0; border-radius: 6px;
      background: transparent; color: var(--mg-dim); cursor: pointer; font-size: 15px; line-height: 1;
    }
    .x:hover { background: var(--mg-soft); color: var(--mg-fg); }

    .meta { color: var(--mg-dim); font-size: 11.5px; margin-bottom: 12px;
      display: flex; flex-wrap: wrap; gap: 4px 10px; }

    .field { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .field label { flex: none; width: 44px; color: var(--mg-dim); font-size: 12px; }
    select, input[type=text] {
      flex: 1; min-width: 0; height: 30px; padding: 0 8px;
      border: 1px solid var(--mg-line); border-radius: 8px;
      background: var(--mg-soft); color: var(--mg-fg);
      font: inherit; font-size: 12px;
    }
    select:focus, input:focus { outline: 2px solid var(--mg-accent); outline-offset: -1px; }
    select:disabled, input:disabled { opacity: .5; cursor: not-allowed; }

    .go {
      width: 100%; height: 34px; margin-top: 6px;
      border: 0; border-radius: 9px;
      background: var(--mg-accent); color: var(--mg-accent-fg);
      font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .go:hover { filter: brightness(1.06); }
    .go:disabled { opacity: .5; cursor: default; filter: none; }

    .bar { height: 5px; margin-top: 10px; border-radius: 3px;
      background: var(--mg-soft); overflow: hidden; }
    .bar > i { display: block; height: 100%; width: 0;
      background: var(--mg-accent); transition: width .35s ease; }

    .stat { margin-top: 7px; font-size: 11.5px; color: var(--mg-dim);
      display: flex; justify-content: space-between; gap: 8px; min-height: 16px; }
    .stat .err { color: var(--mg-err); }
    .stat .ok { color: var(--mg-ok); }

    .row { display: flex; gap: 8px; margin-top: 10px; }
    .row button {
      flex: 1; height: 28px; border: 1px solid var(--mg-line); border-radius: 8px;
      background: transparent; color: var(--mg-fg);
      font: inherit; font-size: 12px; cursor: pointer;
    }
    .row button:hover { background: var(--mg-soft); }
  `;

  // -------------------------------------------------------------------------
  // UI
  //
  // ⚠️ v1.5.0 起**页面内不再画任何东西**：悬浮按钮与面板全部撤掉，
  // 唯一入口是工具栏图标（popup）+ 角标。这是用户明确要求的
  //（"右上角的悬停按钮取消，下载只通过菜单栏下"）—— 页面内按钮无论放哪个角，
  // 都要和每个站点的布局妥协，Telegram 上更是压在消息流中间。
  //
  // 那为什么这些元素还在？因为**下载动作必须留在页面里**：
  //   - Telegram 的 /stream/ 与 /hls_stream/ 端点只在页面上下文有意义
  //     （Service Worker 靠 event.clientId 反查账号）；
  //   - MSE 缓存字节只存在 MAIN world 的内存里。
  // 所以 popup 只负责下指令、显示状态，具体动作仍由这份脚本执行。
  //
  // 于是这里保留**脱离文档**的元素当"状态容器"：所有老的 setMessage /
  // elBar.style.width / elGo.textContent 调用都不必改，publish() 每隔一段
  // 时间把这些值快照成 pageState，交给 popup 显示。
  //
  // 用 shadow DOM 创建它们没有别的原因，只是保持原样、零风险；
  // host 永远不会被 append 到 document 上，因此不可能出现在页面里。
  // -------------------------------------------------------------------------

  const host = document.createElement('div');
  host.id = 'mediagrab-root';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const layer = document.createElement('div');
  layer.className = 'layer';
  root.appendChild(layer);

  const fab = document.createElement('div');
  fab.className = 'fab';
  // 先藏起来，等第一次 refresh() 真的识别出东西再显示。
  // 否则从内容脚本注入到首次识别之间，页面上会先闪出一个按钮（哪怕是几帧）。
  fab.style.display = 'none';
  fab.innerHTML = `<span class="dot"></span><svg viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></svg><span>下载</span>`;
  layer.appendChild(fab);

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="head">
      <h1 class="title">正在识别…</h1>
      <button class="x" title="关闭">✕</button>
    </div>
    <div class="meta"></div>
    <div class="field"><label>画质</label>
      <select class="quality">
        <option value="best">最高画质</option>
        <option value="1080">约 1080p</option>
        <option value="720">约 720p</option>
        <option value="480">约 480p</option>
        <option value="audio">仅音频</option>
      </select></div>
    <div class="field"><label>方式</label>
      <select class="mode">
        <option value="browser">浏览器下载（进度可见）</option>
        <option value="ytdlp">yt-dlp 下载（可合并 HLS）</option>
      </select></div>
    <div class="field"><label>目录</label>
      <input type="text" class="outdir" placeholder="~/Downloads" spellcheck="false"></div>
    <button class="go">开始下载</button>
    <div class="bar"><i></i></div>
    <div class="stat"><span class="msg">就绪</span><span class="pct"></span></div>
    <div class="row">
      <button class="reveal" hidden>在 Finder 中显示</button>
      <button class="opendir">打开目录</button>
    </div>
  `;
  layer.appendChild(panel);

  const $ = (sel) => panel.querySelector(sel);
  const elTitle = $('.title');
  const elMeta = $('.meta');
  const elQuality = $('.quality');
  const elMode = $('.mode');
  const elOutDir = $('.outdir');
  const elGo = $('.go');
  const elBar = $('.bar > i');
  const elMsg = $('.msg');
  const elPct = $('.pct');
  const elReveal = $('.reveal');

  let current = { kind: 'none' };
  let currentJob = null;
  let pollTimer = null;
  let settings = null;
  let lastHref = location.href;

  // Resolution state for the browser channel.
  let sniffer = { list: [], streamed: [] };   // what the page itself exposed
  let directLink = null;                      // single-file URL we can hand over
  let probeState = 'idle';                    // idle | running | done | error

  // 上一次「整片下载」失败留下的证据：端点 URL 声明的总字节数、失败原因。
  // 用户主动点「改用播放器缓存导出」时，靠它们算出「已缓存 X / 整片 Y（约 Z%）」——
  // 这正是"下载下来只有 5 秒"这类反馈唯一能自证的数字。
  let lastDeclaredBytes = null;
  let lastFailureText = '';

  /** popup 选定的档位序号（按体积降序；-1 = 不指定）。 */
  let pickedVariantIndex = -1;

  /**
   * 正在进行的下载，key = 本地任务 id。
   *
   * 为什么需要这张表：进度与按钮状态原先是**全局共享**的（elBar / elPct /
   * elGo.disabled），于是「下 A 的过程中切到 B」必然下不了 B ——
   * A 把按钮禁用了，popup 收到的 `busy` 也来自那个 disabled。
   * 1.7.0 实测：下载中切到另一个视频，popup 里「下载此页视频」是灰的。
   *
   * 现在每个任务各写各的进度，面板那行只镜像**最近开始**的那个
   * （`shownJobId`），完整列表由 popup 渲染。协议层本来就支持并发
   * （`__mg_dl_start` 按 reqId 分派，hooks.js 每次调用独立跑）。
   */
  const runningJobs = new Map();
  let runningSeq = 0;
  let shownJobId = null;

  /**
   * 已经交付过的端点：url → {name, size, at}。
   *
   * 挡的是"连点两下 / 切过去又点一下"导致**同一个文件跑两遍**。
   * 1.7.0 实测：连下三次都是同一条视频（其中两次清晰度不同），用户根本不知道
   * 自己在重复下载。这里不静默跳过、也不自动重下，而是要求**再点一次**才继续 ——
   * 第一次点只把"已经下过 X（多大）"摆出来，第二次点才真的动手。
   */
  const deliveredStreams = new Map();
  let againAckUrl = null;

  // -------------------------------------------------------------------------
  // yt-dlp 通道的去重
  // -------------------------------------------------------------------------
  //
  // 页面通道（stream / direct）一直有 `isRunningName` + `deliveredStreams` 两道
  // 去重，yt-dlp 通道却没有 —— 于是连点两次就起两个 yt-dlp 进程抢同一个输出文件。
  // 1.9.1 实测的报错就是这条路的必然结果：
  //
  //   ERROR: Unable to rename file: [Errno 2] No such file or directory:
  //   '.../x.mp4.part' -> '.../x.mp4'
  //
  // （两个进程都往同一个 `.part` 写，先完成的那个把 `.part` 改名成 `.mp4`，
  //   后完成的那个再改名时源文件已经不在了。）
  //
  // 判据用**目标 URL** 而不是文件名：yt-dlp 的输入就是它，改名重下仍是同一个
  // 任务，而文件名可能被我们自己的分级规则改掉。
  const ytdlpJobs = new Map();
  const deliveredYtdlp = new Map();
  let againAckYtdlp = null;

  function ytdlpKey(target) {
    try { return String(target || '').split('#')[0].replace(/\?.*$/, ''); } catch (e) { return String(target || ''); }
  }

  function isRunningYtdlp(key) {
    for (const j of ytdlpJobs.values()) {
      if (j.key === key && !j.done) return true;
    }
    return false;
  }

  /** 同名任务已在跑？（连点同一个视频时的去重） */
  function isRunningName(name) {
    for (const j of runningJobs.values()) {
      if (j.name === name && !j.done) return true;
    }
    return false;
  }

  function beginRunning(name, kind, url) {
    // 同名（或同 url）的中断记录就此作废：用户已经点了下载，新任务接管。
    // 不删的话 popup 会同时列出"已被刷新中断"和"正在下载"同一个文件。
    for (let i = resumedJobs.length - 1; i >= 0; i -= 1) {
      const r = resumedJobs[i];
      if (r.name === name || (url && r.url && r.url === url)) resumedJobs.splice(i, 1);
    }
    runningSeq += 1;
    const id = `mg${runningSeq}`;
    runningJobs.set(id, {
      id, name: name || 'video', kind: kind || '', url: url || '',
      received: 0, total: 0, startedAt: Date.now(), done: '',
    });
    shownJobId = id;
    persistJobs();
    return id;
  }

  function patchRunning(id, patch) {
    const j = runningJobs.get(id);
    if (!j) return null;
    Object.assign(j, patch);
    persistJobs();
    return j;
  }

  /**
   * 结束一个任务。
   *
   * 完成后**保留 8 秒**再从表里移除：popup 需要这段时间显示"已保存 xx MiB"，
   * 但它**不再计入 busy** —— 否则状态会永远卡在"下载中"
   * （第一版就只标记 done 不移除，`runningJobs.size > 0` 让 busy 恒真，
   * 12 条"状态是完成"断言全红，是被它们逼出来的）。
   */
  function endRunning(id, ok, note) {
    const j = runningJobs.get(id);
    if (!j) return null;
    j.done = ok ? 'done' : 'failed';
    if (note) j.note = note;
    if (j.done && j.total) j.received = j.total;
    if (j.done) {
      setTimeout(() => { runningJobs.delete(id); publish(true); }, 8000);
    }
    persistJobs();
    return j;
  }

  /** 真正"在跑"的任务数（不含已完成的）。 */
  function runningActiveCount() {
    let n = 0;
    for (const j of runningJobs.values()) if (!j.done) n += 1;
    return n;
  }

  /** 面板那一行镜像哪个任务：最近开始的那个，且别把已完的钉住。 */
  function mirrorJob() {
    if (!shownJobId || !runningJobs.has(shownJobId)) {
      const ids = [...runningJobs.keys()];
      shownJobId = ids.length ? ids[ids.length - 1] : null;
    }
    return shownJobId ? runningJobs.get(shownJobId) : null;
  }

  // -------------------------------------------------------------------------
  // 跨刷新的任务记忆
  // -------------------------------------------------------------------------
  //
  // **字节只能在页面世界拉**（Telegram 的端点要靠页面自己的 Service Worker 兑现），
  // 所以页面一刷新/关闭，正在下载的任务就**真的停了** —— 没有任何东西在后台跑。
  //
  // 以前这份事实完全没被说出来，于是表现为 1.8.0 实测的：
  //   「页面一刷新，下载就重置了。反正插件里面是发现那个东西不见了，
  //     也不知道是不是在后台下载」
  // —— 用户看到的是面板回到"就绪"、任务列表清空，于是只能猜。
  //
  // 现在把未完成的任务写进 sessionStorage（关掉标签页即失效，正好符合
  // "它的生命周期就是这个页面"）。新页面加载时读回来，明确告诉用户：
  // 那次下载**没有继续跑**，但已下载的字节还在暂存里，再点一次会从断点接着下。
  const JOB_STORE_KEY = 'mediagrab.jobs.v1';

  function persistJobs() {
    try {
      const list = [...runningJobs.values()]
        .filter((j) => !j.done)          // 只记未完成的
        .map((j) => ({
          name: j.name, kind: j.kind, url: j.url || '',
          received: j.received, total: j.total, startedAt: j.startedAt,
        }));
      if (!list.length) {
        sessionStorage.removeItem(JOB_STORE_KEY);
        return;
      }
      sessionStorage.setItem(JOB_STORE_KEY, JSON.stringify(list));
    } catch (e) { /* sessionStorage 不可用就放弃持久化，不影响下载本身 */ }
  }

  /**
   * 读回上次未完成的任务，标成"被刷新中断"。
   *
   * 这些任务**不在** runningJobs 里（它们已经随旧页面消失了），所以
   * runningActiveCount() 不算它们，`busy` 不会被它们顶成 true —— 这一点很关键，
   * 否则刷新后按钮又会变灰，回到 1.7.0 那个"下不了"的坑。
   */
  const resumedJobs = [];

  function loadInterruptedJobs() {
    resumedJobs.length = 0;
    let raw = '';
    try { raw = sessionStorage.getItem(JOB_STORE_KEY) || ''; } catch (e) { return; }
    if (!raw) return;
    let list = [];
    try { list = JSON.parse(raw); } catch (e) { list = []; }
    if (!Array.isArray(list)) return;
    for (const j of list) {
      if (!j || !j.name) continue;
      resumedJobs.push({
        id: `resumed-${j.name}`,
        name: j.name,
        kind: j.kind || '',
        url: j.url || '',
        received: Number(j.received) || 0,
        total: Number(j.total) || 0,
        // done 用 'failed' 而不是别的值：popup 会把它渲染成"中断"那一档，
        // 颜色与失败一致，但它不是失败——点一次下载就能从断点续上。
        done: 'interrupted',
        note: `页面刷新时被中断（已下 ${fmtBytes(Number(j.received) || 0)} / `
          + `${fmtBytes(Number(j.total) || 0)}）· 没有在后台继续`,
      });
    }
  }

  /** popup 的任务列表 = 正在跑的 + 上次被刷新中断的。 */
  function allJobsForUi() {
    return [
      ...[...runningJobs.values()].map((j) => ({
        id: j.id, name: j.name, kind: j.kind,
        received: j.received, total: j.total, done: j.done, note: j.note || '',
      })),
      ...resumedJobs,
    ];
  }

  /**
   * 上一次「页面内拉取失败 → 回落 Chrome 下载器」的说明。
   *
   * 不存住就会丢：render() 在下载一开始就把消息刷成"浏览器下载中…"，
   * 于是用户只看到"明明页面内拉取失败了，怎么还在下？"，而真正的因果
   * （多半是跨域 CDN 没有 ACAO 头）只留在 Console 里。
   */
  let lastFallbackNote = '';

  // ⚠️ 刻意**不** append 到 document：见上面 UI 段落的说明。
  // host 只活在内存里，页面 DOM 里不会出现任何 MediaGrab 节点。

  // --- helpers -------------------------------------------------------------

  /**
   * 本页这份 content script 的 chrome.runtime 通道是否还活着。
   *
   * 扩展一被重载 / 更新 / 自动升级，**已经打开**的页面里那份 content script 的
   * runtime 立刻作废（`chrome.runtime.id` 变 undefined，任何 sendMessage 都抛
   * `Extension context invalidated`）。这不是 bug，是 MV3 的既定行为 —— 麻烦在于
   * 页面**不会**被自动重新注入：UI 还在、JS 还在跑，只有扩展 API 全废。
   *
   * 可以直接同步查 `chrome.runtime.id`，不必等消息抛错 —— 所以能**提前**把状态
   * 摆在面板上，而不是等用户点了按钮才吐一句看不懂的英文报错。
   */
  function contextAlive() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  /**
   * 兜底判据：只看报错文本。有些路径（消息已发出、回执才失败）拿不到
   * contextAlive() 的同步结论，只能从错误信息反推。
   */
  function isDeadContext(message) {
    return /Extension context invalidated|message port closed|Receiving end does not exist/i
      .test(String(message || ''));
  }

  let warnedDeadContext = false;
  let staleUi = false;

  /**
   * 工具栏角标 —— 不往页面里画任何东西的入口。
   *
   * 页面内按钮（fab）无论放哪个角都要占用页面空间，且总得跟某一个站点的布局
   * 妥协；角标则完全在浏览器 UI 里，零侵入。代价是用户每次必须点扩展图标，
   * 所以它作为**补充信号**：有视频时显示 1，离开视频页时清掉。
   *
   * 只在值变化时发消息：refresh() 每 3 秒跑一次，无条件发就是每 3 秒一次
   * 无意义的跨进程往返。
   */
  let badgeSent = null;

  function reportBadge(count) {
    if (badgeSent === count) return;
    badgeSent = count;
    if (!contextAlive()) return;
    void send({ type: 'badge', count });
  }

  /**
   * 切到「本页脚本已过期」状态。
   *
   * 对用户来说，能被帮到的话只有一句、能做的动作只有一个：刷新本页。
   * 所以按钮直接改名「刷新本页」，点它就是 location.reload()。
   */
  function enterStaleState() {
    if (staleUi) return;
    staleUi = true;

    stopPolling();
    elTitle.textContent = '本页脚本已过期';
    elMeta.textContent = '扩展刚被重载 / 更新，本页这一份已经失联';
    setMessage('扩展更新后，已打开的页面必须刷新一次才能继续。点下面的按钮即可。', 'err');
    elBar.style.width = '0%';
    elPct.textContent = '';
    elGo.disabled = false;
    elGo.textContent = '刷新本页';
    elGo.dataset.action = 'reload';

    fab.classList.add('stale');
    fab.title = '扩展已更新，请刷新本页';

    if (!warnedDeadContext) {
      warnedDeadContext = true;
      console.warn(
        '[MediaGrab] 检测到扩展上下文已失效：本页这份 content script 是扩展重载前的，'
        + 'chrome.runtime 通道已作废。刷新页面即可恢复。'
      );
    }
  }

  /**
   * 统一处理 background 的失败回执。
   *
   * 别再让 `Extension context invalidated` 这种原文出现在面板上 —— 它对用户
   * 零信息量。v1.3.6 实测就是这句话被原样贴出来，看着像扩展崩了，其实只需刷新。
   */
  function showFailure(reply, fallback) {
    if (reply && (reply.deadContext || isDeadContext(reply.error))) {
      enterStaleState();
      elGo.disabled = false;
      return;
    }
    if (reply && reply.hostUnavailable) {
      // 原生宿主没装 / 没跑。原文是 "native host unreachable"，对着它看不出
      // 该做什么；这条路上（yt-dlp 通道）它是唯一可能的失败原因，直接说清楚。
      setMessage('本地组件（yt-dlp host）未安装或未启动，请先运行 install.sh', 'err');
      elGo.disabled = false;
      return;
    }
    const text = (reply && reply.error) || fallback;
    // 宿主回传的原文常常是 yt-dlp 的 stderr（英文、零上下文）。能翻译就翻译，
    // 翻不了再原样贴出来 —— 至少不把信息丢掉。
    setMessage(explainHostError(text) || text, 'err');
    elGo.disabled = false;
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          const err = chrome.runtime.lastError;
          if (err) {
            const text = err.message || String(err);
            resolve({ ok: false, error: text, deadContext: isDeadContext(text) });
          } else {
            resolve(reply || { ok: false, error: 'no reply' });
          }
        });
      } catch (e) {
        const text = String(e);
        resolve({ ok: false, error: text, deadContext: isDeadContext(text) });
      }
    });
  }

  function fmtDuration(seconds) {
    if (!seconds) return '';
    const s = Math.round(seconds);
    const m = Math.floor(s / 60);
    return m >= 60
      ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
      : `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  /**
   * 字节数 → 人类可读。**单位标签必须是 KiB/MiB/GiB**。
   *
   * 这不是讲究，是实测踩的坑：v1.6.0 之前这里算的是 1024 进制却标成 "MB"，
   * 于是面板说「已保存 73MB」、Finder 说「77.1 MB」，用户以为少了 4MB。
   * 两者其实是同一个文件（77.1e6 ÷ 1024² = 73.5 MiB），差的是单位口径：
   * Finder 用 1000 进制，网页习惯用 1024 进制。写 MiB 是唯一诚实的做法 ——
   * 数字仍按 1024 算，但标签不再骗人；完成时再补一个精确字节数，争议到此为止。
   */
  function fmtBytes(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
  }

  /** 带千分位的精确字节数 —— 面板上同时给 MiB 和它，单位之争由此终结。 */
  function exactBytes(bytes) {
    const n = Number(bytes) || 0;
    return `${n.toLocaleString('en-US')} 字节`;
  }

  function setMessage(text, kind) {
    elMsg.textContent = text;
    elMsg.className = `msg${kind ? ' ' + kind : ''}`;
  }

  // -------------------------------------------------------------------------
  // 页面状态快照 —— 页面内不再有 UI，这里是 popup / 角标唯一的读数来源
  //
  // 做法：把那份**脱离文档**的界面元素当成状态字典，定时把它们的值快照成一个
  // 普通对象。这样所有老的 setMessage / elBar.style.width / elGo.disabled 调用
  // 都不用改一行，状态自然汇总到一处；反过来（把这些调用全改成 pageState.xxx）
  // 要动上百处，风险大得多、收益是零。
  //
  // phase 直接从"按钮状态 + 消息色调"推出来，不额外维护：
  //   按钮禁用 → running；消息是红 → error；消息是绿 → done；其余 → ready。
  // -------------------------------------------------------------------------

  let pageState = {
    phase: 'idle',
    title: '',
    meta: '',
    message: '',
    tone: '',
    button: '',
    action: '',
    busy: false,
    percent: 0,
    detail: '',
    kind: 'none',
    site: '',
    file: '',
    at: 0,
  };

  let lastPublished = '';
  let lastJobFile = '';

  /**
   * 造一份当前状态快照。
   *
   * 单独拆出来是因为 `pageStatus`（popup 每 2.5s 轮询）需要**当场**造一份，
   * 不能返回缓存的 `pageState`：后台标签页的 `setInterval` 会被 Chrome 节流
   * （5 分钟后可到 1 次/分钟），于是缓存里的进度会停在旧值上 —— 1.7.0 实测
   * popup 里的百分比与任务列表不更新，就是这个原因。
   */
  function buildState() {
    const tone = elMsg.className.includes('err') ? 'err'
      : (elMsg.className.includes('ok') ? 'ok' : '');
    // ⚠️ 不能用 `elGo.disabled` 当"忙"：那会让「下 A 时切到 B 下不了」
    // （1.7.0 实测）。忙的定义改成"有任务在跑"，按钮另外由 action 决定。
    const busy = runningActiveCount() > 0 || !!elGo.disabled;
    const next = {
      phase: busy ? 'running' : (tone === 'err' ? 'error' : (tone === 'ok' ? 'done' : 'ready')),
      title: elTitle.textContent || '',
      meta: elMeta.textContent || '',
      message: elMsg.textContent || '',
      tone,
      button: elGo.textContent || '',
      action: elGo.dataset.action || '',
      busy,
      percent: Math.round(parseFloat(elBar.style.width) || 0),
      detail: elPct.textContent || '',
      kind: (current && current.kind) || 'none',
      site: (current && current.site) || '',
      file: lastJobFile,
      at: Date.now(),
      // 并发任务列表：popup 据此渲染多行进度，且**不**再 disable 下载按钮。
      // 按钮是否被禁用。单独暴露出来而不是让 popup 去猜 busy ——
      // 「有任务在跑」和「现在不能点」是两件事（1.7.0 把两者混为一谈，
      // 于是下 A 时切到 B 按钮是灰的）。
      buttonDisabled: !!elGo.disabled,
      running: allJobsForUi(),
    };
    return next;
  }

  function publish(force) {
    const next = buildState();
    const key = JSON.stringify(next);
    if (!force && key === lastPublished) return;
    lastPublished = key;
    pageState = next;

    // 交给 background：它负责在完成/失败时发系统通知 —— popup 早就关掉了，
    // 而这一条下载可能跑十几分钟。
    if (contextAlive()) void send({ type: 'pageState', state: next });
  }

  /** popup 每次打开都要看的那几项（不受"状态没变就不发"影响）。 */
  function pageSummary() {
    let tracks = [];
    try {
      tracks = JSON.parse(document.documentElement.dataset.mgMseTracks || '[]');
    } catch (e) { tracks = []; }
    const ds = document.documentElement.dataset;

    // 最值得交出去的那条地址：优先同源流端点（它才是能下整片的那条），
    // 其次任何候选，最后 current.url。sniffer 为空时现算一次（popup 打开时
    // 可能还没人调用过 sniffDirect）。
    // 计数与 bestUrl 必须来自**同一次**嗅探。之前一个用 sniffer、一个现算，
    // 于是诊断信息自相矛盾：`候选总数: 0` 却给出一条 hls_stream 地址
    // （1.6.0 首日实测），白白多花一轮去核对。
    const list = (sniffer.list && sniffer.list.length) ? sniffer.list : sniffDirect().list;
    const streamList = list.filter((f) => isSameOriginStream(f.url || ''));

    // 「选中档」= 按当前画质实际会下的那一条。popup 的摘要必须用它，而不是
    // 候选里最大的那个 —— 否则「整片约 127MB」配 720p 的实际下载 73.5MiB，
    // 用户会以为下错了文件。
    let selected = null;
    try { selected = pickStreamCandidate(streamList, elQuality.value); } catch (e) { selected = null; }

    let bestUrl = '';
    try {
      bestUrl = (selected || streamList[0] || list[0] || {}).url || (current && current.url) || '';
    } catch (e) { bestUrl = (current && current.url) || ''; }

    return {
      kind: (current && current.kind) || 'none',
      site: (current && current.site) || '',
      url: (current && current.url) || '',
      bestUrl,
      runtimeOnly: runtimeStreamOnly(),
      ytdlpOnly: current && current.ytdlpOnly === true,
      hook: ds.mgHook === 'on',
      candidates: list.length,
      streams: streamList.length,
      streamSizes: streamList.map((f) => Number((streamParams(f.url) || {}).size) || 0),
      selectedUrl: (selected && selected.url) || '',
      selectedSize: selected ? (Number((streamParams(selected.url) || {}).size) || 0) : 0,
      quality: elQuality.value,
      // 当前这条的兄弟档位（含真实字节数）—— popup 用它列出"可下的几档"。
      // 只给大小、不假装知道分辨率：HLS 端点的 URL 里没有分辨率，
      // 而每个档位是独立 docId，跨档位不存在"同一视频的不同 size"那回事。
      // ytdlpOnly 站点：档位列表是 Telegram 语义（每个画质是独立 docId），
      // 在这类站点上毫无意义且会误导（1.9.2 实测把 31MiB 当整片大小报出）。
      variants: (current && current.ytdlpOnly === true) ? [] : (() => {
        if (!selected) return [];
        const docId = streamDocIdOf(selected);
        return streamList
          .filter((c) => (docId ? streamDocIdOf(c) === docId : c.url === selected.url))
          .map((c) => ({
            size: streamSizeOf(c),
            current: c.url === selected.url,
            at: Number(c.at) || 0,
          }))
          .sort((a, b) => b.size - a.size);
      })(),
      mseBytes: Number(ds.mgMse) || 0,
      eos: Number(ds.mgEos) || 0,
      tracks,
      stale: !contextAlive(),
      // 面板上的那行字。publish() 也会带一份，但那条要等下次状态变化才发；
      // popup 打开的一瞬间要看的就是「上一次到底为什么失败」，所以这里也带上。
      message: elMsg.textContent || '',
      tone: elMsg.className.includes('err') ? 'err'
        : (elMsg.className.includes('ok') ? 'ok' : ''),
    };
  }

  // --- positioning ---------------------------------------------------------

  // 原来的 FAB_INSET / FAB_HEIGHT 随页面内按钮一起删掉了：没有东西需要定位。

  /**
   * 定位 —— v1.5.0 起是**空操作**。
   *
   * 这个位置上前后改过四次：贴视频右上角 → 视口右下角 → 视口右上角 → 取消。
   * 前三次都在跟"页面布局"较劲（Telegram 整页是消息流，"最大 video"是聊天里的
   * 一条消息，按钮于是被钉在聊天内容中间 —— 用户反复报的那个「悬空按钮」）。
   * 最后一次用户直接给了结论：页面内不要按钮，只走菜单栏。
   *
   * 保留函数是因为 refresh / 事件回调还在调它；元素已脱离文档，写样式没有意义。
   * 想恢复页面内入口：把 openPanel 的入口接回来 + 在文档末尾 append host，
   * 再把这里改回写 right/top（git 里 v1.4.0 的版本可直接抄）。
   */
  function place() { /* no-op：页面内不再渲染任何东西 */ }

  let rafId = 0;
  function schedulePlace() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; place(); });
  }

  // --- detection -----------------------------------------------------------

  function refresh() {
    let next;
    try {
      next = detect();
    } catch (e) {
      // 识别抛异常时**收起**按钮，而不是留着不动。
      // 之前 fab 只在「识别出 none」时才隐藏，一旦 detect() 抛错，异常冒出去，
      // 按钮就保持着 CSS 默认的 display:flex 挂在页面上 —— 而且每 3 秒抛一次。
      // 一个飘在所有页面上的错按钮，比识别不出视频烦人得多，所以这里 fail-closed。
      console.warn('[MediaGrab] 识别失败，已隐藏按钮', e);
      fab.style.display = 'none';
      return;
    }
    const changed = next.kind !== current.kind || next.url !== current.url;
    current = next;

    // 工具栏角标与页面内按钮同步（这也是"页面里不画东西"那条路的唯一入口）。
    reportBadge(next.kind === 'none' ? 0 : 1);

    if (!contextAlive()) {
      // 身份已失效。DOM 识别不依赖扩展 API，所以识别结果仍然有效 —— 只要页面上
      // 确实有视频，按钮就留在原地，当作「请刷新本页」的入口；至于所有要走
      // background 的动作，此刻都不可能成功，不如直接说清楚。
      if (next.kind === 'none') {
        fab.style.display = 'none';
        panel.hidden = true;
        return;
      }
      fab.style.display = 'flex';
      schedulePlace();
      enterStaleState();
      return;
    }

    if (next.kind === 'none') {
      fab.style.display = 'none';
      panel.hidden = true;
      stopPolling();
      return;
    }
    fab.style.display = 'flex';
    if (changed) {
      panel.hidden = true;
      currentJob = null;
      sniffer = { list: [], streamed: [] };
      directLink = null;
      probeState = 'idle';
      resetProgress();
    }
    schedulePlace();
  }

  // --- panel ---------------------------------------------------------------

  function resetProgress() {
    elBar.style.width = '0%';
    elPct.textContent = '';
    elReveal.hidden = true;
    elGo.disabled = false;
    elGo.textContent = '开始下载';
    delete elGo.dataset.action;
    lastDeclaredBytes = null;
    lastFailureText = '';
    // 不清会让上一次回落的原因粘到下一次下载上。
    lastFallbackNote = '';
    lastJobFile = '';
    setMessage('就绪');
  }

  async function loadSettings() {
    const reply = await send({ type: 'getSettings' });
    settings = (reply && reply.settings) || {};
    elQuality.value = settings.quality || 'best';
    elMode.value = settings.mode || 'browser';
    elOutDir.value = settings.outDir || '';
    syncModeUi();
  }

  /** The browser channel always lands in Chrome's own download directory. */
  function syncModeUi() {
    const isBrowser = elMode.value === 'browser';
    elOutDir.disabled = isBrowser;
    elOutDir.placeholder = isBrowser ? 'Chrome 默认下载目录' : '~/Downloads';
    elOutDir.title = isBrowser
      ? '浏览器下载使用 Chrome 的默认下载目录（可在 chrome://settings/downloads 修改）'
      : 'yt-dlp 的输出目录';
  }

  const YTDLP_LABEL = 'yt-dlp 下载（可合并 HLS）';
  const YTDLP_BLOCKED_LABEL = 'yt-dlp 下载（本页不可用）';
  const YTDLP_BLOCKED_HINT =
    '本页视频由页面自己的 Service Worker 现造流（如 Telegram），yt-dlp 拿不到页面会话，'
    + '交给它必然报 Unsupported URL —— 只能用「浏览器下载」。';

  /**
   * 把「yt-dlp 在这个页面上不可能工作」变成显式状态，而不是等用户点了才报错。
   *
   * 之前的表现（实测）：用户在 Telegram 页面上把「方式」改成 yt-dlp、点开始下载，
   * 面板上出现一句 `ERROR: Unsupported URL: https://web.telegram.org/k/#@...` ——
   * 那是 yt-dlp 的 stderr 原文。用户没法从这句话知道"这条路本来就走不通，
   * 应该用浏览器下载"。
   *
   * 三件事一起做：禁用选项（点不到）+ 强制切回浏览器下载 + 说清原因。
   * 被强制切换时**不写回设置**，免得把 B 站那种"确实该用 yt-dlp"的站点偏好冲掉。
   */
  let modeForced = false;

  function enforceModeForPage() {
    const blocked = runtimeStreamOnly();
    const opt = elMode.querySelector('option[value="ytdlp"]');
    if (opt) {
      opt.disabled = blocked;
      opt.textContent = blocked ? YTDLP_BLOCKED_LABEL : YTDLP_LABEL;
    }
    if (blocked && elMode.value !== 'browser') {
      elMode.value = 'browser';
      modeForced = true;
    } else if (!blocked) {
      modeForced = false;
    }
    syncModeUi();
    return blocked;
  }

  /**
   * 把宿主 / yt-dlp 的英文报错翻成「该做什么」。
   *
   * 这些字符串都是 yt-dlp 真实会打出来的（stderr 经原生宿主原样回传），
   * 按官方 error 分类整理：Unsupported URL / Sign in to confirm /
   * Unable to download webpage / HTTP Error 403 …。
   */
  // ⚠️ **顺序有意义**：explainHostError 取第一条命中的规则，所以具体的规则
  // 必须排在笼统的前面。之前的排列让
  // `Unable to download webpage: ... Read timed out` 先命中了笼统文案，
  // 用户看到的仍是"打不开这个页面（网络或代理问题）"而不是"重试即可"。
  const HOST_ERROR_HINTS = [
    // ---- 具体：本地文件层面的失败 --------------------------------------
    [/Unable to rename file/i,
      '下载完成时改名失败（两个进程抢同一个临时文件）。'
      + '本扩展已加了去重守卫，若仍出现请检查是否另有一个 yt-dlp 在跑；'
      + '临时文件可安全删除'],

    // ---- 具体：代理层本身挂了（重试无用，该做的是修代理）------------------
    //
    // 2026-10-16 实测：宿主 probe 一个正常 YouTube 页直接报
    //   ('Unable to connect to proxy', OSError('Tunnel connection failed: 502 Bad Gateway'))
    // 这是代理隧道断了（Clash 节点掉线或切换中），**重试多少次都一样**。
    // 而下面那条 /Remote end closed|Connection reset|…/ 会兜住它并说
    // "直接再点一次即可" —— 那是**错误建议**，会让用户一直白点。
    // 所以这条必须排在前面。
    [/Unable to connect to proxy|Tunnel connection failed|ProxyError|502 Bad Gateway/i,
      '**代理本身连不通**（隧道 502 —— Clash 节点掉线或正在切换）。'
      + '重试没有意义：请先确认代理可用（Clash Verge 面板里看当前节点），再回来下载'],

    // ---- 具体：网络层瞬时故障（来自真实 job 日志）------------------------
    //
    // ~/Library/Application Support/MediaGrab/jobs 里 41 个 job：30 成功、11 失败，
    // 失败的绝大多数是这一类 —— 它们**不是**"视频有问题"，重试一次通常就成了。
    [/UNEXPECTED_EOF/i,
      'SSL 连接被对端中断（代理链路偶发抽风，不是视频有问题）。直接再点一次下载即可'],
    [/Remote end closed|Connection reset|Connection aborted|ECONNRESET|ETIMEDOUT|prematurely closed|Client Error/i,
      '网络或代理连接中途断开（这类是偶发的，不是视频有问题）。直接再点一次下载即可'],
    [/Read timed out|read timeout/i,
      '等对方响应超时（经代理时偏常见）。直接再点一次下载即可 —— '
      + '宿主已把读超时放宽到 60 秒并加了退避重试'],

    // ---- 笼统：页面级网络问题 -------------------------------------------
    [/Unable to download webpage|Failed to resolve|getaddrinfo|Temporary failure in name resolution/i,
      'yt-dlp 打不开这个页面。若上面已说明是超时/连接中断，重试即可；'
      + '否则检查网络或代理'],

    // ---- 命令本身没跑起来（参数写错 / 用法错误）--------------------------
    //
    // 这一组最容易被误判成"网络问题"，因为它同样表现为"下载失败"。
    // 但重试**完全没用**：命令在解析参数阶段就退出了，一个字节都没下。
    // 1.9.2 实测踩过：宿主传了裸 `--retry-sleep linear`（`linear` 必须带
    // 参数 `linear=1::2`），yt-dlp 报 `invalid http retry sleep expression`
    // 并以退出码 2 收场，面板只显示"失败"，用户只会一遍遍重试。
    // ⚠️ 这里**绝不能**包含 `Unsupported URL`：它有两种完全不同的含义 ——
    //   `Unsupported URL: https://web.telegram.org/...` 是**输入地址**不认识，
    //   要说清"换浏览器下载通道"（1.9.1 实测）；
    //   而下面这几种是**命令参数**写错了，重试毫无意义。
    // 两者混在一起会把用户引向完全相反的方向（1.9.3 踩过）。
    [/Unrecognized arguments|invalid http retry sleep|invalid \w+ expression|^Usage: yt-dlp/i,
      'yt-dlp 认为**命令参数本身**不合法（还没开始下载就没了）。'
      + '重试没有意义 —— 这是扩展或宿主的参数问题，不是网络或站点问题'],

    // ---- 站点与鉴权 -----------------------------------------------------
    [/Unsupported URL/i, 'yt-dlp 不认识这个地址。这个视频由页面运行时生成（如 Telegram），只能用「浏览器下载」。'],
    [/Sign in to confirm|confirm you'?re not a bot/i, '对方站点要求登录验证，yt-dlp 拿不到登录态。先在浏览器里登录同一站点再试，或改用「浏览器下载」。'],
    [/HTTP Error 40[13]/i, '对方站点拒绝了 yt-dlp 的请求（403/401）。这类站点通常校验 Referer / 登录态，需要先在浏览器里登录。'],
    [/HTTP Error 404/i, '地址已失效（404）。页面地址可能变了，刷新后重试。'],
    [/Video unavailable|This video is not available|No video formats found|Requested format is not available/i, 'yt-dlp 没找到可下载的视频流。若页面上确实在播，改用「浏览器下载」。'],
    [/timed out|Timeout/i, 'yt-dlp 请求超时，检查网络 / 代理后重试。'],
  ];

  function explainHostError(text) {
    const raw = String(text || '');
    for (const [re, hint] of HOST_ERROR_HINTS) {
      if (re.test(raw)) return `${hint}（原文：${raw.slice(0, 160)}）`;
    }
    return null;
  }

  function describeDirect(link, sniff) {
    const bits = ['浏览器下载'];
    if (link.width && link.height) bits.push(`${link.width}×${link.height}`);
    if (link.filesize) bits.push(fmtBytes(link.filesize));

    // 同源流端点单独报一条：对 Telegram 这类页面它是**唯一**能下整片的路，
    // 和"页面上恰好有个 mp4 直链"是两件事，混在一个计数里会误导（上一版面板
    // 上写的是"2 个分辨率可选"，用户根本不知道那意味着什么）。
    const list = (sniff && sniff.list) || [];
    const streams = list.filter((f) => isSameOriginStream(f.url || ''));
    if (streams.length) {
      bits.push(`同源流端点 ${streams.length} 条`);
      const size = Number((streamParams(link.url) || {}).size);
      if (size) bits.push(`整片约 ${fmtBytes(size)}`);
    } else if (list.length > 1) {
      bits.push(`${list.length} 个分辨率可选`);
    }
    elMeta.textContent = bits.join(' · ');
  }

  /**
   * A name worth putting in the filename. Without yt-dlp nothing normalises the
   * title for us, and falling back to the site name would name every file
   * "X _ Twitter.mp4".
   */
  function pageTitle() {
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) return og.content.trim().slice(0, 120);
    const post = document.querySelector('article [data-testid="tweetText"]');
    if (post && post.textContent) return post.textContent.trim().slice(0, 80);
    return (document.title || '').slice(0, 120);
  }

  async function openPanel() {
    panel.hidden = false;
    schedulePlace();

    // 上下文已死的话，后面 loadSettings / startProbe 全都会失败并连着抛错，
    // 不如直接把状态摆出来。
    if (!contextAlive()) {
      enterStaleState();
      return;
    }

    await loadSettings();
    schedulePlace();

    elTitle.textContent = current.kind === 'direct' ? '页面直链视频' : (current.site || '');
    resetProgress();

    // 先按本页能力校正「方式」：运行时流的页面上 yt-dlp 是死路，直接禁掉。
    const ytdlpBlocked = enforceModeForPage();
    if (ytdlpBlocked) setMessage(YTDLP_BLOCKED_HINT);

    // 只能走 yt-dlp 的站点（B 站这类）：音视频分离 + CDN 校验 Referer。
    // 浏览器通道拿到的是 403 或单条轨道，播放器缓存里同样是两条独立轨，
    // 导出只能二选一 —— 都会得到一个放不了的文件。所以不摆出「已识别到直链」，
    // 直接用 yt-dlp 起一次解析，把真实标题/时长/清晰度摆出来。
    if (current.ytdlpOnly) {
      elMeta.textContent = '音视频分离 + CDN 校验 Referer，浏览器通道取不到字节';
      setMessage('该站只能走 yt-dlp，点「开始下载」会自动用它');
      startProbe();
      return;
    }

    // 1. Anything the page already fetched: instant, no native process at all.
    //    同源流端点排在最前 —— 它与 startViaBrowser 里的实际取用顺序必须一致，
    //    否则面板上写的"将要下载的东西"和真正去下的不是同一个。
    sniffer = sniffDirect();
    const streamCands0 = (sniffer.list || []).filter((f) => isSameOriginStream(f.url || ''));
    let found = pickStreamCandidate(streamCands0, elQuality.value)
      || pickDirect(sniffer, elQuality.value)
      || (current.kind === 'direct' && current.url
        ? { url: current.url, ext: 'mp4', width: null, height: null, origin: 'element' }
        : null);

    // 这里**不再**把 sniffer.blobs[0] 当成 found。
    // MSE 站点（X.com、Telegram 的 /a/ 播放器）的 <video src> 是 MediaSource
    // 的 blob:，既不能 fetch 也不能交给下载通道 —— 把它当"已识别到直链"
    // 只会让按钮点下去必然 net::ERR_FILE_NOT_FOUND（v1.3.1 实测现象）。
    // 真实字节由 MAIN world 的 appendBuffer 钩子在抓，交给 startViaBrowser
    // 的 MSE 分支处理。
    directLink = found;

    if (found && elMode.value === 'browser') {
      probeState = 'done';
      const title = pageTitle();
      if (title) elTitle.textContent = title;
      describeDirect(found, sniffer);
      setMessage('已识别到直链，可直接下载', 'ok');
      return;
    }

    // MSE 播放器页：没解析到候选也别急着起 yt-dlp 探测（MSE 站点上 yt-dlp
    // 常常什么也拿不到）。让「开始下载」按 官方按钮 → Range 分块 → API mp4 →
    // MSE 拼装 依次尝试。
    if (!found && hasMseVideo()) {
      probeState = 'idle';
      elMeta.textContent = '播放器缓存 / API 元数据可下载';
      setMessage('已就绪，点「开始下载」即可', 'ok');
      return;
    }

    // 2. Otherwise ask yt-dlp once for the format list. Chosen quality may
    //    still be missing from the page, and HLS-only posts need the fallback.
    //
    //    但**运行时流页面除外**：那种页面没有页面地址可供 yt-dlp 解析，
    //    起一次探测只会换来 `Unsupported URL`。直接等用户点开始下载。
    if (runtimeStreamOnly()) {
      probeState = 'idle';
      if (!elMeta.textContent) elMeta.textContent = '页面运行时流 · 只能浏览器下载';
      setMessage('已就绪，点「开始下载」即可', 'ok');
      return;
    }

    startProbe();
  }

  async function startProbe() {
    probeState = 'running';
    elMeta.textContent = '页面未暴露直链，正在用 yt-dlp 解析…';
    setMessage('正在解析…');

    // 同 startViaYtdlp：MSE 播放器页没有直链，交给 yt-dlp 的应该是页面地址，
    // 而不是 null（宿主会直接回 "missing url"）。
    const reply = await send({
      type: 'probe',
      url: current.url || location.href,
      pageUrl: location.href,
    });
    if (reply && reply.ok && reply.jobId) {
      currentJob = reply.jobId;
      startPolling();
      return;
    }

    probeState = 'error';
    elMeta.textContent = '';
    showFailure(reply, '解析启动失败');
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(tick, 1200);
    tick();
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function tick() {
    if (!currentJob) return;
    const job = await send({ type: 'poll', jobId: currentJob });
    if (!job || !job.ok) {
      stopPolling();
      showFailure(job, '无法连接本地服务');
      publish(true);
      return;
    }
    render(job);
    // ⚠️ 必须 publish：面板是就地改的 DOM，而 popup / 角标读的是
    // `buildState()` 造出来的快照（`elPct.textContent` / `elBar.style.width`）。
    // 不 publish 的话，popup 里的进度与任务列表**永远停在旧值** ——
    // 1.9.1 实测「卡在正在启动后台下载…」就是这么来的：其实轮询一直在跑，
    // 只是渲染结果从来没被上报出去。
    publish(true);
    if (job.phase === 'done' || job.phase === 'error') stopPolling();
  }

  function render(job) {
    elTitle.textContent = job.title || elTitle.textContent;

    const metaBits = [];
    const probe = job.host && job.host.probe;
    if (probe) {
      if (probe.extractor) metaBits.push(probe.extractor);
      if (probe.duration) metaBits.push(fmtDuration(probe.duration));
      if (probe.progressive && probe.progressive[0] && probe.progressive[0].height) {
        const f = probe.progressive[0];
        metaBits.push(`可直链下载 ${f.width}×${f.height}`);
      }
      if (probe.isPlaylist && probe.entryCount) metaBits.push(`含 ${probe.entryCount} 个条目`);
    }
    if (metaBits.length) elMeta.textContent = metaBits.join(' · ');

    const isProbeDone = job.mode === 'probe' && job.phase === 'done';
    // ⚠️ `download` 必须算进 busy：background 起 yt-dlp 任务时 phase 就是
    // 'download'（见 background.js 的 trackJob / pollJob）。漏掉它会导致
    // 按钮在下载期间可点 —— 连点两下就起两个 yt-dlp 进程抢同一个 .part，
    // 其中一个报 `Unable to rename file: [Errno 2]`（1.9.1 实测）。
    const busy = job.phase === 'running' || job.phase === 'probe'
      || job.phase === 'browser' || job.phase === 'download';

    if (isProbeDone) {
      // yt-dlp is authoritative about single-file renditions: it knows about
      // formats the page has not fetched yet.
      const best = ((probe && probe.progressive) || [])[0];
      directLink = best && best.directUrl
        ? {
          url: best.directUrl,
          ext: best.ext || 'mp4',
          width: best.width,
          height: best.height,
          filesize: best.filesize,
          origin: 'ytdlp',
        }
        : null;
      probeState = 'done';
    } else if (job.phase === 'error') {
      probeState = 'error';
    }

    elGo.disabled = busy;
    elGo.textContent = busy ? '处理中…' : (job.phase === 'done' && !isProbeDone ? '重新下载' : '开始下载');

    if (job.phase === 'probe') {
      setMessage('正在解析视频地址…');
      elBar.style.width = '8%';
    } else if (isProbeDone) {
      elBar.style.width = '0%';
      elPct.textContent = '';
      if (directLink) {
        setMessage('解析到直链，可以下载', 'ok');
      } else if (current.ytdlpOnly) {
        // B 站这类：解析出分离流是**预期结果**，不是错误。点开始下载会自动
        // 交给 yt-dlp 合并，所以这里给 ok 而不是 err。
        setMessage('该站只有音视频分离流，点「开始下载」将交给 yt-dlp 合并', 'ok');
      } else {
        setMessage('该视频只有 HLS/DASH 分离流，浏览器下载器无法合并', 'err');
      }
    } else if (job.phase === 'running' || job.phase === 'browser' || job.phase === 'download') {
      const pct = typeof job.percent === 'number' ? job.percent : 0;
      elBar.style.width = `${Math.min(pct, 100)}%`;
      const parts = [];
      // Separate video/audio tracks download one after another, each restarting
      // at 0%, so label which segment this is.
      if (job.streamIndex > 1) parts.push(`第 ${job.streamIndex} 段`);
      if (job.downloaded) parts.push(`${job.downloaded}${job.total ? ' / ' + job.total : ''}`);
      else if (job.bytesReceived) parts.push(fmtBytes(job.bytesReceived));
      if (job.speed) parts.push(job.speed);
      if (job.eta && job.eta !== 'NA' && job.eta !== 'Unknown') parts.push(`剩 ${job.eta}`);
      setMessage((lastFallbackNote ? `${lastFallbackNote}，` : '')
        + (job.mode === 'browser' ? '浏览器下载中…' : 'yt-dlp 下载中…'));
      elPct.textContent = parts.join(' · ') || (pct ? `${pct}%` : '');
    } else if (job.phase === 'done') {
      elBar.style.width = '100%';
      setMessage('下载完成', 'ok');
      elPct.textContent = job.resolution || '';
      elReveal.hidden = !job.file;
      lastJobFile = job.file || '';
      // 记进"已交付"，第二次点会先说明再让用户确认（与页面通道一致）。
      for (const [id, j] of ytdlpJobs) {
        if (j.jobId !== (job.jobId || currentJob)) continue;
        j.done = 'done';
        deliveredYtdlp.set(j.key, { name: j.name, file: job.file || '', at: Date.now() });
        endRunning(id, true, job.file ? `已保存 ${job.file}` : '完成');
      }
    } else if (job.phase === 'error') {
      // ⚠️ 这条报错必须翻成人话。yt-dlp 的 stderr 是英文原文，1.9.1 实测用户
      // 看到的是 `ERROR: Unable to rename file: [Errno 2] ...` —— 读不出
      // 「你点了两次，两个进程抢同一个文件」这个真正的原因。
      for (const [id, j] of ytdlpJobs) {
        if (j.jobId !== (job.jobId || currentJob)) continue;
        j.done = 'failed';
        endRunning(id, false, '失败');
      }
      showFailure(job, '失败');
      elGo.disabled = false;
    }
  }

  // --- events --------------------------------------------------------------
  //
  // ⚠️ 下面这些是**页面内面板**的事件绑定。v1.5.0 起 fab / panel 都脱离了文档，
  // 永远不会被点到，所以它们是死代码 —— 保留是因为 openPanel + 这套绑定就是
  // "恢复页面内入口"所需的全部东西（再加一次 appendChild(host) 即可）。
  // 页面内入口一旦恢复，openPanel 与 pageDownload 两处要一起维护，
  // 别让它们各自漂移。

  fab.addEventListener('click', () => {
    if (panel.hidden) {
      openPanel();
    } else {
      panel.hidden = true;
      stopPolling();
    }
  });

  panel.querySelector('.x').addEventListener('click', () => {
    panel.hidden = true;
    stopPolling();
  });

  elMode.addEventListener('change', syncModeUi);

  /**
   * Browser channel: resolve a single-file URL, then hand it to Chrome's own
   * downloader. No native host, no background process — the progress lives in
   * the download shelf where every other browser download shows it.
   */
  // -------------------------------------------------------------------------
  // MAIN world 下载通道（v1.6.0）
  //
  // 隔离世界**不再自己发请求**，只派发指令、收状态。原因是硬性的：
  //
  //   Telegram 的 `/stream/` 与 `/hls_stream/` 由**页面自己的 Service Worker**
  //   兑现（onStreamFetch / onHlsStreamFetch）。隔离世界发起的 fetch 不会被页面
  //   SW 拦截 —— 请求直连 Telegram 服务器，被 302 到 cdn-api.telegram.org，那个
  //   CDN 没有 ACAO 头，页面世界之外一个字节也拿不到。v1.5.2 实测就是两条候选
  //   全部 `HTTP 302`，而 tweb 源码里没有任何地方返回 302（说明它来自网络层）；
  //   页面自己请求同一条 URL 能正常播放，差别只在"发起请求的世界"。
  //
  //   顺带解释了前几轮"修上游却不见好"：漏认 `/hls_stream/`、开区间只回 1 字节、
  //   弹两次另存为 —— 全都在修一条从未通电的通路。
  //
  // 协议：隔离 → 页面 `__mg_dl_start`，页面 → 隔离 `__mg_dl_status`。
  // 跨世界只传 JSON 字符串，也不碰 chrome.runtime（扩展一重载那条通道就废了，
  // 而页面世界的脚本和数据都还在）。
  // -------------------------------------------------------------------------

  const MAIN_ACCEPT_TIMEOUT = 1500;      // 只判定"钩子在不在"
  const MAIN_WATCHDOG_MS = 40 * 60 * 1000;
  const mainJobs = new Map();

  document.addEventListener('__mg_dl_status', (ev) => {
    let st = null;
    try { st = JSON.parse((ev && ev.detail) || '{}'); } catch (e) { return; }
    if (!st || st.reqId === undefined || st.reqId === null) return;

    const id = String(st.reqId);
    const job = mainJobs.get(id);
    if (!job) return;

    if (st.phase === 'accepted') {
      job.accepted = true;
      if (job.timer) { clearTimeout(job.timer); job.timer = 0; }
      // 握手成功 → 换成整条链路的看门狗。1500ms 只管"钩子装没装"，
      // 之后要允许十几分钟的整片拉取。
      job.timer = setTimeout(() => {
        if (!mainJobs.has(id)) return;
        mainJobs.delete(id);
        job.resolve({ ok: false, reason: 'watchdog', error: '页面世界的下载通道超时未回执' });
      }, MAIN_WATCHDOG_MS);
      return;
    }

    if (st.phase === 'probe') { if (job.onProbe) job.onProbe(st); return; }
    if (st.phase === 'progress') { if (job.onProgress) job.onProgress(st); return; }

    // done / failed：终态。
    mainJobs.delete(id);
    if (job.timer) clearTimeout(job.timer);
    job.resolve(st);
  }, false);

  function requestMainDownload(rawUrl, opts = {}) {
    // tweb 为绕 Chrome bug 追加的标记必须剥掉：带它请求 /stream/ 时 SW 会走
    // patchChromiumMp4() 把字节改过再返回，那不是我们要的原始文件。
    const url = normalizeStreamUrl(rawUrl);
    return new Promise((resolve) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const job = {
        accepted: false,
        onProbe: opts.onProbe || null,
        onProgress: opts.onProgress || null,
        timer: 0,
        resolve,
      };
      mainJobs.set(id, job);

      job.timer = setTimeout(() => {
        if (!mainJobs.has(id)) return;
        mainJobs.delete(id);
        resolve({ ok: false, reason: 'no-main' });
      }, MAIN_ACCEPT_TIMEOUT);

      try {
        document.dispatchEvent(new CustomEvent('__mg_dl_start', {
          detail: JSON.stringify({
            reqId: id,
            url,
            declared: Number(opts.declared) || null,
            filename: opts.filename || '',
          }),
        }));
      } catch (e) {
        mainJobs.delete(id);
        clearTimeout(job.timer);
        resolve({ ok: false, reason: 'no-main' });
      }
    });
  }

  /**
   * 页面世界回传的失败码 → 人话。
   *
   * 文案集中在这里而不是分散在两个世界，是有意的：用户只该看到一种说法。
   * `sw-bypass` 单独一条尤其重要 —— 它意味着"这条路在当前上下文走不通"，
   * 而不是"视频有问题"，不解释清楚用户会以为换个大画质档就能解决。
   */
  const MAIN_FAILURE_HINTS = {
    'sw-bypass': '请求没有被页面的 Service Worker 拦截（HTTP 302 → CDN）—— '
      + '这条端点只在页面世界里可用。请刷新本页（Cmd+Shift+R）后重试',
    quota: '暂存写盘失败：浏览器分配给这个页面的存储额度不够，换较小的画质档再试',
    integrity: '服务端返回的字节与声明不符（文件会被截断），已拒绝交付',
    'no-length': '服务端没有返回 Content-Range / Content-Length，无法判定总长度',
    'no-module': '页面世界的下载模块没装好（扩展刚重载，请刷新本页）',
    'no-url': '缺少 URL',
    empty: '拉取到空内容',
    http: '服务端拒绝了请求',
    // 挂起 ≠ 断网。tweb 的 RequestSynchronizer 会把一次没回的 MTProto 分片请求
    // 永久缓存，于是后续 fetch 既不返回也不报错（1.8.0 实测：进度停在 30%
    // 再也不动）。文案必须说清"重试或刷新有意义"，否则用户只会以为网络坏了。
    stalled: '服务器连续几次没有响应（进度长时间不动）。'
      + '这不是文件损坏 —— 点一次下载会从已下载的断点继续；若仍卡住请刷新本页',
    network: '网络请求失败',
    watchdog: '页面世界的下载通道超时未回执',
    internal: '页面世界内部异常',
  };

  function explainMainFailure(st) {
    const reason = (st && st.reason) || 'unknown';
    const base = MAIN_FAILURE_HINTS[reason] || `下载失败（${reason}）`;
    const extra = st && st.error ? `：${String(st.error).slice(0, 160)}` : '';
    return base + extra;
  }

  async function startViaBrowser(quality) {
    // 上下文已死的话，下面每一句都会以 Extension context invalidated 收场，
    // 没有一句能成功。不如直接说清楚该做什么。
    if (!contextAlive()) {
      enterStaleState();
      return;
    }

    // 站点标记了「只能 yt-dlp」（见 sites.js 的 ytdlpOnly）：不要在浏览器通道上
    // 白跑一圈 —— 那条路在这个站上必然产出 403 或单轨道文件，属于已知错误结果。
    if (current.ytdlpOnly) {
      setMessage('该站音视频分离且需要 Referer/登录态，已改用 yt-dlp…');
      await startViaYtdlp(quality, elOutDir.value.trim());
      return;
    }

    if (quality === 'audio') {
      setMessage('浏览器下载不支持“仅音频”，请把方式改为 yt-dlp', 'err');
      return;
    }

    // 临门一脚再抓一次：collector 每 500ms 轮询，用户可能在两轮之间点了开始。
    await collectStreamUrl();
    sniffer = sniffDirect();

    // 一行打全所有通道的状态。前几轮的教训是「通道坏了」和「通道正常但没抓到」
    // 在 Console 里长得一模一样，所以把 MAIN world 钩子的存活标记（mgHook）
    // 和各通道计数一并打出来——一张截图就能判定是哪一层断的。
    const ds = document.documentElement.dataset;
    console.info(
      '[MediaGrab] 抓取结果 —— 候选:', (sniffer.list || []).length,
      '· 同源 stream:', (sniffer.list || []).filter((f) => isSameOriginStream(f.url || '')).length,
      '· API 视频:', apiVideoCollector.size,
      '· collector:', streamCollector.size,
      '· 钩子:', ds.mgHook === 'on' ? 'on' : 'off',
      '· hook URL:', (ds.mgUrls || '').split('|').filter(Boolean).length,
      '· MSE 字节:', ds.mgMse || 0
    );

    // ---- 已删除：点 Telegram 自带的隐藏下载按钮 --------------------------
    //
    // v1.3.8 起不再走这条路。它曾经是首选，但装任何下载管理器扩展（Motrix /
    // Rayburst / IDM…）就必然失败，症状是「下载任务建起来了，速度永远是 0」。
    //
    // 根因链（对着源码核过，不是推测）：
    //   1. tweb 的 downloadToDisc() 会造一个隐藏 iframe，src = `d/<id>`
    //      （见 appDownloadManager.ts）。这个 URL 只有**页面自己的 Service
    //      Worker** 能兑现 —— SW 里 download.ts 把 MTProto 拉来的分块喂进一个
    //      ReadableStream，再由 onDownloadFetch 用它构造 Response。
    //   2. 于是浏览器看到的是一个普通的 https 下载：web.telegram.org/k/d/<id>，
    //      而且是**渲染器发起**的（chrome.downloads 里 byExtensionId 为空）。
    //   3. 下载管理器扩展按设计接管它（motrix-next-extension/lib/download/
    //      filter.ts：scheme 阶段放行 http/https，self-trigger 阶段只跳过
    //      byExtensionId 非空的），把 URL 转给 aria2。
    //   4. aria2 在浏览器外面重新请求这个 URL —— 没有那个 SW，`d/<id>` 什么都
    //      不是。于是永远卡在 0。
    //
    // 我们自己的 /stream/ Range 分块拿的是同一个文件，且全程在页面里，
    // 外部下载器无从插手（Neet-Nestor 的脚本也只走这一条，不点官方按钮）。
    // 所以现在把它排到最前面，官方按钮整个摘掉。

    // ---- 候选排序 --------------------------------------------------------
    //  1. 同源流端点（Telegram 的 /stream/ 与 /hls_stream/）—— Range 分块拉取，
    //     唯一能真正下载完整文件的路。
    //  2. API 响应里挖出的 mp4（X 的 progressive 单文件）—— 直接下。
    //  3. 普通 http 直链。
    //  4. blob —— 只对非站点页兜底；站点页的 blob 是 MSE 引用，fetch 必失败。
    const streamCands = (sniffer.list || []).filter((f) => isSameOriginStream(f.url || ''));

    // popup 明确点了某一档（按真实体积列出的兄弟档位）就照它的来。
    // 仍然限在**同 docId** 内 —— 跨档位就是换视频了，不能由"选档位"变相换目标。
    let streamMatch = null;
    const wantIdx = Number(pickedVariantIndex);
    if (Number.isInteger(wantIdx) && wantIdx >= 0) {
      const base = pickStreamCandidate(streamCands, quality);
      const docId = base ? streamDocIdOf(base) : '';
      // 与 pickStreamCandidate 同一把尺子：没有 docId 就不给"换档"的余地。
      const pool = docId
        ? streamCands.filter((c) => streamDocIdOf(c) === docId)
        : (base ? [base] : []);
      const bySize = pool.slice().sort((a, b) => streamSizeOf(b) - streamSizeOf(a));
      streamMatch = bySize[wantIdx] || base;
      if (streamMatch) {
        console.info('[MediaGrab] 用户指定档位（按体积第', wantIdx + 1, '档）→',
          streamMatch.url.slice(0, 90), '·', fmtBytes(streamSizeOf(streamMatch)));
      }
    }
    if (!streamMatch) streamMatch = pickStreamCandidate(streamCands, quality);
    let target = streamMatch || pickDirect(sniffer, quality) || directLink;

    if (streamMatch) {
      const meta = streamParams(streamMatch.url) || {};
      console.info(
        '[MediaGrab] 选中同源流端点（候选', streamCands.length, '条）→',
        streamMatch.url.slice(0, 110),
        '· 声明大小:', meta.size || '未知', '· mime:', meta.mimeType || '未知'
      );
    }

    // blob 兜底**只对真 Blob 有效**。hooks.js 把页面
    // `createObjectURL(new Blob(...))` 生成的真 Blob 记进 dataset.mgBlobFiles；
    // 而 MSE 站点的 blob: 是 MediaSource 引用，页面里 fetch 它只会拿到一个
    // 错误响应 —— v1.3.1 那个 15KB「视频」就是这么来的。所以先看有没有真 Blob。
    const realBlobFiles = Number(document.documentElement.dataset.mgBlobFiles) || 0;
    if (!target && current.kind !== 'site' && realBlobFiles > 0
        && sniffer.blobs && sniffer.blobs.length) {
      target = {
        url: sniffer.blobs[0],
        ext: 'mp4',
        width: null,
        height: null,
        origin: 'blob',
      };
    }

    // ---- MSE 播放器缓存（Telegram / X 这类 MediaSource 站点的**唯一**退路）--
    //
    // 走到这里说明**一个可用候选都没有**（没有同源流端点、没有 API mp4、没有
    // 普通直链），播放器缓存是手上仅有的字节 —— 所以这一支可以自动执行，
    // 不算"静默降级"。真正的静默降级在下面 isSameOriginStream 那一支：
    // 那里本来有一条能下完整片的路失败了，就必须把原因摆出来而不是换个文件交差。
    //
    // 命中条件：没有候选，或者候选只是个 blob: —— 后者是 MediaSource 引用，
    // 不是 Blob，页面里 fetch 必报 net::ERR_FILE_NOT_FOUND，浏览器下载通道
    // 也取不到字节。真实字节只经过 SourceBuffer.appendBuffer，MAIN world 的
    // 钩子一直在留副本，这里把它拼成文件交出去。
    if (!target || /^blob:/i.test(target.url)) {
      dumpVideoElements();
      if (await captureMseFile({ declared: lastDeclaredBytes })) return;

      // MSE 也导不出来，而手上的候选只是个 MediaSource blob —— 再往下走
      // 唯一的动作就是 fetch 那个 blob，只会产出垃圾文件（v1.3.1 的坑）。
      // 到此为止，把真实原因讲清楚，别再制造一个坏文件让用户去猜。
      if (target && /^blob:/i.test(target.url) && realBlobFiles === 0) {
        setMessage(
          '这个 blob 是播放器的 MediaSource 引用，不是可下载的文件 —— '
          + '而播放器缓存里也没有可导出的字节。先把视频播放几秒让它缓冲，再点一次「开始下载」。',
          'err'
        );
        elBar.style.width = '0%';
        elGo.disabled = false;
        return;
      }
    }

    if (!target || !target.url) {
      if (probeState === 'running') {
        setMessage('仍在解析直链，请稍候…');
        return;
      }
      // 站点页 + 只有 HLS 分离流（X.com 这类音视频分开、单条流无法播放）：
      // 浏览器下载器无法合并 → 自动切到 yt-dlp（yt-dlp 会拉两条流并 mux）。
      // 运行时流页面除外：那里 yt-dlp 也拿不到东西，切过去只会换来英文报错。
      if (current.kind === 'site' && !runtimeStreamOnly()) {
        setMessage('检测到 HLS 分离流，浏览器下载器无法合并，已自动切换到 yt-dlp…');
        elMode.value = 'ytdlp';
        syncModeUi();
        await startViaYtdlp(quality, elOutDir.value.trim());
        return;
      }
      setMessage('没找到可下载的直链。先把视频播放一下再试，或改用 yt-dlp 方式', 'err');
      return;
    }

    resetProgress();
    // ⚠️ 刻意**不**在这里禁用按钮：1.7.0 实测「下 A 的过程中切到 B 下不了 B」，
    // 就是因为 A 把按钮禁用了，而 popup 的 busy 也取自这个 disabled。
    // 并发由 mainJobs（按 reqId 分派）+ runningJobs（各自进度）承担，
    // 同名去重交给 isRunningName。

    // ---- 按 URL 类型分发 -------------------------------------------------
    // 同源 /stream/：Range 分块 fetch。必须带 Range —— 不带会被 302 到
    // cdn-api.telegram.org，那个 CDN 没有 ACAO 头，fetch 直接 CORS 死。
    if (isSameOriginStream(target.url)) {
      // 把同源流端点排成一队依次尝试：先选中的那条，再其余。
      //
      // 为什么需要回退：Telegram 有**两类**字节端点（`/stream/` 与
      // `/hls_stream/`），底层是同一个文件，但 Service Worker 侧是两套完全不同的
      // 实现（stream.ts 的 Stream 类 vs onHlsStreamFetch + fetchAndConcatFileParts）。
      // 其中一条回 5xx 而另一条正常是完全可能的 —— 一条不通就换另一条，
      // 比停在那里把错误直接甩给用户有用。
      const queue = [target];
      for (const c of streamFallbackSiblings(streamCands, target)) queue.push(c);

      const failures = [];
      for (const cand of queue) {
        const params = streamParams(cand.url) || {};
        const declared = Number(params.size) || null;
        const isHls = /hls_stream/i.test(cand.url);
        const tag = isHls ? 'hls_stream' : 'stream';

        // 先把**端点 URL 自带的**总字节数记下来，再去探测。
        //
        // 顺序很要紧：探测失败时（端点 5xx / 不返回 Content-Range）这条候选就
        // 没有 probe.total 可用，而失败面板上那句「已缓存 11MB / 整片约 8.6MB」
        // 恰恰是用户唯一能自证截断的数字。URL 里的 size 是现成的，没理由因为
        // 一条候选的探测失败就把它丢掉。
        if (declared) lastDeclaredBytes = declared;

        console.info(
          '[MediaGrab] 试同源流端点', `(${tag})`,
          '· 候选', streamCands.length, '条 · 声明大小:',
          declared === null ? '未知' : declared,
          '· mime:', params.mimeType || '未知',
          '· URL:', cand.url.slice(0, 120)
        );

        // ---- 首选：页面世界执行 ------------------------------------------
        //
        // 探测、Range 分块、落盘、交付全在页面世界做完（原因见 MAIN world
        // 下载通道那段注释）。这里只发指令、收状态。
        const streamName = buildFilename({ url: cand.url, ext: 'mp4' });

        // 同一条已经下过 → 先说明，再点一次才重下（见 deliveredStreams 注释）
        const already = deliveredStreams.get(cand.url);
        if (already && againAckUrl !== cand.url) {
          againAckUrl = cand.url;
          setMessage(
            `《${already.name}》刚才已经下过了（${fmtBytes(already.size)}，`
            + `${exactBytes(already.size)}）。再点一次「下载此页视频」才会重新下载`,
            'err'
          );
          return;
        }
        againAckUrl = null;

        if (isRunningName(streamName)) {
          shownJobId = null;   // 让 mirrorJob 切回正在跑的那个
          mirrorJob();
          setMessage(`《${streamName}》已经在下载了`, 'err');
          return;
        }
        const jobId = beginRunning(streamName, 'stream', cand.url);
        const main = await requestMainDownload(cand.url, {
          declared,
          // ⚠️ 名字不能省：`/hls_stream/` 的 URL 参数里没有 fileName，
          // 省掉就全部叫 video.mp4（v1.6.0 首日实测）。buildFilename 会按
          // 「URL fileName → DOM → 页面标题 → 站点+时间+docId」分级取名。
          filename: streamName,
          onProbe: (st) => {
            // 探针给出的总长比 URL 参数更权威（服务端现算的），有就用它。
            lastDeclaredBytes = Number(st.total) || declared;
            patchRunning(jobId, { total: Number(st.total) || 0 });
            console.info('[MediaGrab] 页面世界端点可用', `(${tag})`,
              '· 总长:', st.total, '· mime:', st.mime || '未知');
          },
          onProgress: (st) => {
            patchRunning(jobId, { received: st.received, total: st.total || 0 });
            // 面板那行只镜像最近开始的那个任务；A 在跑时切到 B 不会互相踩。
            if (shownJobId === jobId) {
              if (st.total) {
                elBar.style.width = `${Math.min(94, Math.round((st.received / st.total) * 94))}%`;
                elPct.textContent = `${fmtBytes(st.received)} / ${fmtBytes(st.total)}`;
              } else {
                elPct.textContent = fmtBytes(st.received);
              }
            }
          },
        });

        if (main && main.phase === 'done') {
          deliveredStreams.set(cand.url, { name: streamName, size: main.size, at: Date.now() });
          endRunning(jobId, true, `已保存 ${fmtBytes(main.size)}`);
          if (shownJobId === jobId) {
            elBar.style.width = '100%';
            elPct.textContent = exactBytes(main.size);
            setMessage(
              `已保存 ${fmtBytes(main.size)}（${exactBytes(main.size)}，`
              + '字节数与声明一致，已校验）· 请查看浏览器下载栏',
              'ok'
            );
            // 摘要必须在下载后按**真实结果**重写。下载前那句「整片约 127MB」是按
            // 画质挑候选算的，而候选集还随播放器取档增长（实测同页 4 条），排序后
            // 同序号会指向另一档 —— 于是摘要和实际下载对不上（1.6.0 首日实测）。
            elMeta.textContent = `浏览器下载 · ${fmtBytes(main.size)}（${exactBytes(main.size)}）`;
          }
          elGo.disabled = false;
          return;
        }

        if (main && main.reason !== 'no-main') {
          console.error('[MediaGrab] 页面世界下载失败', { kind: tag, ...main });
          endRunning(jobId, false, explainMainFailure(main));
          failures.push(`${tag} 通道 ${explainMainFailure(main)}`);
          continue;
        }

        // ---- 兜底：隔离世界自己拉 ----------------------------------------
        //
        // 页面世界没装钩子时（扩展重载前页面就已经加载完）才走这条路。
        // 先探测、再落盘，顺序不能反：落盘会**创建文件**，而建了文件就必须在
        // 失败时清掉；候选越多"建了又清"的次数越多，中间任何一次中断都会留下
        // 残骸（v1.5.0 的 0 字节文件就是这么来的）。探测是只读的，先做。
        //
        // ⚠️ 这条路在 Telegram 上必然 302。面板会照实说，但**先说该做的事**：
        // v1.6.0 起页面世界多了两个注入脚本，扩展一更新，已打开的页面里是没有的
        // —— 用户看到的"302"绝大多数是"该刷新本页"，不是"视频有问题"。
        console.warn('[MediaGrab] 页面世界没有响应，改用隔离世界自己拉（可能被 302）');
        const noMain = '页面世界没有响应（扩展刚更新的话，刷新本页即可）· 隔离世界探测：';
        patchRunning(jobId, { kind: 'stream(isolated)' });

        const probe = await probeStream(cand.url);
        if (!probe.ok) {
          console.error('[MediaGrab] 端点探测失败', { kind: tag, reason: probe.reason, via: 'isolated' });
          // 兜底这条路失败时**必须**把任务收掉：否则它会永远挂在"下载中"，
          // 面板与 popup 都被它钉住（用例 12 照出来的）。
          endRunning(jobId, false, noMain + probe.reason);
          failures.push(`${tag} 通道 ${noMain}${probe.reason}`);
          continue;
        }

        lastDeclaredBytes = probe.total || declared;
        console.info('[MediaGrab] 端点可用', `(${tag})`,
          '· 总长:', probe.total, '· mime:', probe.mime || '未知');

        try {
          await downloadByChunks(cand, probe);
          deliveredStreams.set(cand.url, { name: streamName, size: lastDeclaredBytes || 0, at: Date.now() });
          endRunning(jobId, true, `已保存 ${elPct.textContent || ''}`.trim());
          return;
        } catch (e) {
          const detail = (e && e.detail) || {};
          const why = (e && e.message) || String(e);
          console.error('[MediaGrab] 分块下载失败', {
            kind: tag,
            error: why,
            detail,
          });
          endRunning(jobId, false, why);
          failures.push(
            `${tag} 通道 ${why}`
            + (detail.status ? `（HTTP ${detail.status}`
              + (detail.contentRange ? ` · Content-Range: ${detail.contentRange}` : '') + '）' : '')
          );
        }
      }

      dumpVideoElements();
      offerMseFallback(failures.join('；'));
      return;
    }

    // blob：chrome.downloads 不认 blob scheme，必须 fetch 到内存再交给浏览器。
    if (/^blob:/i.test(target.url)) {
      console.info('[MediaGrab] 路由到 downloadViaBlob:', target.url.slice(0, 90));
      await downloadViaBlob(target);
      return;
    }

    // ---- 普通 http(s) 直链：也走页面世界 ---------------------------------
    //
    // 为什么不能直接交给 `chrome.downloads`（X / 微博 / 抖音等都是这一类）：
    // 那是一条**渲染器发起**的 https 下载，而下载管理器扩展（Motrix Next /
    // Rayburst / IDM…）按设计就会接管它 —— 它们的过滤器在 scheme 阶段只放行
    // http:/https:，在 self-trigger 阶段只跳过 `byExtensionId` 非空的请求
    // （见 motrix-next-extension/lib/download/filter.ts）。结果就是
    // 「Chrome 下载栏一直显示等待中、进度不动」，而文件其实被它下完了
    // （1.6.1 实测：Rayburst 自己弹了「下载完成」通知，我们的 UI 却是瞎的）。
    //
    // 页面世界这条路完全绕开它：fetch 由页面发出、由页面世界的 fetch 兑现，
    // 交付走 `blob:`（下载管理器的 scheme 阶段就跳过 blob:）。附带还拿到
    // 字节级进度与完整性校验。
    //
    // 跨域直链可能被 CORS 挡住（CDN 没 ACAO 头），那时才回落 Chrome 下载器。
    if (/^https?:/i.test(target.url)) {
      const directName = buildFilename({ url: target.url, ext: target.ext || 'mp4' });
      if (isRunningName(directName)) {
        shownJobId = null;
        mirrorJob();
        setMessage(`《${directName}》已经在下载了`, 'err');
        return;
      }
      const jobId = beginRunning(directName, 'direct', target.url);
      const viaMain = await requestMainDownload(target.url, {
        declared: Number(target.filesize) || null,
        filename: baseFilename({ ext: target.ext || 'mp4' }),
        onProbe: (st) => {
          if (st.total) {
            lastDeclaredBytes = Number(st.total) || lastDeclaredBytes;
            patchRunning(jobId, { total: Number(st.total) || 0 });
            console.info('[MediaGrab] 页面世界直链可用 · 总长:', st.total,
              '· mime:', st.mime || '未知');
          }
        },
        onProgress: (st) => {
          patchRunning(jobId, { received: st.received, total: st.total || 0 });
          if (shownJobId === jobId) {
            if (st.total) {
              elBar.style.width = `${Math.min(94, Math.round((st.received / st.total) * 94))}%`;
              elPct.textContent = `${fmtBytes(st.received)} / ${fmtBytes(st.total)}`;
            } else {
              elPct.textContent = fmtBytes(st.received);
            }
          }
        },
      });

      if (viaMain && viaMain.phase === 'done') {
        endRunning(jobId, true, `已保存 ${fmtBytes(viaMain.size)}`);
        if (shownJobId === jobId) {
          elBar.style.width = '100%';
          elPct.textContent = exactBytes(viaMain.size);
          setMessage(
            `已保存 ${fmtBytes(viaMain.size)}（${exactBytes(viaMain.size)}，`
            + '字节数与声明一致，已校验）· 请查看浏览器下载栏',
            'ok'
          );
          elMeta.textContent = `浏览器下载 · ${fmtBytes(viaMain.size)}（${exactBytes(viaMain.size)}）`;
        }
        elGo.disabled = false;
        return;
      }

      // CORS / 网络 / 完整性都可能被拒，如实说清再回落。
      if (viaMain && viaMain.reason !== 'no-main') {
        endRunning(jobId, false, explainMainFailure(viaMain));
        lastFallbackNote = `页面内拉取失败（${explainMainFailure(viaMain)}）`;
        console.warn('[MediaGrab] 页面世界拉直链失败，回落 Chrome 下载器：',
          viaMain.reason, viaMain.error || '');
      }
    }

    setMessage(lastFallbackNote
      ? `${lastFallbackNote}，改用 Chrome 下载器…`
      : '正在交给浏览器下载…');

    const reply = await send({
      type: 'startDirect',
      url: target.url,
      title: elTitle.textContent,
      pageUrl: location.href,
      ext: target.ext || 'mp4',
      resolution: target.width && target.height ? `${target.width}x${target.height}` : '',
      filesize: target.filesize || null,
    });

    if (!reply || !reply.ok) {
      // 这段属于**直链**通道（startDirect），它的任务 id 是 jobId。
      // 它曾经被写成 yt-dlp 通道的收尾（引用 jobKey / 写 ytdlpJobs），
      // 于是直链失败时抛 `jobKey is not defined`，被用例 17 照了出来。
      endRunning(jobId, false, (reply && reply.error) || '启动失败');
      showFailure(reply, '启动失败');
      elGo.disabled = false;
      return;
    }
    currentJob = reply.jobId;
    startPolling();
  }

  /**
   * yt-dlp 通道：把页面 URL 交给原生 host，由 yt-dlp 解析并下载（含 HLS mux）。
   * 对 HLS 分离流（X.com、多数直播回放）这是唯一可行的路。
   */
  async function startViaYtdlp(quality, outDir) {
    if (!contextAlive()) {
      enterStaleState();
      return;
    }

    // 运行时流页面（Telegram 的媒体查看器、X 信息流里正在播的那条）：字节由页面
    // 自己的 Service Worker / hls.js 现造，yt-dlp 拿不到页面会话；交给它的输入
    // 只可能是页面地址本身，结果必然是
    //   `ERROR: Unsupported URL: https://web.telegram.org/k/#@...`
    // —— 一句英文 stderr，用户完全看不出"这条路本来就走不通"。
    //
    // ⚠️ 这条守卫以前只检查 current.url，而这类页面的 current.url 恰好是 null
    // （sites.js 的 Telegram 规则是 normalize: () => null），于是守卫**从来没生效过**。
    // 实测就是这样把页面地址交给了 yt-dlp。现在改用 runtimeStreamOnly()，
    // 它同时看 current.mse 与同源流候选，不依赖 current.url 有没有值。
    if (runtimeStreamOnly()) {
      setMessage(`${YTDLP_BLOCKED_HINT}已自动改用「浏览器下载」。`, 'err');
      elMode.value = 'browser';
      modeForced = true;
      syncModeUi();
      await startViaBrowser(quality);
      return;
    }

    // MSE 播放器页（B 站、X 的播放页…）的 current.url 是 null —— <video src> 只是
    // 一个 blob 引用。原生宿主对空 url 直接回 "missing url"，所以在这里兜到页面
    // 地址，那正是 yt-dlp 要的输入。之前这条路上 mode=ytdlp 会以「启动失败」收场。
    const target = current.url || location.href;

    // ---- 去重：与页面通道（stream / direct）保持一致 ----------------------
    //
    // ⚠️ 这道守卫以前**只有**页面通道有，yt-dlp 通道没有（1.9.1 实测踩到）：
    // 用户在 YouTube Shorts 页连点两次 → 起两个 yt-dlp 进程写同一个输出文件，
    // 一个先把 `.part` 改名成 `.mp4`，另一个再改名时文件已经不在了：
    //
    //   ERROR: Unable to rename file: [Errno 2] No such file or directory:
    //   '/tmp/dl/x.mp4.part' -> '/tmp/dl/x.mp4'
    //
    // 更糟的是第一份截图里面板**永久**停在「正在启动后台下载…」，用户既看不到
    // 进度也不知道该不该再点，于是大概率会再点一次 —— 两个问题互相放大。
    // 去重的判据用**目标 URL**（yt-dlp 的输入就是它），而不是文件名：
    // 同一个视频改名重下仍是同一个任务。
    const key = ytdlpKey(target);
    if (isRunningYtdlp(key)) {
      const at = [...ytdlpJobs.values()].find((j) => !j.done);
      shownJobId = null;
      mirrorJob();
      setMessage(`《${at ? at.name : '这个视频'}》已经在下载了（交给 yt-dlp 的任务还在跑）`, 'err');
      return;
    }
    if (deliveredYtdlp.has(key) && againAckYtdlp !== key) {
      againAckYtdlp = key;
      const prev = deliveredYtdlp.get(key);
      setMessage(
        `《${prev.name}》刚才已经用 yt-dlp 下过了${prev.file ? `（${prev.file}）` : ''}。`
        + '再点一次「下载此页视频」才会重新下载',
        'err'
      );
      return;
    }
    againAckYtdlp = null;

    const ytdlpName = buildFilename({ url: target, ext: 'mp4' });
    const jobKey = beginRunning(ytdlpName, 'ytdlp', target);

    resetProgress();
    setMessage('正在启动后台下载…');
    elGo.disabled = true;

    const reply = await send({
      type: 'start',
      url: target,
      title: elTitle.textContent,
      pageUrl: location.href,
      mode: 'ytdlp',
      quality,
      outDir,
    });

    if (!reply || !reply.ok) {
      endRunning(jobKey, false, (reply && reply.error) || '启动失败');
      showFailure(reply, '启动失败');
      elGo.disabled = false;
      return;
    }
    currentJob = reply.jobId;
    ytdlpJobs.set(jobKey, { key, name: ytdlpName, jobId: reply.jobId, done: '' });
    startPolling();
  }

  /**
   * blob: URL 走浏览器下载器要过 background.js 的 URL 校验（`^https?:`），
   * 且没有同源会话可凭。这里 fetch 到本地，再用 `<a download>` 交给用户浏览器。
   * 下载过程无 chrome.downloads 进度，只能靠 fetch 的 Content-Length 报一个粗略
   * 百分比；70MB 视频全流式读完再下载，中间态会有一段“准备中”。
   */
  async function downloadViaBlob(target) {
    setMessage('正在从 blob 拉取视频…');
    elBar.style.width = '2%';

    let resp;
    try {
      resp = await fetch(target.url);
    } catch (e) {
      const urlHint = target.url.slice(0, 60);
      console.error('[MediaGrab] blob fetch 失败', e, urlHint);
      setMessage(`拉取失败：${(e && e.message) || e} · URL=${urlHint}`, 'err');
      elGo.disabled = false;
      elBar.style.width = '0%';
      return;
    }
    if (!resp.ok) {
      console.error('[MediaGrab] blob HTTP', resp.status, target.url.slice(0, 60));
      setMessage(`拉取失败：HTTP ${resp.status} · URL=${target.url.slice(0, 60)}`, 'err');
      elGo.disabled = false;
      elBar.style.width = '0%';
      return;
    }

    const total = Number(resp.headers.get('Content-Length')) || 0;
    const blob = await resp.blob();
    if (!blob.size) {
      setMessage('拉取到空内容', 'err');
      elGo.disabled = false;
      elBar.style.width = '0%';
      return;
    }

    elBar.style.width = '95%';
    elPct.textContent = `${fmtBytes(blob.size)} · 保存中`;
    setMessage('正在保存…');

    saveAsBlob(blob, target, target.ext);

    elBar.style.width = '100%';
    setMessage('已触发下载，请查看浏览器下载栏', 'ok');
    elGo.disabled = false;
  }

  /**
   * 已删除：`downloadViaAnchor()`（`<a download href=...>` 兜底）。
   *
   * 它原本是 /stream/ 分块失败后的退路，但两条都站不住：
   *   1. 同源 /stream/ 端点要靠 Range 才有正确字节；`<a download>` 带不了自定义
   *      头，Service Worker 那侧拿到的 Range 是空的（parseRange('') → [0,0]），
   *      结果是一小段而不是整个文件；
   *   2. 它是**渲染器发起的 http(s) 下载**，会被下载管理器扩展接管，正好落回
   *      「任务建起来了、速度恒为 0」那个坑。
   * 现在分块失败直接改用「播放器缓存导出」（blob:，外部下载器碰不到），
   * 见 startViaBrowser 里的 /stream/ 分支。
   */

  /**
   * 从 Telegram 的 stream URL 里取原始文件名。
   *
   * Telegram Web K 的流地址尾部是一段 URL 编码的 JSON：
   *   stream/{"dcId":5,"location":{...},"size":...,"fileName":"xxxx.MP4"}
   * fileName 字段就是原文件名。抄自 Neet-Nestor/Telegram-Media-Downloader。
   */
  function streamUrlFilename(url) {
    // 与 streamParams() 同一套解析，这里只是取 fileName 那一项。
    const meta = streamParams(url);
    const name = meta && typeof meta.fileName === 'string' ? meta.fileName.trim() : '';
    return name ? name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || null : null;
  }

  /**
   * 已删除：「点 Telegram 自带下载按钮」整条路（原 telegramOfficialDownload /
   * isTelegramHost / TG_DOWNLOAD_GLYPHS）。
   *
   * 删它的理由写在 startViaBrowser 的候选排序前面：那条路最终交给浏览器下载的
   * 是一个只有页面 Service Worker 能兑现的伪 URL（`/k/d/<id>`），装了下载管理器
   * 扩展就必然被接管，而接管方在浏览器外面请求它永远拿不到一个字节 —— 表现为
   * 「任务建起来了、速度恒为 0」。我们自己走 /stream/ Range 分块，拿的是同一个
   * 文件，且全程不离开页面，外部下载器无从插手。
   */

  /**
   * 没找到候选时，把「页面上到底有什么」一次摊开。
   *
   * 前几轮全靠猜、每轮只拿到半条线索，代价太大了。这里把 <video> 的属性与
   * 属性值、MSE / Blob 捕获量、各路抓取通道的计数一次打全——一张截图
   * 就能定位到具体是哪一层断的。
   */
  function dumpVideoElements() {
    try {
      const videos = [...document.querySelectorAll('video')].map((v, i) => {
        let buffered = -1;
        try { buffered = v.buffered.length ? Math.round(v.buffered.end(v.buffered.length - 1) * 100) / 100 : 0; } catch (e) { /* ignore */ }
        return {
          i,
          attr: v.getAttribute('src'),
          prop: v.src,
          current: v.currentSrc,
          readyState: v.readyState,
          wh: `${v.videoWidth}x${v.videoHeight}`,
          duration: Number.isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : v.duration,
          buffered,
        };
      });
      console.info('[MediaGrab] <video> 元素:', JSON.stringify(videos));
    } catch (e) {
      console.warn('[MediaGrab] 读取 <video> 元素失败', e);
    }

    const ds = document.documentElement.dataset;
    console.info(
      '[MediaGrab] 捕获量 —— MSE 字节:', ds.mgMse || 0,
      '· 流结束次数:', ds.mgEos || 0,
      '· Blob 文件:', ds.mgBlobFiles || 0,
      '· hook URL:', (ds.mgUrls || '').split('|').filter(Boolean).length,
      '· API 视频:', (ds.mgVideos || '').split('|').filter(Boolean).length
    );
  }

  /**
   * 让 MAIN world（hooks.js）把捕获到的分片拼成文件并触发保存。
   *
   * 走 **DOM 事件**，不走 chrome.runtime —— 原因见 hooks.js 里那段注释：
   * 扩展一重载，已打开页面的 runtime 通道立刻作废，而 MAIN world 钩子抓到的
   * 字节完好。v1.3.3 实测就是这样：7.7MB 数据在手，导出却报
   * `Extension context invalidated`，然后跌回 blob 分支下出一个 15KB 垃圾。
   *
   * detail 用 JSON 字符串：跨世界传字符串最可靠。
   */
  function assembleViaMainWorld(filename, timeoutMs = 90000) {
    return new Promise((resolve) => {
      let settled = false;

      const done = (value) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('__mg_assemble_done', onDone, false);
        resolve(value);
      };

      const onDone = (ev) => {
        try { done(JSON.parse((ev && ev.detail) || '{}')); }
        catch (e) { done({ ok: false, error: '拼装结果无法解析' }); }
      };

      document.addEventListener('__mg_assemble_done', onDone, false);
      document.dispatchEvent(new CustomEvent('__mg_assemble', {
        detail: JSON.stringify({ filename }),
      }));

      setTimeout(() => done({ ok: false, error: '拼装超时（hooks.js 未装或已失效）' }), timeoutMs);
    });
  }

  /**
   * 让页面把 MSE 捕获到的字节拼成文件并交给浏览器保存。
   *
   * 这是 MSE 站点（Telegram Web K、X.com 等）里唯一能从页面侧拿到视频字节的
   * 路径：<video> 上是 MediaSource 的 blob: 引用 → 主线程 fetch 必报
   * net::ERR_FILE_NOT_FOUND，chrome.downloads 也取不到字节。真实字节只在
   * appendBuffer 的入参里，hooks.js 一直在留副本。
   *
   * 返回 true 表示已经交付给浏览器下载。
   */
  async function captureMseFile(opts = {}) {
    const bytes = Number(document.documentElement.dataset.mgMse) || 0;
    if (!bytes) {
      console.warn('[MediaGrab] MSE 钩子没有捕获到数据（dataset.mgMse 为空）');
      return false;
    }

    // 端点 URL 声明的整片字节数（有同源流候选时才知道）。拿它算百分比 ——
    // 「已导出 10.8MB / 整片 62MB（17%）」比任何形容词都清楚。
    const declared = Number(opts.declared) || null;

    setMessage('正在从播放器缓存导出视频…');
    elBar.style.width = '20%';

    // MSE 缓存里只有「播放器已经 append 过」的字节。没看到 endOfStream 就说明
    // 播放器自己都没认为这条流给完了 —— 导出的一定是半截。
    //
    // 这件事必须**写进文件名**：一个叫 `xxx.mp4` 的半截文件，打开能播、时长栏
    // 还显示完整时长（moov 在前），用户只能靠"播到几秒就停"发现不对。带上
    // `.partial`，一眼就知道这份是残的，不必再去猜。
    const eos = Number(document.documentElement.dataset.mgEos) || 0;
    const partial = !eos;

    // 文件名：优先用页面标题，别用面板里那个「页面直链视频」这类占位词。
    const nice = (pageTitle() || '').replace(/[\\/:*?"<>|]+/g, ' ').trim();
    const stem = (nice || `mediagrab_${Date.now()}`).slice(0, 100).replace(/\s+/g, '_');
    const filename = `${stem}${partial ? '.partial' : ''}.mp4`;

    // 主通道：DOM 事件（不依赖 chrome.runtime）。
    let reply = await assembleViaMainWorld(filename);
    let viaEvent = reply && reply.error;

    // 兜通道：事件没人接（hooks.js 没装上）时才退回 background 注入。
    if (!reply || !reply.ok) {
      const fallback = await send({ type: 'assembleMse', filename });
      if (fallback && fallback.ok) {
        reply = fallback;
        viaEvent = null;
      } else if (viaEvent) {
        reply = {
          ok: false,
          error: `${viaEvent}；后台通道亦失败：${(fallback && fallback.error) || '无响应'}`,
        };
      } else {
        reply = fallback;
      }
    }

    if (!reply || !reply.ok) {
      const why = (reply && reply.error) || '未知原因';
      console.warn('[MediaGrab] MSE 拼装失败:', why, '· mgMse =', bytes);
      setMessage(`导出播放器缓存失败：${why}`, 'err');
      elBar.style.width = '0%';
      elGo.disabled = false;
      return false;
    }

    elBar.style.width = '100%';

    // ---- 拼装体检报告 -----------------------------------------------------
    //
    // hooks.js 会把捕获到的字节按 MP4 box 结构解析一遍：分片数、初始化段
    // （ftyp）个数、前若干个分片的 box 序列。这三项直接回答"为什么这份 80MB
    // 的文件只播 5 秒"：
    //   · ftyp > 1       → 播放器重复发了初始化段，已自动剥离（见下方提示）
    //   · 非 box 分片 >0 → 不是 fMP4（可能是 MPEG-TS），去重逻辑未生效
    //   · 全是 moof+mdat → 结构正常，截断发生在别处
    const bi = reply.boxInfo || null;
    const st = reply.strip || null;
    if (bi) {
      console.info('[MediaGrab] MSE 体检 —— 分片:', bi.chunks,
        '· 初始化段(ftyp):', bi.initCount, '· 非 box 分片:', bi.nonBox,
        '· box 统计:', bi.counts);
      console.info('[MediaGrab] MSE 分片结构:', (bi.layout || []).slice(0, 12).join(' | '));
    }
    if (st && st.dropped) {
      console.warn('[MediaGrab] 已剥离', st.dropped, '个重复初始化段（',
        st.droppedBytes, '字节）—— 不剥离的话播放器只认第一段，'
        + '这正是"80MB 的文件却只播前几秒"的成因');
    }

    // ---- 把"手上这份到底有多少"讲清楚 ------------------------------------
    //
    // hooks.js 会回传选中轨的画像（分辨率 / 片长 / 已缓冲到哪）。这三项合起来
    // 就能自证截断：用户看到的「只有 5 秒」在面板上会写成
    //   「片长 8:43 · 已缓冲至 0:05」——不必再靠猜。
    const p = reply.picked || null;
    const bits = [`已从播放器缓存导出 ${fmtBytes(reply.size)}`];
    if (st && st.dropped) bits.push(`已剥离 ${st.dropped} 个重复流头`);
    if (p) {
      const sub = [
        p.w && p.h ? `${p.w}×${p.h}` : '',
        p.duration ? `片长 ${fmtDuration(p.duration)}` : '',
        p.buffered ? `已缓冲至 ${fmtDuration(p.buffered)}` : '',
      ].filter(Boolean).join(' · ');
      if (sub) bits.push(sub);
    }
    if (declared) {
      bits.push(`整片约 ${fmtBytes(declared)}`);
      // 与 offerMseFallback 同一条道理：选中轨的字节数**大于**端点声明的整片，
      // 说明这份缓存里掺了本页其它视频的字节（Telegram 一页十几条小视频），
      // 或者轨道选错了。写「约 160%」只会让人以为文件下多了。
      const pct = Math.round((reply.size / declared) * 100);
      bits.push(pct <= 100
        ? `约 ${Math.max(1, pct)}%`
        : '比端点声明的大（这份缓存里混着本页其它视频的字节）');
    } else if (p && p.duration && p.buffered) {
      bits.push(`约 ${Math.max(1, Math.round((p.buffered / p.duration) * 100))}%`);
    }

    const tracksNote = reply.tracks && reply.tracks.length > 1
      ? `（页面上共 ${reply.tracks.length} 条缓存轨，已选正在播的那条；另有 `
        + `${reply.tracks.length - 1} 条未导出）`
      : '';

    // 文件名里已经带了 `.partial` 标记，这里把原因也讲清楚。
    const tail = partial
      ? '。⚠️ 只含已缓冲片段（文件名带 .partial）'
        + (opts.reason ? `。整片下载失败的原因：${opts.reason}` : '')
      : '';

    setMessage(`${bits.join(' · ')}${tracksNote}${tail}`, partial ? 'err' : 'ok');
    elGo.disabled = false;
    return true;
  }

  /** 把 Blob 交给浏览器保存（createObjectURL + <a download>）。 */
  function saveAsBlob(blob, target, ext, forcedName) {
    const name = forcedName
      || streamUrlFilename(target.url)
      || baseFilename({ ext: ext || target.ext || 'mp4' });
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
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  async function openStageWriter(name) {
    // 实现放在 staging.js，因为**页面世界**（hooks.js 的整片拉取）要用同一份 ——
    // 两个世界之间不能直接调用对方的函数，这是唯一能真正共用的方式。
    // 本函数保留是因为兜底路径（页面世界没装钩子）还在用它。
    const Staging = globalThis.MediaGrabStaging;
    if (Staging && typeof Staging.open === 'function') return Staging.open(name);

    console.warn('[MediaGrab] staging 模块未加载，暂用内存打包');
    return {
      writer: null,
      kind: 'memory',
      finish: async () => null,
      cleanup: async () => {},
      discard: async () => {},
    };
  }

  /**
   * 「整片下载」失败之后的收尾：**不生成文件**，把真实原因留在面板上。
   *
   * 这是本轮最重要的一处策略修改。之前的行为是：分块失败 → 悄悄改用播放器缓存
   * 导出 → 交付一个文件。用户无从察觉手上这份是半截的（moov 在前，时长栏还显示
   * 完整时长），于是同一条反馈反复出现：「下载下来播放却还是只有 5 秒」。
   * 我前两轮还把这个症状写成了「已知限制」，其实它是**我们自己造的**。
   *
   * 现在的行为：说明白是哪一层断的、缓存里有多少、整片有多大，然后把按钮改成
   * 「改用播放器缓存导出」——要不要那份半成品，用户看着原因自己决定。
   *
   * 另外刻意**不**退回 `<a download>` 兜底：
   *   1. 同源流端点必须带 Range 才有正确字节（SW 侧 parseRange('') → [0,0]），
   *      `<a download>` 带不了自定义头，只会拿到一小段；
   *   2. 它是渲染器发起的 http(s) 下载，会被下载管理器扩展（Motrix / Rayburst）
   *      接管，正好落回「任务建起来了、速度恒为 0」那个坑。
   * 缓存导出走的是 blob:（MAIN world 里 createObjectURL），外部下载器碰不到。
   */
  function offerMseFallback(reason) {
    lastFailureText = reason;
    const cached = Number(document.documentElement.dataset.mgMse) || 0;

    // 百分比只在「缓存 < 整片」时才说得通。
    //
    // MSE 字节是**整页所有 SourceBuffer 的累计量**：Telegram 一页上就有十几条小
    // 视频（头像 / 表情 / 贴纸）在缓存，加起来完全可能超过当前这条片子的总长。
    // 那种情况下写「已缓存 229%」是在制造困惑，该说的是事实 —— 这份缓存里混着
    // 本页其它视频的字节。（这一条是 flow.test.mjs 跑出来的：它拿真实代码 + 12MB
    // 缓存 + 5MB 片长，直接打出了 229%。）
    let size = '';
    if (lastDeclaredBytes && cached) {
      const pct = Math.round((cached / lastDeclaredBytes) * 100);
      size = pct <= 100
        ? `。已缓存 ${fmtBytes(cached)}，整片约 ${fmtBytes(lastDeclaredBytes)}（${pct}%）`
        : `。已缓存 ${fmtBytes(cached)}，比端点声明的整片（${fmtBytes(lastDeclaredBytes)}）还大`
          + ' —— 这份缓存里混着本页其它视频的字节';
    } else if (lastDeclaredBytes) {
      size = `。整片约 ${fmtBytes(lastDeclaredBytes)}（播放器缓存里还没有字节）`;
    } else if (cached) {
      size = `。已缓存 ${fmtBytes(cached)}`;
    }

    setMessage(
      `整片下载失败：${reason}${size}。未生成文件 —— 以前这里会悄悄给你一个只有`
      + '几秒的半截文件（那才是"下载下来只有 5 秒"的真正来源）。'
      + '点下面的按钮可改用播放器缓存导出，那份只含已缓冲片段。',
      'err'
    );
    elBar.style.width = '0%';
    elPct.textContent = '';
    elGo.disabled = false;
    elGo.textContent = '改用播放器缓存导出';
    elGo.dataset.action = 'mse';
  }

  /**
   * 正式下载**之前**，用一个只读请求确认这条同源流端点真的能用。
   *
   * 代价是一个 1 字节的 Range 请求（`bytes=0-0`），换到两样东西：
   *   1. 文件总长度 —— 拿它做 `expectBytes`，服务端提前结束流时能被发现；
   *   2. **落盘目标可以等确认之后再建**。v1.5.0 是在这之前就弹"另存为"，
   *      于是"候选有 N 条"直接变成"弹 N 次对话框"，每次都在失败后留下一个
   *      0 字节文件（用户的实测反馈：点一次蹦出两个另存为，都是零字节）。
   *
   * 探测失败不抛异常，返回 `{ ok:false, reason }` —— 由调用方决定换下一条候选，
   * 而不是把一条候选的网络错误变成整次下载的失败。
   */
  async function probeStream(rawUrl) {
    const url = normalizeStreamUrl(rawUrl);
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        credentials: 'include',
        cache: 'no-store',
      });

      if (resp.status !== 200 && resp.status !== 206) {
        return { ok: false, url, reason: `HTTP ${resp.status}` };
      }

      const range = resp.headers.get('Content-Range') || '';
      const m = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      const viaRange = m ? Number(m[3]) : null;
      const viaLength = Number(resp.headers.get('Content-Length')) || null;
      const total = viaRange || viaLength;
      const mime = (resp.headers.get('Content-Type') || '').split(';')[0].trim();

      // 只探测，不消费 body。1 个字节，显式取消更干净。
      try { if (resp.body && resp.body.cancel) await resp.body.cancel(); } catch (e) { /* ignore */ }

      if (!total) {
        return {
          ok: false, url,
          reason: '服务端没返回 Content-Range / Content-Length，无法判定总长度',
        };
      }
      return { ok: true, url, total, mime: mime || null, status: resp.status };
    } catch (e) {
      return { ok: false, url, reason: `请求失败：${(e && e.message) || e}` };
    }
  }

  /**
   * 用 Range 分块把一个流式端点拉完整，再交给浏览器保存。
   *
   * 循环照抄 Neet-Nestor/Telegram-Media-Downloader 的 fetchNextPart：
   *   1. fetch(url, {headers: {Range: `bytes=${offset}-`}})
   *   2. 校验响应是 200/206，且 Content-Type 确实是媒体
   *   3. 从 Content-Range 解析 start / end / total，校验偏移连续
   *   4. 累积 blob，直到 offset >= total
   *
   * **必须带 Range**：Telegram 的 /k/stream/ 端点对不带 Range 的请求会 302 到
   * cdn-api.telegram.org，那个 CDN 没有 ACAO 头，fetch 必被 CORS 拦死——这正是
   * 我前几轮踩的坑。带 Range 才走 Service Worker 的 206 分支，同源返回。
   */
  async function downloadByChunks(target, probe) {
    setMessage('正在流式下载…');
    elBar.style.width = '2%';

    // ---- 落盘目标在这里才建 ----------------------------------------------
    //
    // Telegram 的视频动辄几百 MB 到 2 GB。把所有分块攒在数组里、最后 new Blob
    // 一次性落地的话，峰值内存 = 文件大小 × 2（分块 + Blob），一个 1.5 GB 的
    // 视频足以把标签页拖垮。所以优先流式写盘。
    //
    // 关键约束：这条写入器**只能建一次**，而且必须在 probeStream 确认端点可用
    // **之后**建。走到这里就说明"确实有东西可写"—— 见 probeStream 的注释：
    // v1.5.0 把建文件放在探测之前，候选有几条就弹几次"另存为"，每次失败还在
    // 用户选定的路径上留一个 0 字节文件。
    //
    // 这条路子的价值不只是内存：**它完全不产生 chrome.downloads 条目**，
    // 所以任何下载管理器扩展（Motrix / Rayburst / IDM…）都无从接管。
    const name = buildFilename({ url: target.url, ext: target.ext || 'mp4' });
    const stage = await openStageWriter(name);
    const writable = stage.writer;
    console.info('[MediaGrab] 落盘方式:',
      stage.kind === 'opfs' ? 'OPFS 暂存（无需用户激活）' : '内存打包');

    const RF = globalThis.MediaGrabRangeFetch;
    if (!RF) throw new Error('分块下载模块未加载（rangeFetch.js）');

    // 剥掉 tweb 为绕 Chrome bug 追加的 `?_crbug1250841` —— 带这个标记请求
    // /stream/ 时，Service Worker 会走 patchChromiumMp4() 把字节改过再返回。
    // 那是对付 Chrome 播放器的补丁，不是我们要下载的原始文件。
    const url = normalizeStreamUrl(target.url);

    // 端点 URL 自带文件总字节数，拿它做**最后一票否决**：拉完的字节数必须
    // 等于它。没有这条，服务端在某个 offset 上提前结束流时，我们只会得到
    // 「每轮都成功、文件却只有前几秒」，而且**看不出任何异常**。
    const declared = (probe && probe.total)
      || Number((streamParams(url) || {}).size) || null;

    let result;
    try {
      result = await RF.fetchRangeToWriter({
        url,
        writer: writable,
        expectBytes: declared,
        onProgress: ({ received, total }) => {
          if (total) {
            elBar.style.width = `${Math.min(94, Math.round((received / total) * 94))}%`;
            elPct.textContent = `${fmtBytes(received)} / ${fmtBytes(total)}`;
          } else {
            elPct.textContent = fmtBytes(received);
          }
        },
      });
    } catch (e) {
      // 失败必须清干净：abort 句柄 + 删掉暂存条目，**不留下任何用户可见的文件**。
      // v1.5.0 正是在这里留下 0 字节残骸（当时写入器是 showSaveFilePicker 建的，
      // abort 之后文件仍躺在用户选定的路径上）。
      await stage.discard();

      // 写盘侧失败要与网络侧失败**分开说**。最常见的一种是 OPFS 配额：
      // 暂存文件写进的是**页面那个 origin** 的私有存储（Telegram 自己的），
      // 额度由浏览器按磁盘可用空间分配，几百 MB ~ 2GB 的视频写不进去就是
      // QuotaExceededError。原文是英文异常名，用户看到只会以为又是网络问题。
      const text = `${(e && e.name) || ''} ${(e && e.message) || e}`;
      if (/quota/i.test(text)) {
        const wrapped = new Error(
          `暂存写盘失败：浏览器分配给这个页面的存储额度不够（${(e && e.message) || e}）。`
          + '这类页面的大视频受此限制，可换较小的画质档再试'
        );
        wrapped.detail = e && e.detail;
        wrapped.cause = e;
        throw wrapped;
      }
      throw e;
    }

    if (!result.bytes) throw new Error('拉取到空内容');

    console.info(
      '[MediaGrab] 分块完成 —— 字节:', result.bytes,
      '/ 服务端声明:', result.total === null ? '未知' : result.total,
      '/ URL 声明:', declared === null ? '未知' : declared,
      '· mime:', result.mime || '未知'
    );

    const ext = result.ext || target.ext || 'mp4';

    // ---- 写盘路径：已经落盘，无需再交给浏览器 ----------------------------
    if (writable) {
      let staged = null;
      try {
        staged = await stage.finish();
      } catch (e) {
        throw new Error(`写入落盘文件失败：${(e && e.message) || e}`);
      }

      elBar.style.width = '100%';
      elPct.textContent = exactBytes(result.bytes);
      elMeta.textContent = `浏览器下载 · ${fmtBytes(result.bytes)}（${exactBytes(result.bytes)}）`;

      if (staged) {
        // OPFS 暂存：File 由磁盘支撑，交给 <a download> 时浏览器从磁盘流式读，
        // 不会把整片读进内存。文件名沿用暂存用的那个。
        saveAsBlob(staged, target, ext, name);
        void stage.cleanup();
        setMessage(
          `已保存 ${fmtBytes(result.bytes)}（字节数与声明一致，已校验）· 请查看浏览器下载栏`,
          'ok'
        );
      } else {
        setMessage(`已保存 ${fmtBytes(result.bytes)} 到所选文件（字节数已校验）`, 'ok');
      }
      elGo.disabled = false;
      return;
    }

    // ---- 内存路径：打包成 Blob 再触发下载 -------------------------------
    //
    // blob: URL 同样**不会被下载管理器接管**：aria2 取不到页面内的 blob，
    // 所以 Motrix Next / Rayburst 的过滤管线在 scheme 阶段就把 blob: 跳过了
    // （见 motrix-next-extension/lib/download/filter.ts 的 INTERCEPTABLE_SCHEMES
    //  —— 只认 http:/https:）。所以这条兜底虽然占内存，但至少不会被抢走。
    const isAudio = /^(ogg|oga|mp3|m4a|opus|aac|flac|wav)$/i.test(ext);
    const body = new Blob(result.chunks,
      { type: result.mime || `${isAudio ? 'audio' : 'video'}/${ext}` });

    elBar.style.width = '96%';
    elPct.textContent = `${fmtBytes(body.size)} · 保存中`;
    setMessage('正在保存…');

    saveAsBlob(body, target, ext, name);

    elBar.style.width = '100%';
    setMessage(`已触发下载（${fmtBytes(body.size)}，字节数已校验），请查看浏览器下载栏`, 'ok');
    elGo.disabled = false;
  }

  /**
   * 归一化 Telegram 的 /stream/ 地址。
   *
   * tweb 在「Chrome 播不了这个 mp4」时会重设 src 并追加 `?_crbug1250841`
   * （见 tweb 的 helpers/onMediaLoad.ts），Service Worker 见到这个标记就会先
   * `patchChromiumMp4()` 再吐字节。那是给 Chrome 播放器打的补丁，我们不想要
   * 被改过的文件 —— 而且它在不同版本里会反复增删，所以这里按"只要出现就剥掉"
   * 处理，其余 query 原样保留。
   */
  function normalizeStreamUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      if (u.searchParams.has('_crbug1250841')) u.searchParams.delete('_crbug1250841');
      return u.href;
    } catch (e) {
      return raw;
    }
  }

  /**
   * 站点名级别的"无意义标题"。
   *
   * 用户 1.7.0 实测：下出来的文件叫 `Telegram_Web.mp4` —— 那是 `document.title`，
   * 对识别这条视频毫无帮助（同一站点下所有文件都叫这个）。所以宁可退到
   * "站点 + 时间 + 可追溯 id"，也不给这种名字。
   */
  const MEANINGLESS_TITLES = new Set([
    'telegram', 'telegram web', 'telegram web k', 'telegram web a',
    'x', 'twitter', 'instagram', 'facebook', 'youtube', 'douyin', 'tiktok',
    'weibo', 'bilibili', '哔哩哔哩', 'vimeo', 'reddit',
    'home', 'index', 'video', 'media', 'undefined', 'null', 'document',
  ]);

  /** 页面标题是否含有识别价值？ */
  function meaningfulTitle(raw) {
    const t = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!t || t.length < 3) return '';
    const low = t.toLowerCase();
    if (MEANINGLESS_TITLES.has(low)) return '';
    // "Telegram Web" / "Telegram Web K" 这类：**剥掉前缀后什么都没有**才算无意义。
    // "Telegram Web · 演示视频" 剥完还剩"演示视频"，是有价值的（第一版用
    // `/^telegram\s*web/ && 无数字/` 一刀切，把这种也毙了，被用例 13 照出来）。
    const stripped = t.replace(/^telegram\s*web(?:\s*[ka])?\s*[—|·\-–:：]?\s*/i, '');
    if (stripped !== t && (!stripped || MEANINGLESS_TITLES.has(stripped.toLowerCase()))) return '';
    // 与站点名同形（x.com 的标题就是 "X"）
    const host = (Sites.hostOf(location.href) || '').toLowerCase();
    const bare = host.replace(/^www\./, '');
    if (bare && (low === bare || low === `${bare} — 主页`)) return '';
    return t;
  }

  /** 像文件名吗？必须带扩展名，否则宁可不要（避免把一整句话当名字）。 */
  function sanitizeFileName(v) {
    const s = String(v || '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s || s.length > 120) return '';
    if (!/\.[a-z0-9]{2,4}$/i.test(s)) return '';
    return s;
  }

  /**
   * 页面 DOM 里的文件名字段。用**通用选择器**，不依赖任何站点的内部类名 ——
   * Telegram 的 `doc.file_name` 只存在于 app state，DOM 里根本没有（对过
   * refs/tweb 源码：`getDocumentDownloadOptions.ts` 里 `fileName: doc.file_name`
   * 直接取自消息对象，不渲染成 DOM），所以这条在 Telegram 上通常命中不了，
   * 但对把文件名放进 `download` / `data-filename` 的站点有效。
   */
  function domFileName() {
    for (const sel of ['[data-filename]', '[data-file-name]', 'a[download]']) {
      let el = null;
      try { el = document.querySelector(sel); } catch (e) { el = null; }
      if (!el || !el.getAttribute) continue;
      const v = el.getAttribute('data-filename') || el.getAttribute('data-file-name')
        || el.getAttribute('download') || '';
      const name = sanitizeFileName(v);
      if (name) return name;
    }
    return '';
  }

  /** 端点 URL 里的文档 id —— 兜底文件名靠它保证"同页不同视频不重名"。 */
  function streamDocId(url) {
    const meta = streamParams(url || '');
    const id = meta && (meta.docId || meta.id || meta.fileId);
    return id ? String(id) : '';
  }

  /**
   * 下载文件名。按可得性分级，能拿到原名就绝不用兜底：
   *
   *   1. 端点 URL 自带的 `fileName` —— Telegram `/stream/`（progressive）有；
   *   2. 页面 DOM 的 `data-filename` / `<a download>`（通用选择器）；
   *   3. 页面标题（og:title → document.title），但**滤掉**"Telegram Web"这类
   *      没有识别价值的；
   *   4. 兜底 `站点_YYYYMMDD-HHMMSS[_docId 尾 6 位].ext` —— 唯一、可排序、
   *      可回溯到具体那条媒体。
   *
   * 为什么第 4 步不是 `pageTitle`：同一站点下所有下载都叫同一个名字，用户
   * 完全无法区分（1.7.0 实测就是 `Telegram_Web.mp4`）。
   */
  function buildFilename(target) {
    const url = (target && target.url) || '';
    const ext = (target && target.ext) || 'mp4';

    const fromUrl = streamUrlFilename(url);
    if (fromUrl) return fromUrl;

    const fromDom = domFileName();
    if (fromDom) return fromDom;

    const title = meaningfulTitle(pageTitle());
    if (title) {
      return `${title.slice(0, 100).replace(/\s+/g, '_')}.${ext}`;
    }

    // web.telegram.org → telegram（不是 org！）：取**倒数第二段**，
    // 只有两段时取第一段（x.com → x）。1.7.0 第一版写成 .pop()，
    // 于是兜底名长成 org_20261005-134248_076975.mp4，被用例照出来。
    const hostParts = (Sites.hostOf(location.href) || '').split('.').filter(Boolean);
    const site = (hostParts.length > 2 ? hostParts[hostParts.length - 2] : hostParts[0]) || 'media';
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
      + `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const id = streamDocId(url);
    const tail = id ? `_${id.slice(-6)}` : '';
    return `${site}_${stamp}${tail}.${ext}`;
  }

  function baseFilename(target) {
    const raw = (elTitle.textContent || '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'video';
    const safe = raw.slice(0, 100).replace(/\s+/g, '_');
    return `${safe}.${target.ext || 'mp4'}`;
  }

  elGo.addEventListener('click', async () => {
    // 上下文失效时，唯一有意义的动作就是刷新本页 —— 所以不管按钮上写的是
    // 「开始下载」还是「刷新本页」，点了都做这件事。
    if (elGo.dataset.action === 'reload' || !contextAlive()) {
      location.reload();
      return;
    }

    // 「整片下载失败」后按钮会变成这个：改用播放器缓存导出。
    // 这一步**必须由用户主动点**——见 startViaBrowser 里那段注释：
    // 缓存导出只含已缓冲片段，自动降级等于悄悄给用户一个半截文件。
    if (elGo.dataset.action === 'mse') {
      delete elGo.dataset.action;
      elGo.textContent = '开始下载';
      await captureMseFile({ declared: lastDeclaredBytes, reason: lastFailureText });
      return;
    }

    // 本页能力校正放在取 mode 之前：运行时流页面会被强制切回 browser。
    enforceModeForPage();
    const mode = elMode.value;
    const quality = elQuality.value;
    const outDir = elOutDir.value.trim();
    // 被本页限制强制切回 browser 时不写回设置，免得冲掉别的站点的偏好。
    if (!modeForced) await send({ type: 'setSettings', patch: { mode, quality, outDir } });

    if (mode === 'browser') {
      await startViaBrowser(quality);
      return;
    }
    await startViaYtdlp(quality, outDir);
  });

  elReveal.addEventListener('click', async () => {
    if (!currentJob) return;
    const job = await send({ type: 'poll', jobId: currentJob });
    if (job && job.file) await send({ type: 'reveal', path: job.file });
  });

  panel.querySelector('.opendir').addEventListener('click', () => {
    send({ type: 'openDir', dir: elOutDir.value.trim() });
  });

  // -------------------------------------------------------------------------
  // 对外接口：工具栏（popup）下指令，页面执行
  //
  // 页面内没有按钮了，所以 popup 必须能把"开始下载"这件事交回页面来做
  //（原因见上面 UI 段落：流端点与 MSE 字节都只存在于页面上下文）。
  // 三个消息：
  //   pageDetect   —— 重新识别一次，回 {state, summary}（popup 打开时轮询它）
  //   pageDownload —— 按 popup 传来的 quality / mode / outDir 起一次下载
  //   pageStatus   —— 只回快照（popup 不需要重跑识别时用）
  // -------------------------------------------------------------------------

  /**
   * popup 点了「下载此页视频」之后的完整流程。
   *
   * 等价于旧版点 fab → 在面板上点「开始下载」，只是输入来自消息而不是表单。
   */
  async function pageDownload(opts = {}) {
    if (!contextAlive()) {
      return { ok: false, error: '扩展刚被重载，请刷新本页后重试', stale: true };
    }

    // 每次重新识别 + 重新收集候选：用户可能刚切到另一条消息。
    refresh();
    await loadSettings();
    if (opts.quality) elQuality.value = opts.quality;
    if (opts.mode) elMode.value = opts.mode;
    if (typeof opts.outDir === 'string' && opts.outDir) elOutDir.value = opts.outDir;
    // popup 的档位选择（-1 = 不指定，按"最近被请求过的"那条）
    pickedVariantIndex = Number.isInteger(Number(opts.variantIndex)) ? Number(opts.variantIndex) : -1;

    if (current.kind === 'none') {
      setMessage('本页没识别到可下载的视频 —— 先把视频播放几秒让它开始缓冲，再点一次', 'err');
      publish(true);
      return { ok: false, error: '本页没识别到可下载的视频' };
    }

    elTitle.textContent = pageTitle() || (current.kind === 'direct' ? '页面直链视频' : (current.site || ''));
    resetProgress();
    const ytdlpBlocked = enforceModeForPage();
    if (ytdlpBlocked) setMessage(YTDLP_BLOCKED_HINT);

    // B 站这类"音视频分离 + CDN 校验 Referer"的站点：浏览器通道必然失败，
    // 直接交给 yt-dlp，不要先白跑一圈。
    if (current.ytdlpOnly) {
      elMode.value = 'ytdlp';
      syncModeUi();
      await startViaYtdlp('best', elOutDir.value.trim());
      publish(true);
      return { ok: true };
    }

    // 先把"接下来会下什么"写进 meta：popup 上那一行摘要就是它。
    const fresh = sniffDirect();
    sniffer = fresh;
    const streamCands0 = (fresh.list || []).filter((f) => isSameOriginStream(f.url || ''));
    const found0 = pickStreamCandidate(streamCands0, elQuality.value)
      || pickDirect(fresh, elQuality.value);
    if (found0) describeDirect(found0, fresh);

    if (elMode.value === 'browser') {
      await startViaBrowser(elQuality.value);
    } else {
      await startViaYtdlp(elQuality.value, elOutDir.value.trim());
    }
    publish(true);
    return { ok: true };
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (!msg || typeof msg !== 'object' || !msg.type) return undefined;

      if (msg.type === 'pageDetect') {
        // popup 的画质下拉是用户当前的选择，摘要必须按它算「当前画质整片约 X」。
        if (msg.quality) elQuality.value = msg.quality;
        refresh();
        const st = buildState();
        pageState = st;
        reply({ ok: true, state: st, summary: pageSummary() });
        return true;
      }

      if (msg.type === 'pageStatus') {
        // 当场造状态，别返回缓存 —— 后台标签页的定时器会被 Chrome 节流。
        const st = buildState();
        pageState = st;
        reply({ ok: true, state: st, summary: pageSummary() });
        return true;
      }

      // 「整片下载失败」之后唯一的人工出口。
      //
      // 这条必须由 popup 显式触发（按钮会变成「改用播放器缓存导出」）：
      // 缓存导出只含已缓冲片段，自动降级等于悄悄给用户一个半截文件 ——
      // 用户已经因此被骗过两轮（"下载下来播放却还是只有 5 秒"）。
      if (msg.type === 'pageMseExport') {
        captureMseFile({ declared: lastDeclaredBytes, reason: lastFailureText }).then(
          () => publish(true),
          (e) => {
            setMessage(`导出失败：${(e && e.message) || e}`, 'err');
            publish(true);
          }
        );
        reply({ ok: true, started: true });
        return true;
      }

      if (msg.type === 'pageDownload') {
        // 先做**同步**前置检查，让 popup 立刻拿到一个有意义的答复；
        // 之后再异步跑整条下载（原因见下面的注释）。
        if (!contextAlive()) {
          reply({ ok: false, error: '扩展刚被重载，请刷新本页后重试' });
          return true;
        }
        refresh();
        if (current.kind === 'none') {
          setMessage('本页没识别到可下载的视频 —— 先把视频播放几秒，再点一次', 'err');
          publish(true);
          reply({ ok: false, error: '本页没识别到可下载的视频（先把视频播放几秒）' });
          return true;
        }

        pageDownload(msg).then(
          () => publish(true),
          (e) => {
            setMessage(`启动失败：${(e && e.message) || e}`, 'err');
            publish(true);
          }
        );
        reply({ ok: true, started: true });
        return true;
      }

      return undefined;
    });
  }

  // -------------------------------------------------------------------------
  // SPA navigation + media appearing later
  // -------------------------------------------------------------------------

  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      refresh();
      publish(true);
    }
  }, 1500);

  // 先读回上次被刷新打断的任务 —— 必须在第一次 refresh() 之前，
  // 否则面板会先刷成"就绪"，把这条重要信息冲掉。
  loadInterruptedJobs();

  refresh();
  if (resumedJobs.length) {
    const last = resumedJobs[resumedJobs.length - 1];
    setMessage(
      `上次《${last.name}》在页面刷新时被中断`+
      `（已下 ${fmtBytes(last.received)}${last.total ? ` / ${fmtBytes(last.total)}` : ''}）`+
      '。它**没有在后台继续下载**（Telegram 的字节只能由页面的 Service Worker 兑现，'+
      '页面一关就没了）。已下载的部分仍在暂存里，再点一次「下载此页视频」会从断点接着下',
      'err'
    );
  }
  setInterval(refresh, 3000);
  // 状态快照：popup 打开时读的就是它。没有这一步，从菜单栏点下载之后
  // 用户再打开 popup 只会看到一句"就绪"，等于没有反馈。
  setInterval(publish, 700);
  startStreamCollector();
})();

/**
 * 顺序 Range 分块拉取。
 *
 * 为什么单独一个文件：**为了能在 Node 里单测**。这条链路上已经踩过三个坑，
 * 每一个的症状都是「下载出一个坏文件」，极难从表象倒推：
 *
 *   1. 不带 Range 头 → 服务器 302 到没有 ACAO 头的 CDN → fetch 直接 CORS 死；
 *   2. 服务器忽略了我们的 offset（返回的 Content-Range 起点 ≠ 期望起点）
 *      → 字节会**错位拼接**，产出一个能打开但画面花掉的文件；
 *   3. 总长度前后不一致（stream 被 Service Worker 回收后重建）
 *      → 同样拼出错位文件；
 *   4. 拿到手的字节比声明少（服务端提前结束流）→ 产出一个"能播几秒就没了"
 *      的半截文件。**这一条最阴**：文件能打开、时长栏显示的还是完整时长
 *      （moov 在前，duration 是全片），只有实际播到断点才发现。
 *   5. 带了 Range 却回 200（Range 被忽略）→ 整份文件被重复拼接；
 *      206 却不带 Content-Range → 偏移无从校验，只能拼出一个没人能验的文件。
 *   6. **服务端既不吐字节也不报错**（请求永久挂起）。见下面 chunkTimeoutMs。
 *
 * 这几种都可能"成功地"产出坏文件，所以判据要写死、要能回归测试。
 * 另外每个错误都挂 `err.detail`（status / Content-Range / offset / 已收字节），
 * 调用方把它摊在面板上 —— 失败点在第几层，一眼可见。
 *
 * 用法：
 *   const {fetchRangeToWriter} = globalThis.MediaGrabRangeFetch;
 *   const r = await fetchRangeToWriter({
 *     url, writer,                      // writer 为 null 时把字节收进 r.chunks
 *     expectBytes,                      // 声明总长（URL 参数里的 size），最后一票否决
 *     onProgress: ({received, total}) => {},
 *   });
 *   // r = {chunks, bytes, total, mime, ext, complete}
 */
(function () {
  // 照抄 Neet-Nestor/Telegram-Media-Downloader 的 contentRangeRegex。
  const CONTENT_RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+)$/;

  const DEFAULT_RETRIES = 3;
  const RETRY_BASE_DELAY_MS = 400;
  const MAX_CHUNKS = 20000;

  /**
   * 单轮请求的超时（毫秒）。
   *
   * 为什么必须有：tweb 的 `/hls_stream/` 是这样兑现字节的
   * （`lib/serviceWorker/index.service.ts` → `onHlsStreamFetch`）：
   *
   *   const deferred = deferredPromise<Response>();
   *   event.respondWith(deferred);            // ← 只有 deferred 被 resolve 才回响应
   *   ...
   *   const filePart = await fetchAndConcatFileParts(...);
   *   deferred.resolve(new Response(...));
   *   } catch (e) { deferred.resolve(get500ErrorResponse()); }
   *
   * 而 `fetchAndConcatFileParts` 里的 `RequestSynchronizer` 是
   *
   *   let request = this.ongoingRequests.get(key);
   *   if (!request) this.ongoingRequests.set(key, request = requestFn());
   *   const result = await request;          // ← 挂住的 promise 会被永久缓存
   *
   * 只要**有一次** MTProto 分片请求（`requestFilePart`）没回，它的 promise 就
   * 永远留在 map 里，之后每个请求都要 `await` 同一个永不 settle 的 promise，
   * 而 `deferred` 也永远不会 resolve —— **响应既不来也不报错**。
   *
   * 症状（1.8.0 实测）：进度停在 `40 MiB / 125 MiB`（30%）再也不动，重试无效、
   * 页面刷新后一切归零。没有超时的话这条链路上**没有任何东西**能结束它：
   * `await resp.arrayBuffer()` 会一直等下去。
   *
   * 所以每一轮都必须有 deadline：超时按**可重试**处理（同一个 offset 再来），
   * 因为挂起通常是暂时的（SW 回收、连接半死）；连续超时到耗尽重试才报明确的错。
   */
  const DEFAULT_CHUNK_TIMEOUT_MS = 30_000;

  // 每轮请求的字节数。4 MiB 是折中：太小则几百 MB 的文件要几千轮，太大则
  // Service Worker 侧要一次性凑齐（tweb 内部按 1 MiB 的 file part 拉取再拼）。
  const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

  // 默认只接受媒体响应。服务端返回 HTML 错误页时（旧版 15KB 垃圾文件的来源），
  // MIME 是最后一层拦截。
  const DEFAULT_MIME_RE = /^(video|audio|application\/octet-stream)/i;

  // mime → 文件扩展名。直接拿子串当扩展名会得到 "quicktime" 这种假扩展名。
  const MIME_EXT = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/wav': 'wav',
  };

  /** 不可重试的错误（服务端明确拒绝 / 数据错位，重试没有意义）。 */
  function fatal(message) {
    const err = new Error(message);
    err.fatal = true;
    return err;
  }

  /**
   * 给错误挂上**现场信息**。
   *
   * 这条链路的每一次失败，症状都是「下载出来的文件不对」，而失败点在四层之外：
   * fetch 状态码 / Content-Range / 服务端提前结束流 / 字节数对不上。以前这些
   * 信息只活在 catch 的 e.message 里（一句 "HTTP 500"），排查时只能靠猜。
   * 现在统一挂 `err.detail`，调用方（content.js）把它摊在面板上 ——
   * 一张截图就能定位到底是哪一层断的。
   */
  function withDetail(err, detail) {
    try {
      if (err && typeof err === 'object' && !err.detail) err.detail = detail;
    } catch (e) { /* ignore */ }
    return err;
  }

  function extFromMime(mime) {
    if (!mime) return null;
    const base = mime.split(';')[0].trim().toLowerCase();
    if (MIME_EXT[base]) return MIME_EXT[base];
    const sub = base.split('/')[1];
    // 只认像扩展名的子类型，别把 "octet-stream" 当扩展名用。
    return sub && /^[a-z0-9]{2,4}$/.test(sub) ? sub : null;
  }

  /**
   * 给一个 promise 加 deadline。
   *
   * 超时抛的是**普通 Error**（不是 fatal），所以会走重试而不是直接判死 ——
   * 挂起通常是暂时的（Service Worker 被回收、连接半死），换个连接往往就好了。
   * 只有把 `retries` 耗光才会最终失败，那时错误消息会带上挂了多少次。
   *
   * ⚠️ 不主动 abort 底层 fetch：很多实现里 `AbortController` 会连带把响应体
   * 流掐掉，而我们的重试紧接着就发下一次请求，两个请求交叠反而更糟。
   * 让它泄漏一次（响应最终到达时 Promise 已被丢弃，无害）比掐断更稳。
   */
  function withDeadline(promise, ms, message) {
    if (!ms || ms <= 0 || typeof Promise.race !== 'function') return promise;
    // 定时器 API 缺失时（某些 vm 沙箱只注入了一半）退回无超时模式，
    // 而不是 ReferenceError —— 后者会把整条下载链路炸掉，且报错与本意无关。
    if (typeof setTimeout !== 'function') return promise;
    if (typeof clearTimeout !== 'function') clearTimeout = () => {};
    let timer = 0;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(message);
        // 标记出来，方便上层把"挂起"和"网络抖动"分开说
        err.timedOut = true;
        reject(err);
      }, ms);
      // ⚠️ 不要 unref。`unref` 只有 Node 的定时器有（浏览器返回数字），
      // 而它在这里是有害的：Node 仿真测试里整条链路都是 promise，一旦所有
      // 定时器都被 unref，事件循环会空掉、进程以 exit 0 **静默退出** ——
      // 现象是"用例标题打印了、然后什么断言都没有"。这个坑本项目踩过两次。
      // 代价仅仅是 Node 进程最多多活 chunkTimeoutMs，可以接受。
    });
    return Promise.race([promise, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async function fetchRangeToWriter(opts) {
    const {
      url,
      writer = null,
      fetchImpl = (...args) => fetch(...args),
      retries = DEFAULT_RETRIES,
      onProgress = null,
      mimeAllow = DEFAULT_MIME_RE,
      signal = null,
      sleepImpl = null,
      baseDelayMs = RETRY_BASE_DELAY_MS,
      chunkSize = DEFAULT_CHUNK_SIZE,
      expectBytes = null,
      chunkTimeoutMs = DEFAULT_CHUNK_TIMEOUT_MS,
      startOffset = 0,
      initialTotal = null,
      progressStalledMs = null,
    } = opts || {};

    if (!url) throw new Error('缺少 URL');

    const sleep = sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));

    const chunks = [];
    // startOffset：从已有字节之后接着拉（断点续传）。OPFS 里的暂存文件在页面
    // 刷新后**仍然存在**（只有失败才会 discard，卸载不会执行清理），而
    // `createWritable({keepExistingData:true}) + seek()` 能继续往后写 ——
    // 所以刷新一次不必从头 125 MiB 重来。
    let next = Number(startOffset) > 0 ? Number(startOffset) : 0;
    let total = initialTotal === null || initialTotal === undefined ? null : Number(initialTotal);
    let mime = null;
    // bytes 是**本次会话**收到的字节；已存在的 startOffset 字节单独计入 totals，
    // 否则完整性闸门（bytes !== total）会把续传判成"字节不足"。
    const carried = next;
    let bytes = 0;
    let rounds = 0;
    let lastDetail = null;
    let timeouts = 0;

    /**
     * 取一块。可重试的错误（网络层 / 429 / 5xx / 读流中断）抛普通 Error；
     * 不可重试的抛 fatal()。
     */
    async function readOnce(offset) {
      // 已知总长之后一律发**闭区间** Range（`bytes=a-b`），不再用开区间
      // （`bytes=a-`）。这不是优化，是 `/hls_stream/` 端点的硬要求：
      //
      //   tweb 的 onHlsStreamFetch 是 `const [lower, upper] = parseRange(header)`，
      //   然后把 `upper` 直接当终点用（parseRange('bytes=0-') → [0, 0]）。
      //   于是开区间请求只能拿回 **1 个字节**，并声称 `bytes 0-0/<size>` ——
      //   照旧写法就变成每轮 1 字节，两万轮也下不完。
      //
      // 而 `/stream/`（Stream.requestRange）对开区间有专门的补全逻辑，闭区间同样
      // 正确处理 —— 所以统一发闭区间，两边都对。
      // 第一轮还不知道总长，只能先发开区间探一次（两个端点都能正常应答）。
      const range = total === null
        ? `bytes=${offset}-`
        : `bytes=${offset}-${Math.min(offset + chunkSize - 1, total - 1)}`;

      const resp = await withDeadline(
        fetchImpl(url, {
          method: 'GET',
          headers: { Range: range },
          credentials: 'include',
          signal: signal || undefined,
        }),
        chunkTimeoutMs,
        `请求挂起超过 ${Math.round(chunkTimeoutMs / 1000)} 秒（offset=${offset}）`
      );

      // 现场信息：这个对象的每一栏都对应一个真实的失败模式，出错时会被挂到
      // err.detail 上透出到面板。
      const detail = {
        offset,
        range,
        status: resp.status,
        contentType: resp.headers.get('Content-Type') || '',
        contentRange: resp.headers.get('Content-Range') || '',
        contentLength: resp.headers.get('Content-Length') || '',
        received: bytes,
        total,
        expectBytes,
      };

      if (resp.status !== 200 && resp.status !== 206) {
        const text = `HTTP ${resp.status}`;
        // 429 / 5xx 值得再试；403、404 之类再试也是白试。
        if (resp.status === 429 || resp.status >= 500) throw withDetail(new Error(text), detail);
        throw withDetail(fatal(text), detail);
      }

      // 带了 Range 却回 200：服务端把整份文件又发了一遍。只有 offset === 0 时
      // 200 才有正当含义（"这就是整份文件"）；offset > 0 还回 200 说明 Range
      // 被忽略了，继续往后写只会把文件重复拼接 —— 必然是一个坏文件。
      if (resp.status === 200 && offset > 0) {
        throw withDetail(
          fatal(`服务端忽略了 Range：offset=${offset} 仍返回 200`),
          detail
        );
      }

      const contentType = (detail.contentType || '').split(';')[0].trim();
      if (contentType && mimeAllow && !mimeAllow.test(contentType)) {
        throw withDetail(fatal(`响应不是媒体：${contentType}`), detail);
      }

      const contentRange = detail.contentRange;
      const contentLength = Number(detail.contentLength) || 0;

      // 206 必须带 Content-Range。没有它就无法验证偏移是否连续 ——
      // 与其拼一个**无从校验**的文件（这正是"下载出来能播几秒就没了"的来源），
      // 不如直接报错。
      if (resp.status === 206 && !contentRange) {
        throw withDetail(fatal('206 响应缺少 Content-Range，无法校验偏移'), detail);
      }

      // 先读字节再校验：读取中途被掐掉（连接断了 / SW 把流回收了）是可重试的。
      const buffer = await resp.arrayBuffer();

      // 声明长度与实际长度不符 = 这条响应被截断了。可重试（不推进 offset）。
      if (contentLength && buffer.byteLength !== contentLength) {
        throw withDetail(
          new Error(`响应体不完整：${buffer.byteLength}/${contentLength}`),
          detail
        );
      }

      return { contentType, contentRange, contentLength, buffer, detail };
    }

    for (;;) {
      rounds += 1;
      if (rounds > MAX_CHUNKS) throw new Error('分块次数超过上限');
      if (signal && signal.aborted) throw new Error('已取消');

      let piece = null;
      let lastError = null;

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (attempt > 0) await sleep(baseDelayMs * attempt);
        try {
          piece = await readOnce(next);
          break;
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          if (e && e.fatal) throw e;
          lastError = e;
          // 挂起次数单独计数：连续挂起说明这条连接/这个 SW 状态已经不行了，
          // 光重试没用，得让用户看到"卡在哪"。
          if (e && e.timedOut) timeouts += 1;
        }
      }
      if (!piece) {
        const why = lastError || new Error('分块拉取失败');
        if (timeouts >= retries) {
          throw withDetail(
            fatal(`连续 ${timeouts} 次请求挂起无响应（offset=${next}）`),
            Object.assign({ stalled: true, timeouts }, lastDetail || {})
          );
        }
        throw why;
      }
      if (timeouts) timeouts = 0;   // 这一轮成功了，计数归零

      if (piece.contentType) mime = piece.contentType;
      lastDetail = piece.detail;

      const match = piece.contentRange && piece.contentRange.match(CONTENT_RANGE_RE);
      let last = false;

      if (match) {
        const start = parseInt(match[1], 10);
        const end = parseInt(match[2], 10);
        const whole = parseInt(match[3], 10);

        // 关键校验 1：起点必须等于我们请求的 offset。不等就说明服务端忽略了
        // Range（或给了别的区间），继续往下拼就是错位文件。
        if (start !== next) {
          throw withDetail(fatal(`分块不连续：期望 ${next}，服务端返回 ${start}`), piece.detail);
        }
        // 关键校验 2：总长度不能变。变了说明这已经不是同一条流（SW 回收后重建），
        // 前后两段字节不属于同一个文件。
        if (total !== null && whole !== total) {
          throw withDetail(fatal(`总长度前后不一致：${total} → ${whole}`), piece.detail);
        }
        // 关键校验 3：单块字节数必须等于区间长度。SW 报 `bytes a-b/N` 却少给字节
        // 时，这类响应**本身是 206、status 正常**，只有长度对不上能发现。
        if (piece.buffer.byteLength !== end - start + 1) {
          throw withDetail(
            fatal(`分块长度不符：声明 ${end - start + 1}，实收 ${piece.buffer.byteLength}`),
            piece.detail
          );
        }

        next = end + 1;
        total = whole;
        last = next >= total;
      } else {
        // 没有 Content-Range：服务器不支持 Range，这一次 200 就是整份文件。
        // 拿不到 Content-Length 也要停下来，否则会无限循环请求同一个 URL。
        total = next + (piece.contentLength || piece.buffer.byteLength);
        next = total;
        last = true;
      }

      const view = new Uint8Array(piece.buffer);
      bytes += view.byteLength;
      if (writer) await writer.write(view);
      else chunks.push(view);

      if (onProgress) {
        onProgress({
          received: bytes,
          // 绝对位置：从断点续传时 received 是本次会话的增量，
          // 只报它会让进度条在续传时从 0 开始重新爬（1.8.0 实测的"下载重置"观感）。
          offset: carried + bytes,
          total,
          chunk: view.byteLength,
          mime,
        });
      }

      if (last) break;
    }

    // ---- 完整性闸门 ------------------------------------------------------
    //
    // 到这里为止所有分块都"看起来成功"了，但仍然可能是半截文件：服务端可以
    // 一边报 `Content-Range: .../<total>`，一边在某个 offset 上直接结束流。
    // 用户看到的症状是「十几分钟的视频，下下来只有前几秒」—— 文件打得开、
    // 时长栏还是完整时长（moov 在前），只有播到断点才发现没了。
    //
    // 所以这里不接受"请求都成功了"作为完成判据，只接受**字节数对得上**。
    // 注意两个闸门都比的是「含续传字节的总���」：断点续传时 bytes 只是本次会话
    // 新收到的部分，直接拿它跟 total 比会把一次成功的续传判成"字节不足"。
    if (total !== null && carried + bytes !== total) {
      throw withDetail(
        fatal(`拉到的字节数不足：${carried + bytes}/${total}（服务端提前结束了流）`),
        lastDetail
      );
    }
    if (expectBytes !== null && carried + bytes !== expectBytes) {
      throw withDetail(
        fatal(`字节数与文件声明不符：实际 ${carried + bytes}，声明 ${expectBytes}`),
        lastDetail
      );
    }

    return {
      chunks, bytes, carried, total, mime, ext: extFromMime(mime), complete: true,
    };
  }

  globalThis.MediaGrabRangeFetch = {
    fetchRangeToWriter,
    CONTENT_RANGE_RE,
    extFromMime,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_CHUNK_TIMEOUT_MS,
  };
})();

/**
 * MediaGrab 落盘暂存（两个世界共用）。
 *
 * 为什么单独一个文件：这份代码要跑在**两个不同的世界**里，而它们之间不能直接
 * 互相调用（隔离世界的函数在页面世界不可见，反之亦然）：
 *
 *   · MAIN world（hooks.js）—— 现在是整片 Range 拉取的执行处；
 *   · 隔离世界（content.js）—— 兜底路径（页面世界没装钩子时）仍然要用。
 *
 * 放进 manifest 的两条 content_scripts 里各注入一次，是唯一能真正"共用"的方式。
 *
 * 职责只有一件事：**给 rangeFetch 一个能流式落盘的写入目标，失败时能把它清干净。**
 * 三条路的取舍见 open() 的注释。
 */
(function () {
  /**
   * 建一个能把字节**流式落盘**的暂存目标。
   *
   * ⚠️ 为什么**不再**用 `showSaveFilePicker`：入口从页面按钮移到工具栏之后，
   * 页面里不再有"用户激活"，而它要求瞬时激活（激活不跨上下文传递，popup 的
   * 点击不算页面的）。v1.5.0 把它留在优先级第一位，换来一连串具体故障：候选回退
   * 队列里有几条同源流就弹几次"另存为"；用户选完路径、下载却失败时
   * `writable.abort()` 会在磁盘上留下一个 **0 字节文件**。
   *
   * 只剩两条路：
   *   1. **OPFS 暂存**（首选）：不需要激活，失败可清理，不产生 chrome.downloads
   *      条目所以下载管理器扩展无从接管。代价：占**页面那个 origin** 的存储额度
   *      （Telegram 一页十几个视频，额度由浏览器按磁盘可用空间分配），大视频可能
   *      写到一半抛 `QuotaExceededError`。
   *   2. **内存打包**（兜底）：功能不降级，峰值内存 ≈ 文件大小。
   *
   * 落盘时机也很重要：**先探测、再落盘**。调用方必须在确认端点可用（拿到总长度）
   * 之后才来建写入器 —— 反过来做就是"候选有 N 条就建 N 个文件"，失败时还要挨个
   * 清理，中间任何一次中断都会留下残骸。
   *
   * @param {string} name 建议文件名（会清洗成 OPFS 安全的单段名字）
   * @param {{expectTotal?: number|null}} opts
   *   `expectTotal` 传了就启用**断点续传**：暂存文件若已存在且长度小于总长，
   *   就在它后面接着写，返回值里带上 `resumeFrom`（已有字节数）。
   *   页面刷新会中止下载（字节只能在页面世界拉），但 OPFS 里那份暂存文件
   *   **不会被清掉** —— 于是刷新一次不必从头 125 MiB 重来。
   * @returns {Promise<{kind:string, writer:object|null, resumeFrom:number, finish:Function, cleanup:Function, discard:Function}>}
   */
  async function open(name, opts) {
    // OPFS 的 getFileHandle 不接受含路径分隔符的名字；这里的 name 可能来自页面
    // 标题或端点 URL 里的 fileName，清洗一遍更稳。
    const safe = String(name || 'video.mp4').replace(/[\\/]+/g, '_').slice(0, 180);
    const expectTotal = Number((opts || {}).expectTotal) || 0;

    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(`${safe}.part`, { create: true });

      // ---- 断点续传：先看已有多长 ------------------------------------------
      //
      // ⚠️ `createWritable()` **默认 truncate**，会把已写的内容清掉 —— 这就是
      // "刷新后从头再来"的直接原因：暂存文件明明还在，却被下一个写入器抹平。
      // 要接着写必须 `keepExistingData: true` 并 `seek()` 到已有长度。
      let resumeFrom = 0;
      if (expectTotal) {
        try {
          const existing = await fileHandle.getFile();
          const have = existing.size || 0;
          // 只有"比总长小、且不是空文件"才续：等于总长说明上次已经下完但没交付，
          // 那就重新写一遍（避免把残缺文件当完整的交出去）。
          if (have > 0 && have < expectTotal) resumeFrom = have;
        } catch (e) { /* 拿不到就当没有 */ }
      }

      const writable = await fileHandle.createWritable(
        resumeFrom ? { keepExistingData: true } : undefined
      );
      if (resumeFrom && typeof writable.seek === 'function') {
        await writable.seek(resumeFrom);
      }

      return {
        kind: 'opfs',
        writer: writable,
        resumeFrom,
        finish: async () => { await writable.close(); return fileHandle.getFile(); },
        // 交付是异步的（浏览器从 File 句柄流式读），所以延迟删除，别在还没读完
        // 时就把暂存文件撤掉。
        cleanup: async () => {
          setTimeout(async () => {
            try { await root.removeEntry(`${safe}.part`); } catch (e) { /* 已被清理 */ }
          }, 300_000);
        },
        // 失败路径：立刻 abort 并删掉暂存条目。OPFS 是私有的，但它同样占配额；
        // 更要紧的是不给用户留"看起来下好了、其实是空文件"的残骸。
        discard: async () => {
          try { await writable.abort(); } catch (e) { /* ignore */ }
          try { await root.removeEntry(`${safe}.part`); } catch (e) { /* ignore */ }
        },
      };
    } catch (e) {
      if (globalThis.console && console.warn) {
        console.warn('[MediaGrab] OPFS 暂存不可用，回落内存打包：', (e && e.message) || e);
      }
    }

    return {
      kind: 'memory',
      writer: null,
      resumeFrom: 0,
      finish: async () => null,
      cleanup: async () => {},
      discard: async () => {},
    };
  }

  /**
   * 暂存文件是否还留着（页面刷新后用来告诉用户"上次下到哪儿了"）。
   *
   * 只报**长度**，不报内容：长度足以回答"要不要从头再来"，而读内容会把
   * 几百 MB 拉进内存，没有必要。
   */
  async function partialSize(name) {
    const safe = String(name || 'video.mp4').replace(/[\\/]+/g, '_').slice(0, 180);
    try {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(`${safe}.part`, { create: false });
      const f = await fh.getFile();
      return f.size || 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 判断一个错误是不是"浏览器给这个页面的存储额度不够"。
   *
   * 单独抽出来是因为两个世界都要用，而文案必须一致 —— 用户看到英文异常名
   * （`QuotaExceededError`）只会以为是网络问题。
   */
  function isQuotaError(err) {
    if (!err) return false;
    return /quota/i.test(`${err.name || ''} ${err.message || err}`);
  }

  globalThis.MediaGrabStaging = { open, partialSize, isQuotaError };
})();

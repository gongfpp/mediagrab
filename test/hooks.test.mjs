/**
 * hooks.js 的最小 DOM 桩测试。
 *
 * 跑法：node test/hooks.test.mjs
 *
 * 目的：验证 MSE 捕获 + 跨世界事件导出这条路径真的能跑通，而不是又靠
 * "看起来对"。这两个环节合计已经翻车过 4 轮（钩子被 documentElement 判空
 * 挡掉、DASH 过滤正则误杀、整文件不幂等、导出走了会失效的 chrome.runtime），
 * 所以留下这个回归测试。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'extension', 'hooks.js'), 'utf8');

let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

function makeEnv() {
  const listeners = new Map();
  const dataset = {};
  const clicked = [];
  const videos = [];
  let intervalCount = 0;

  const documentElement = { dataset, appendChild() {} };
  const document = {
    documentElement,
    body: { appendChild() {} },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type) || [];
      listeners.set(type, arr.filter((f) => f !== fn));
    },
    dispatchEvent(ev) {
      for (const fn of [...(listeners.get(ev.type) || [])]) fn(ev);
      return true;
    },
    createElement() {
      const el = {
        tagName: 'A', style: {}, href: '', download: '', rel: '',
        click() { clicked.push({ href: el.href, download: el.download }); },
        remove() {},
      };
      return el;
    },
    querySelectorAll(sel) { return sel === 'video' ? videos : []; },
  };

  /**
   * 造一个 <video> 桩。
   *
   * hooks.js 的新逻辑要用它把"某条 MSE 缓存轨"对回到"页面上的哪个视频"，
   * 进而按**占位面积**（而不是字节数）选轨 —— 这一条正是为了修
   * 「Telegram 聊天里的表情小视频字节比正片多，导出的却是表情」。
   */
  function addVideo({ src = '', w = 0, h = 0, duration = 0, buffered = 0, layout = 0 }) {
    const el = {
      src,
      currentSrc: src,
      videoWidth: w,
      videoHeight: h,
      duration,
      paused: false,
      buffered: {
        length: buffered ? 1 : 0,
        end: () => buffered,
      },
      getBoundingClientRect: () => ({ width: layout, height: 1 }),
    };
    videos.push(el);
    return el;
  }

  class SourceBuffer { appendBuffer() {} }
  class MediaSource {
    addSourceBuffer() { return new SourceBuffer(); }
    endOfStream() {}
  }
  class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init && init.detail; }
  }

  // XHR 桩要能触发 load —— hooks.js 的通道 2 就是挂在 open() 里 addEventListener
  // ('load')，测 API 响应体解析必须走这条真实路径，不能直接调内部函数。
  class XMLHttpRequest {
    constructor() {
      this._listeners = new Map();
      this.responseType = '';
      this.responseText = '';
    }
    open() {}
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    fire(type) {
      for (const fn of [...(this._listeners.get(type) || [])]) fn.call(this);
    }
  }

  let objectUrlSeq = 0;
  const madeBlobs = [];   // 导出时交给 createObjectURL 的 Blob —— 留着做逐字节校验
  const sandbox = {
    document,
    CustomEvent,
    MediaSource,
    SourceBuffer,
    Blob,
    URL: {
      createObjectURL(obj) {
        objectUrlSeq += 1;
        madeBlobs.push(obj);
        return `blob:https://example.test/${objectUrlSeq}`;
      },
      revokeObjectURL() {},
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval() { intervalCount += 1; return intervalCount; },
    clearInterval() {},
    XMLHttpRequest,
  };
  sandbox.window = sandbox;              // hooks.js 用 window.__mgXxx 打标记
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  return {
    context,
    dataset,
    clicked,
    videos,
    madeBlobs,
    addVideo,
    intervals: () => intervalCount,
    run: () => vm.runInContext(SRC, context, { filename: 'hooks.js' }),
  };
}

/**
 * 造一个合法的 MP4 box：4 字节大端 size + 4 字节 type + payload。
 * 剥离逻辑只看 box 头部，所以 payload 全填 0 就够。
 */
function box(type, payloadLen = 0) {
  const size = 8 + payloadLen;
  const b = new Uint8Array(size);
  b[0] = (size >>> 24) & 0xff;
  b[1] = (size >>> 16) & 0xff;
  b[2] = (size >>> 8) & 0xff;
  b[3] = size & 0xff;
  for (let i = 0; i < 4; i += 1) b[4 + i] = type.charCodeAt(i);
  return b;
}

function concatBytes(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

/** 数一段字节里出现了几个指定类型的顶层 box。 */
function countBox(u8, type) {
  let off = 0;
  let n = 0;
  while (off + 8 <= u8.length) {
    const size = ((u8[off] << 24) | (u8[off + 1] << 16)
      | (u8[off + 2] << 8) | u8[off + 3]) >>> 0;
    const t = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    if (size < 8) break;
    if (t === type) n += 1;
    if (size === 0) break;
    off += size;
  }
  return n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 用例 1
{
  const env = makeEnv();
  env.run();
  check('首次注入后打上 __mgHooksInstalled', env.context.__mgHooksInstalled === true);
  check('首次注入装上了 flush 心跳（1 个 interval）', env.intervals() === 1,
    `intervals=${env.intervals()}`);
}

// ---------------------------------------------------------------- 用例 2
{
  const env = makeEnv();
  env.run();
  await sleep(30);
  check('flush 写出 mgHook=on', env.dataset.mgHook === 'on', `mgHook=${env.dataset.mgHook}`);

  // 模拟播放器 append 两段，共 100 + 200 = 300 字节
  const ms = new (env.context.MediaSource)();
  const hooked = ms.addSourceBuffer('video/mp4; codecs="avc1"');
  hooked.appendBuffer(new Uint8Array(100));
  hooked.appendBuffer(new Uint8Array(200));

  await sleep(300);
  check('appendBuffer 累计字节写进 dataset.mgMse', env.dataset.mgMse === '300',
    `mgMse=${env.dataset.mgMse}`);
}

// ---------------------------------------------------------------- 用例 3
{
  const env = makeEnv();
  env.run();

  // 二次注入（content.js 的补装路径）：必须整份 no-op
  env.run();
  env.run();
  check('二次注入不再新增心跳 interval', env.intervals() === 1,
    `intervals=${env.intervals()}`);

  const ms = new (env.context.MediaSource)();
  const hooked = ms.addSourceBuffer('video/mp4');
  hooked.appendBuffer(new Uint8Array(1024));
  await sleep(300);
  check('二次注入后捕获仍然工作', env.dataset.mgMse === '1024',
    `mgMse=${env.dataset.mgMse}`);
  check('二次注入后捕获没有被重置为 0', env.dataset.mgMse !== '0');
}

// ---------------------------------------------------------------- 用例 4
{
  const env = makeEnv();
  env.run();

  const ms = new (env.context.MediaSource)();
  const hooked = ms.addSourceBuffer('video/mp4');
  hooked.appendBuffer(new Uint8Array(4096));
  await sleep(300);

  let reply = null;
  env.context.document.addEventListener('__mg_assemble_done', (ev) => {
    reply = JSON.parse(ev.detail);
  });
  env.context.document.dispatchEvent(
    new (env.context.CustomEvent)('__mg_assemble', {
      detail: JSON.stringify({ filename: 'telegram_test.mp4' }),
    })
  );

  check('导出返回 ok', reply && reply.ok === true, JSON.stringify(reply));
  check('导出字节数正确', reply && reply.size === 4096, `size=${reply && reply.size}`);
  check('导出 mime 正确', reply && reply.mime === 'video/mp4', `mime=${reply && reply.mime}`);
  check('触发了 <a download> 且文件名正确',
    env.clicked.length === 1 && env.clicked[0].download === 'telegram_test.mp4',
    JSON.stringify(env.clicked));
  check('dataset.mgLastExport 落盘', typeof env.dataset.mgLastExport === 'string',
    env.dataset.mgLastExport);
}

// ---------------------------------------------------------------- 用例 5
{
  const env = makeEnv();
  env.run();

  let reply = null;
  env.context.document.addEventListener('__mg_assemble_done', (ev) => {
    reply = JSON.parse(ev.detail);
  });
  // 没有任何 append，直接导出 → 必须优雅失败，不能抛
  env.context.document.dispatchEvent(
    new (env.context.CustomEvent)('__mg_assemble', { detail: '{}' })
  );
  check('无数据时导出返回 ok:false 而非抛错', reply && reply.ok === false,
    JSON.stringify(reply));
}

// ---------------------------------------------------------------- 用例 6
{
  const env = makeEnv();
  env.run();

  const ms = new (env.context.MediaSource)();
  const v = ms.addSourceBuffer('video/mp4');
  const a = ms.addSourceBuffer('audio/mp4');
  v.appendBuffer(new Uint8Array(5000));
  a.appendBuffer(new Uint8Array(900));
  await sleep(300);

  check('多轨时 mgMse 取最大轨（5000）', env.dataset.mgMse === '5000',
    `mgMse=${env.dataset.mgMse}`);

  let reply = null;
  env.context.document.addEventListener('__mg_assemble_done', (ev) => {
    reply = JSON.parse(ev.detail);
  });
  env.context.document.dispatchEvent(
    new (env.context.CustomEvent)('__mg_assemble', { detail: JSON.stringify({ filename: 'x.mp4' }) })
  );
  check('多轨时导出最大轨 + 报告轨道数',
    reply && reply.ok && reply.size === 5000 && reply.tracks.length === 2,
    JSON.stringify(reply));
}

// ---------------------------------------------------------------- 用例 7
//
// 抄 loki-zhou/twitter_video_down 的 `string_value` 分支：X 会把媒体元数据
// 塞进一个「字符串化的 JSON」字段里，不 JSON.parse 就永远看不到 video_info。
// 这条路径在移植时最容易漏——因为对象结构看着完全正常，只是多包了一层字符串。
{
  const env = makeEnv();
  env.run();
  await sleep(30);

  const inner = {
    media_entities: {
      1234567890: {
        type: 'video',
        video_info: {
          variants: [
            { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/amplify_video/123/vid/avc1/640x360/low.mp4' },
            { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/amplify_video/123/vid/avc1/1280x720/high.mp4' },
            { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/amplify_video/123/pl/abc.m3u8' },
          ],
        },
      },
    },
  };
  // 外层是普通 JSON，内层 metadata 被 JSON.stringify 成了字符串 —— 这就是真实形态。
  const payload = { data: { entry: { string_value: JSON.stringify(inner) } } };

  const xhr = new (env.context.XMLHttpRequest)();
  xhr.open('GET', 'https://x.com/i/api/graphql/abc123/TweetDetail');
  xhr.responseText = JSON.stringify(payload);
  xhr.fire('load');

  await sleep(300);
  const videos = (env.dataset.mgVideos || '').split('|').filter(Boolean);
  check('string_value 里的 JSON 被解析出视频',
    videos.some((u) => u.includes('1280x720/high.mp4')), JSON.stringify(videos));
  check('多码率候选全部收下（交给 pickDirect 按画质挑，不是缺陷）',
    videos.length >= 2, JSON.stringify(videos));
  check('m3u8 不被选入',
    !videos.some((u) => u.includes('m3u8')), JSON.stringify(videos));
}

// ---------------------------------------------------------------- 用例 8
//
// 抄 xifangczy/cat-catch 的 endOfStream 代理：用来判断手上的缓存是完整文件
// 还是只播了一小段。
{
  const env = makeEnv();
  env.run();
  await sleep(30);

  const ms = new (env.context.MediaSource)();
  ms.endOfStream();
  await sleep(300);
  check('endOfStream 次数写进 dataset.mgEos', env.dataset.mgEos === '1',
    `mgEos=${env.dataset.mgEos}`);
}

// ---------------------------------------------------------------- 用例 9
//
// 「导出的不是我在看的那条」。
//
// 实测现场：Telegram 页面上同时有 12 个 <video>（媒体查看器里的正片 + 聊天里
// 一堆表情/头像小视频），旧实现取"字节最多的那条 SourceBuffer"，于是在字节数
// 上表情反而可能赢 —— 用户拿到一个能播几秒的文件，真正要的 500MB 缓存还在旁边。
//
// 新逻辑：MediaSource → createObjectURL → <video>.src 建立关联，按**元素在版面上
// 的占位面积**选轨。这一条就用"字节更少的正片 vs 字节更多的表情"来钉住它。
{
  const env = makeEnv();
  env.run();
  await sleep(30);

  // 正片：媒体查看器里的大画面（占位面积大、分辨率高、时长 523s）
  const mainMs = new (env.context.MediaSource)();
  const mainUrl = env.context.URL.createObjectURL(mainMs);
  env.addVideo({ src: mainUrl, w: 720, h: 1280, duration: 523.32, buffered: 5, layout: 480 * 853 });
  const mainSb = mainMs.addSourceBuffer('video/mp4');
  mainSb.appendBuffer(new Uint8Array(1000));

  // 表情：聊天里的小视频（占位面积小、但字节更多）
  const stickerMs = new (env.context.MediaSource)();
  const stickerUrl = env.context.URL.createObjectURL(stickerMs);
  env.addVideo({ src: stickerUrl, w: 100, h: 100, duration: 1.9, buffered: 1.9, layout: 60 * 60 });
  const stickerSb = stickerMs.addSourceBuffer('video/mp4');
  stickerSb.appendBuffer(new Uint8Array(999999));

  await sleep(300);

  check('多轨时 mgMse 仍是最大轨字节数（兼容旧读数）', env.dataset.mgMse === '999999',
    `mgMse=${env.dataset.mgMse}`);
  check('每条轨的画像写进 dataset.mgMseTracks',
    typeof env.dataset.mgMseTracks === 'string'
    && JSON.parse(env.dataset.mgMseTracks).length === 2,
    env.dataset.mgMseTracks);

  let reply = null;
  env.context.document.addEventListener('__mg_assemble_done', (ev) => {
    reply = JSON.parse(ev.detail);
  });
  env.context.document.dispatchEvent(
    new (env.context.CustomEvent)('__mg_assemble', {
      detail: JSON.stringify({ filename: 'main.mp4' }),
    })
  );

  check('导出的是"版面上最大的那条"（正片），不是字节最多的表情',
    reply && reply.ok && reply.size === 1000, JSON.stringify(reply && reply.size));
  check('回传了选中轨的片长（可据此自证截断）',
    reply && reply.picked && reply.picked.duration === 523.32,
    JSON.stringify(reply && reply.picked));
  check('回传了每条轨的字节数，便于诊断',
    reply && reply.tracks && reply.tracks.length === 2
    && reply.tracks.some((t) => t.bytes === 999999),
    JSON.stringify(reply && reply.tracks));
}

// ---------------------------------------------------------------- 用例 10
//
// 可以显式指定导哪条轨（给以后的"选另一条流"留的口子，也是防止选轨逻辑
// 悄悄失效时唯一能绕开的旋钮）。
{
  const env = makeEnv();
  env.run();
  await sleep(30);

  const a = new (env.context.MediaSource)();
  const aUrl = env.context.URL.createObjectURL(a);
  env.addVideo({ src: aUrl, w: 720, h: 1280, duration: 523.32, buffered: 5, layout: 400000 });
  a.addSourceBuffer('video/mp4').appendBuffer(new Uint8Array(1000));

  const b = new (env.context.MediaSource)();
  const bUrl = env.context.URL.createObjectURL(b);
  env.addVideo({ src: bUrl, w: 100, h: 100, duration: 1.9, buffered: 1.9, layout: 3600 });
  b.addSourceBuffer('video/mp4').appendBuffer(new Uint8Array(999999));
  await sleep(300);

  let reply = null;
  env.context.document.addEventListener('__mg_assemble_done', (ev) => {
    reply = JSON.parse(ev.detail);
  });
  env.context.document.dispatchEvent(
    new (env.context.CustomEvent)('__mg_assemble', {
      detail: JSON.stringify({ filename: 'sticker.mp4', trackIndex: 1 }),
    })
  );
  check('显式 trackIndex 生效', reply && reply.ok && reply.size === 999999,
    JSON.stringify(reply && reply.size));
}

// ---------------------------------------------------------------- 用例 11
//
// 关联不上任何 <video> 时必须退回旧行为（按字节最多），不能崩、也不能导出空。
// 这条兜住的场景：视频已被移除、或站点在 worker 里建 MediaSource 导致拿不到关联。
{
  const env = makeEnv();
  env.run();
  await sleep(30);

  const ms = new (env.context.MediaSource)();
  env.context.URL.createObjectURL(ms);            // 没有对应的 <video>
  ms.addSourceBuffer('video/mp4').appendBuffer(new Uint8Array(4096));
  await sleep(300);

  let reply = null;
  env.context.document.addEventListener('__mg_assemble_done', (ev) => {
    reply = JSON.parse(ev.detail);
  });
  env.context.document.dispatchEvent(
    new (env.context.CustomEvent)('__mg_assemble', { detail: '{}' })
  );
  check('无关联元素时退回按字节最多', reply && reply.ok && reply.size === 4096,
    JSON.stringify(reply && reply.size));
}

// ---------------------------------------------------------------- 用例 12
//
// 「80MB 的文件只播前 5 秒」。
//
// 实测现场：缓存导出的文件有 80 多 MB，播放器却只认前 5 秒（5 秒 ≈ 单个 HLS
// 分片的时长）。根因是 exportAssembly 早期把 appendBuffer 的入参按调用顺序直接
// `new Blob(chunks)` —— 播放器在分片切换 / 重建 SourceBuffer 时会把初始化段
// （ftyp + moov）**再 append 一遍**，拼出来的文件里于是有多个 moov；播放器只认
// 第一个，后面的字节一个都到不了。
//
// 这条用例构造的就是这个形态：init + seg + init + seg。
{
  const env = makeEnv();
  env.run();
  await sleep(30);

  const init = concatBytes(box('ftyp', 16), box('moov', 100));
  const seg = concatBytes(box('moof', 8), box('mdat', 200));
  const withInit = concatBytes(init, seg);

  const ms = new (env.context.MediaSource)();
  const sb = ms.addSourceBuffer('video/mp4');
  sb.appendBuffer(withInit);   // 第 1 段：ftyp + moov + moof + mdat
  sb.appendBuffer(seg);        // 后续分片：只有 moof + mdat
  sb.appendBuffer(withInit);   // ⚠️ 播放器又把初始化段发了一遍
  sb.appendBuffer(seg);
  await sleep(300);

  let reply = null;
  env.context.document.addEventListener('__mg_assemble_done', (ev) => {
    reply = JSON.parse(ev.detail);
  });
  env.context.document.dispatchEvent(
    new (env.context.CustomEvent)('__mg_assemble', { detail: '{}' })
  );

  const rawTotal = withInit.length * 2 + seg.length * 2;

  check('体检认出 2 个初始化段（ftyp）',
    reply && reply.boxInfo && reply.boxInfo.initCount === 2,
    JSON.stringify(reply && reply.boxInfo));
  check('剥离了 1 个重复初始化段',
    reply && reply.strip && reply.strip.dropped === 1,
    JSON.stringify(reply && reply.strip));
  check('导出字节 = 全部字节 − 被剥离的初始化段',
    reply && reply.ok && reply.size === rawTotal - init.length,
    `size=${reply && reply.size} 期望=${rawTotal - init.length}`);

  // 逐字节核对：导出结果必须以 ftyp 开头、且**只含一个** ftyp/moov。
  // 这才是"播放器能读完整个文件"的机械保证 —— 只看 size 看不出来。
  const out = new Uint8Array(await env.madeBlobs[0].arrayBuffer());
  check('导出结果只剩一个 ftyp', countBox(out, 'ftyp') === 1,
    `ftyp=${countBox(out, 'ftyp')}`);
  check('导出结果只剩一个 moov', countBox(out, 'moov') === 1,
    `moov=${countBox(out, 'moov')}`);
  check('媒体分片一个不少（moof / mdat 各 4 个）',
    countBox(out, 'moof') === 4 && countBox(out, 'mdat') === 4,
    `moof=${countBox(out, 'moof')} mdat=${countBox(out, 'mdat')}`);
}

// ---------------------------------------------------------------- 用例 13
//
// 只有一个初始化段时**一个字节都不能动**。剥离是启发式的，过度删除会让整条流
// 失去解码参数 —— 那比"多留一个 init"严重得多。
{
  const env = makeEnv();
  env.run();
  await sleep(30);

  const init = concatBytes(box('ftyp', 16), box('moov', 100));
  const seg = concatBytes(box('moof', 8), box('mdat', 200));

  const ms = new (env.context.MediaSource)();
  const sb = ms.addSourceBuffer('video/mp4');
  sb.appendBuffer(concatBytes(init, seg));
  sb.appendBuffer(seg);
  sb.appendBuffer(seg);
  await sleep(300);

  let reply = null;
  env.context.document.addEventListener('__mg_assemble_done', (ev) => {
    reply = JSON.parse(ev.detail);
  });
  env.context.document.dispatchEvent(
    new (env.context.CustomEvent)('__mg_assemble', { detail: '{}' })
  );

  const raw = init.length + seg.length * 3;
  check('单一初始化段：剥零个',
    reply && reply.strip && reply.strip.dropped === 0,
    JSON.stringify(reply && reply.strip));
  check('单一初始化段：字节数完全不变', reply && reply.size === raw,
    `size=${reply && reply.size} 期望=${raw}`);
}

// ---------------------------------------------------------------- 用例 14
//
// 不是 fMP4（MPEG-TS 分片，包以 0x47 同步字节开头）时，box 解析必然失败，
// 这时**不能做任何去重**，只把"非 box 分片"计入诊断。
{
  const env = makeEnv();
  env.run();
  await sleep(30);

  const ts = new Uint8Array(188 * 3);
  ts[0] = 0x47;
  ts[188] = 0x47;
  ts[376] = 0x47;

  const ms = new (env.context.MediaSource)();
  const sb = ms.addSourceBuffer('video/mp2t');
  sb.appendBuffer(ts);
  sb.appendBuffer(ts);
  await sleep(300);

  let reply = null;
  env.context.document.addEventListener('__mg_assemble_done', (ev) => {
    reply = JSON.parse(ev.detail);
  });
  env.context.document.dispatchEvent(
    new (env.context.CustomEvent)('__mg_assemble', { detail: '{}' })
  );

  check('TS 分片：识别为非 box 结构，不误判成 init',
    reply && reply.boxInfo && reply.boxInfo.nonBox === 2
    && reply.boxInfo.initCount === 0,
    JSON.stringify(reply && reply.boxInfo));
  check('TS 分片：原样导出，不做去重',
    reply && reply.ok && reply.size === ts.length * 2
    && reply.strip && reply.strip.dropped === 0,
    `size=${reply && reply.size} 期望=${ts.length * 2}`);
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
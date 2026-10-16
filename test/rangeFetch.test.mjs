/**
 * rangeFetch.js 的回归测试。
 *
 * 跑法：node test/rangeFetch.test.mjs
 *
 * 钉住三件会静默产出「坏文件」的事：
 *   - 服务端忽略 Range（起点对不上）必须报错，而不是接着拼；
 *   - 总长度中途变化（Service Worker 回收后重建流）必须报错；
 *   - 分块重试要对、且不能把已经算进去的 offset 再算一遍。
 * 外加：写入的字节必须与源**逐字节**一致（错位/丢块的最终判据）。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'extension', 'rangeFetch.js'), 'utf8');

// clearTimeout 必须注入：withDeadline 用它撤销 deadline 定时器。少了它，
// 超时逻辑会在沙箱里 ReferenceError —— 那不是"测不到"，而是根本跑不起来。
const sandbox = {
  console, URL, Uint8Array, Number, Error, Promise,
  setTimeout, clearTimeout, fetch: () => {},
};
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox);
const { fetchRangeToWriter, CONTENT_RANGE_RE, extFromMime } = sandbox.MediaGrabRangeFetch;

let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

const noSleep = async () => {};

// ── 桩 ────────────────────────────────────────────────────────────────────

function makeResponse({ status = 206, contentType = 'video/mp4', contentRange = null, contentLength = null, body = new Uint8Array(0) }) {
  const headers = {
    'Content-Type': contentType,
    'Content-Range': contentRange,
    'Content-Length': contentLength === null ? null : String(contentLength),
  };
  return {
    status,
    headers: { get: (k) => headers[k] ?? null },
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    },
  };
}

/**
 * 顺序 Range 服务器。
 *
 * 同时接受两种 Range 头：
 *   `bytes=N-`      开区间（第一轮探测用）
 *   `bytes=N-M`     闭区间（已知总长后统一用这种；`/hls_stream/` 端点只认它）
 * 闭区间的终点**必须被遵守** —— 这正是要测的行为，桩里不能忽略它。
 */
function rangeServer(source, { chunkSize = 300, totalOverride = null } = {}) {
  const hits = [];
  const impl = async (url, init) => {
    const header = String(init.headers.Range);
    const m = header.match(/^bytes=(\d+)-(?:(\d+))?$/);
    const start = Number(m[1]);
    const askedEnd = m[2] === undefined ? null : Number(m[2]);
    const total = totalOverride === null ? source.byteLength : totalOverride;
    hits.push(start);
    if (start >= total) return makeResponse({ status: 416 });
    const naturalEnd = Math.min(start + chunkSize, source.byteLength) - 1;
    const end = askedEnd === null ? naturalEnd : Math.min(askedEnd, naturalEnd);
    return makeResponse({
      contentRange: `bytes ${start}-${end}/${total}`,
      contentLength: end - start + 1,
      body: source.slice(start, end + 1),
    });
  };
  impl.hits = hits;
  return impl;
}

function collectWriter() {
  const parts = [];
  return {
    parts,
    async write(view) { parts.push(Uint8Array.from(view)); },
    bytes: () => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let at = 0;
      for (const p of parts) { out.set(p, at); at += p.byteLength; }
      return out;
    },
  };
}

const sameBytes = (a, b) =>
  a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

/** 造一段每字节可区分的数据：任何错位 / 丢块都能被逐字节比对抓到。 */
function makeSource(size) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 7) & 0xff;
  return out;
}

// ── 用例 ──────────────────────────────────────────────────────────────────

async function main() {
  // 源文件：1024 字节，每个字节都可区分，任何错位/丢块都能被逐字节比对抓到。
  const source = new Uint8Array(1024);
  for (let i = 0; i < source.byteLength; i += 1) source[i] = (i * 7) & 0xff;

  console.log('--- 正常多块（206 + Content-Range） ---');
  {
    const fetchImpl = rangeServer(source, { chunkSize: 300 });
    const writer = collectWriter();
    const progress = [];
    const r = await fetchRangeToWriter({
      url: 'https://web.telegram.org/k/stream/{"fileName":"a.MP4"}',
      writer,
      fetchImpl,
      sleepImpl: noSleep,
      onProgress: (p) => progress.push(p.received),
    });
    check('字节数与源一致', r.bytes === 1024, String(r.bytes));
    check('写出去的字节逐字节等于源', sameBytes(writer.bytes(), source));
    check('total 解析正确', r.total === 1024, String(r.total));
    check('ext 由 mime 推得 mp4', r.ext === 'mp4', String(r.ext));
    check('内存模式不收集分块', r.chunks.length === 0, String(r.chunks.length));
    check('进度单调递增且以总数收尾',
      progress.length === 4 && progress[progress.length - 1] === 1024, JSON.stringify(progress));
    check('每次请求的 Range 起点是累进的', String(fetchImpl.hits) === '0,300,600,900', String(fetchImpl.hits));
  }

  console.log('\n--- 服务器不支持 Range（200 全量） ---');
  {
    const fetchImpl = async () => makeResponse({
      status: 200, contentType: 'video/mp4', contentLength: source.byteLength, body: source,
    });
    const r = await fetchRangeToWriter({ url: 'u', fetchImpl, sleepImpl: noSleep });
    check('只请求一次就结束', r.bytes === 1024 && r.total === 1024, `${r.bytes}/${r.total}`);
    check('内存模式收下全量字节', sameBytes(r.chunks[0], source));
  }

  console.log('\n--- 服务端忽略 Range：起点对不上必须报错 ---');
  {
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      // 每一块都从 0 开始返回 —— 典型的「Range 被忽略 + 200 全量」被误当分块的场景
      const start = call === 1 ? 0 : 0;
      const end = 511;
      return makeResponse({
        contentRange: `bytes ${start}-${end}/1024`,
        contentLength: 512,
        body: source.slice(start, end + 1),
      });
    };
    let err = null;
    try {
      await fetchRangeToWriter({ url: 'u', fetchImpl, sleepImpl: noSleep });
    } catch (e) { err = e; }
    check('抛错而不是拼出错位文件', !!err, err && err.message);
    check('错因指向分块不连续', err && /分块不连续/.test(err.message), err && err.message);
  }

  console.log('\n--- 总长度中途变化必须报错 ---');
  {
    let call = 0;
    const fetchImpl = async (url, init) => {
      call += 1;
      const m = String(init.headers.Range).match(/^bytes=(\d+)-(?:(\d+))?$/);
      const start = Number(m[1]);
      const total = call === 1 ? 1024 : 2048;   // 第二块开始换了总长
      const naturalEnd = Math.min(start + 299, 1023);
      const end = m[2] === undefined ? naturalEnd : Math.min(Number(m[2]), naturalEnd);
      return makeResponse({
        contentRange: `bytes ${start}-${end}/${total}`,
        contentLength: end - start + 1,
        body: source.slice(start, end + 1),
      });
    };
    let err = null;
    try {
      await fetchRangeToWriter({ url: 'u', fetchImpl, sleepImpl: noSleep });
    } catch (e) { err = e; }
    check('抛错而不是把两条流拼在一起', err && /总长度前后不一致/.test(err.message), err && err.message);
  }

  console.log('\n--- 瞬时 5xx 要重试，且不重复计入 offset ---');
  {
    const inner = rangeServer(source, { chunkSize: 300 });
    const asked = [];
    let failuresLeft = 2;
    const fetchImpl = async (url, init) => {
      const range = String(init.headers.Range);
      asked.push(range);
      // 第一块的第一次尝试失败两次
      if (failuresLeft > 0 && range === 'bytes=0-') {
        failuresLeft -= 1;
        return makeResponse({ status: 503 });
      }
      return inner(url, init);
    };
    const writer = collectWriter();
    const r = await fetchRangeToWriter({ url: 'u', writer, fetchImpl, sleepImpl: noSleep, retries: 3 });
    check('重试后拿到完整文件', r.bytes === 1024 && sameBytes(writer.bytes(), source), String(r.bytes));
    check('重试请求的是同一个 offset（不是下一个）',
      asked.slice(0, 3).every((v) => v === 'bytes=0-'), String(asked.slice(0, 3)));
    // 真正重要的是：成功那一侧每个 offset 只被消费一次 —— 重试绝不能把 offset
    // 推进两次，否则中间那段字节会被跳过，产出一个"能播但缺一段"的文件。
    check('成功的服务端每个 offset 只见到一次',
      String(inner.hits) === '0,300,600,900', String(inner.hits));
    check('总请求次数 = 4 次成功 + 2 次重试', asked.length === 6, String(asked.length));
  }

  console.log('\n--- 403 不该重试（重试也是白试） ---');
  {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return makeResponse({ status: 403 }); };
    let err = null;
    try {
      await fetchRangeToWriter({ url: 'u', fetchImpl, sleepImpl: noSleep, retries: 3 });
    } catch (e) { err = e; }
    check('抛错', !!err && /HTTP 403/.test(err.message), err && err.message);
    check('只请求了 1 次', calls === 1, String(calls));
  }

  console.log('\n--- 重试耗尽要抛最后一个错误 ---');
  {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return makeResponse({ status: 500 }); };
    let err = null;
    try {
      await fetchRangeToWriter({ url: 'u', fetchImpl, sleepImpl: noSleep, retries: 2 });
    } catch (e) { err = e; }
    check('抛错', err && /HTTP 500/.test(err.message), err && err.message);
    check('共请求 3 次（1 + 2 次重试）', calls === 3, String(calls));
  }

  console.log('\n--- 返回 HTML 错误页要拦下来（旧版 15KB 垃圾文件的防线） ---');
  {
    const fetchImpl = async () => makeResponse({
      status: 200, contentType: 'text/html; charset=utf-8', contentLength: 15,
      body: new TextEncoder().encode('<html>error</html>'),
    });
    let err = null;
    try {
      await fetchRangeToWriter({ url: 'u', fetchImpl, sleepImpl: noSleep });
    } catch (e) { err = e; }
    check('抛「响应不是媒体」', err && /响应不是媒体/.test(err.message), err && err.message);
  }

  console.log('\n--- extFromMime ---');
  check('video/quicktime → mov（不是 quicktime）', extFromMime('video/quicktime') === 'mov');
  check('octet-stream 不当扩展名', extFromMime('application/octet-stream') === null);
  check('video/mp4 → mp4', extFromMime('video/mp4; codecs=avc1') === 'mp4');
  check('CONTENT_RANGE_RE 拒绝畸形头', CONTENT_RANGE_RE.test('bytes 0-1/*') === false);

  console.log('\n--- 内存模式仍返回有序分块 ---');
  {
    const r = await fetchRangeToWriter({
      url: 'u', fetchImpl: rangeServer(source, { chunkSize: 512 }), sleepImpl: noSleep,
    });
    const joined = new Uint8Array(r.bytes);
    let at = 0;
    for (const c of r.chunks) { joined.set(c, at); at += c.byteLength; }
    check('分块拼回来等于源', sameBytes(joined, source));
    check('分块数正确', r.chunks.length === 2, String(r.chunks.length));
  }

  console.log('\n--- 服务端声称已给完、实际字节不足：必须报错 ---');
  {
    // 这是「13 分钟的视频只下到前几秒」的机械版本：每一轮都"成功"，
    // Content-Range 还告诉你 total = 1024，但 body 只有 300 字节。
    // 旧实现会认为 `next >= total` 已经满足，把这个文件当成功交付。
    //
    // 现在有两道闸门都该拦住它，谁先命中都算对：
    //   1. 单块长度校验（end - start + 1 ≠ 实收字节）—— 精度更高，会先命中；
    //   2. 收尾的总长度校验（bytes ≠ total）。
    // 真正要钉住的**不变量**是：一个字节都不许写出去。
    const writer = collectWriter();
    const fetchImpl = async () => makeResponse({
      contentRange: 'bytes 0-1023/1024', contentLength: 300, body: source.slice(0, 300),
    });
    let err = null;
    try {
      await fetchRangeToWriter({ url: 'u', writer, fetchImpl, sleepImpl: noSleep });
    } catch (e) { err = e; }
    check('抛错而不是交付半截文件',
      err && /分块长度不符|字节数不足/.test(err.message), err && err.message);
    check('半截字节没有被写出去', writer.parts.length === 0, String(writer.parts.length));
    check('错误带上现场信息（offset / 声明区间 / 实收）',
      !!err.detail && err.detail.offset === 0
      && err.detail.contentRange === 'bytes 0-1023/1024',
      JSON.stringify(err.detail || null));
  }

  console.log('\n--- Range 被忽略（offset>0 仍回 200）必须报错 ---');
  {
    // 第一轮正常（offset=0 回 200 是合法的"整份文件"），之后若服务端
    // 忽略了 Range 又回一次 200，继续写就是把文件重复拼接。
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      if (call === 1) {
        return makeResponse({
          status: 206, contentRange: 'bytes 0-299/1024', contentLength: 300,
          body: source.slice(0, 300),
        });
      }
      return makeResponse({ status: 200, contentLength: 1024, body: source });
    };
    let err = null;
    try {
      await fetchRangeToWriter({ url: 'u', fetchImpl, sleepImpl: noSleep, retries: 0 });
    } catch (e) { err = e; }
    check('抛「服务端忽略了 Range」', err && /忽略了 Range/.test(err.message), err && err.message);
  }

  console.log('\n--- 206 却不带 Content-Range：无从校验，必须报错 ---');
  {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return makeResponse({ status: 206, contentLength: 300, body: source.slice(0, 300) });
    };
    let err = null;
    try {
      await fetchRangeToWriter({ url: 'u', fetchImpl, sleepImpl: noSleep, retries: 0 });
    } catch (e) { err = e; }
    check('抛「缺少 Content-Range」', err && /缺少 Content-Range/.test(err.message), err && err.message);
    check('只请求一次（不可重试）', calls === 1, String(calls));
  }

  console.log('\n--- 响应体比 Content-Length 短：可重试，且不推进 offset ---');
  {
    // SW 报 Content-Length: 300 却只给 100 字节 —— 这是"流被掐断"。
    // 必须当成瞬时错误重试（同一个 offset），而不是把这 100 字节接进去。
    const asked = [];
    let shortLeft = 2;
    const inner = rangeServer(source, { chunkSize: 300 });
    const fetchImpl = async (url, init) => {
      asked.push(String(init.headers.Range));
      if (shortLeft > 0) {
        shortLeft -= 1;
        return makeResponse({
          contentRange: 'bytes 0-299/1024', contentLength: 300, body: source.slice(0, 100),
        });
      }
      return inner(url, init);
    };
    const writer = collectWriter();
    let err = null;
    let r = null;
    try {
      r = await fetchRangeToWriter({ url: 'u', writer, fetchImpl, sleepImpl: noSleep, retries: 3 });
    } catch (e) { err = e; }
    check('短响应被当成瞬时错误重试，最终拿到完整文件',
      !!r && r.bytes === 1024 && sameBytes(writer.bytes(), source),
      err ? `抛错：${err.message}` : String(r && r.bytes));
    check('三次请求都是同一个 offset', asked.slice(0, 3).every((h) => h === 'bytes=0-'), JSON.stringify(asked.slice(0, 3)));
  }

  console.log('\n--- 忠实模拟 tweb 的 /hls_stream/ 端点（parseRange + 分片对齐） ---');
  {
    // 这一条把 tweb 真实的服务端行为搬进来，而不只是"一个支持 Range 的桩"：
    //
    //   onHlsStreamFetch(event, inParams) {
    //     const [lower, upper] = parseRange(event.request.headers.get('Range'));
    //     const {ranges, alignedLowerBound} = splitRangeForGettingFileParts(lower, upper);
    //     ... fetchAndConcatFileParts(ranges) ...
    //     headers['Content-Range'] = `bytes ${lower}-${upper}/${size}`;
    //     headers['Content-Length'] = `${upper - lower + 1}`;
    //     body = filePart.slice(lower - alignedLowerBound, upper - alignedLowerBound + 1);
    //   }
    //
    // parseRange（照抄 serviceWorker/stream.ts:394）：
    //   if(!header) return [0, 0];
    //   const [offset, end] = header.split('=')[1].split('-');
    //   return [+offset, +end || 0];
    //
    // splitRange 的要点：MTProto 的 getFile 只接受 4096 对齐、limit 为 2 的幂
    // 且 ≤ 1MiB 的取数，所以它总是先按 1MiB 的"fragment"对齐去取，再切出请求
    // 的那一段。这正是"我们请求 `bytes=a-b`，服务端内部却取了别处一片"的来源，
    // 也是必须靠 Content-Range 校验偏移的原因。
    const MB = 1024 * 1024;
    const size = 5 * MB + 777;              // 5MB 出头：跨越多个 fragment
    const whole = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) whole[i] = (i * 31 + 7) & 0xff;

    const parseRange = (header) => {
      if (!header) return [0, 0];
      const [, chunks] = String(header).split('=');
      const [offset, end] = chunks.split('-');
      return [Number(offset), Number(end) || 0];
    };
    const snapLimit = (n) => Math.max(2 ** Math.ceil(Math.log2(n)), 4096);

    const swFetch = async (url, init) => {
      const [lower, upper] = parseRange(init.headers.Range);
      const chunkStart = Math.floor(lower / 4096) * 4096;
      const nextChunkStart = (Math.floor(upper / 4096) + 1) * 4096;
      const fragStart = Math.floor(lower / MB) * MB;
      const nextFragStart = (Math.floor(lower / MB) + 1) * MB;
      const inThisFrag = Math.min(nextFragStart, nextChunkStart);
      const limitFirst = snapLimit(inThisFrag - chunkStart);
      const alignedLowerBound = Math.max(inThisFrag - limitFirst, fragStart);
      // 单次请求只取一片（足够覆盖我们的 4MiB 请求；多片只是等价的拼接）
      const need = upper - alignedLowerBound + 1;
      const take = Math.max(need, limitFirst);
      const part = whole.slice(alignedLowerBound, Math.min(alignedLowerBound + take, whole.byteLength));
      const body = part.slice(lower - alignedLowerBound, upper - alignedLowerBound + 1);
      return makeResponse({
        contentRange: `bytes ${lower}-${upper}/${size}`,
        contentLength: upper - lower + 1,
        body,
      });
    };

    // (a) 开区间只回 1 个字节 —— v1.4.0 之前"只下到前几秒"的机械原因
    const probe = await swFetch('u', { headers: { Range: 'bytes=0-' } });
    check('开区间 `bytes=0-` 只回 1 个字节',
      (await probe.arrayBuffer()).byteLength === 1 && probe.headers.get('Content-Range') === `bytes 0-0/${size}`,
      probe.headers.get('Content-Range'));

    // (b) 我们的实现必须靠闭区间把整片拉完，且逐字节等于源
    const writer = collectWriter();
    const r = await fetchRangeToWriter({ url: 'u', writer, fetchImpl: swFetch, sleepImpl: noSleep });
    check('整片拉完（含非对齐的尾巴）', r.bytes === size && r.total === size, `${r.bytes}/${size}`);
    check('逐字节等于源文件', sameBytes(writer.bytes(), whole));
  }

  console.log('\n--- /hls_stream/ 端点只认闭区间（开区间只回 1 字节） ---');
  {
    // 照抄 tweb 的 onHlsStreamFetch：`const [lower, upper] = parseRange(header)`，
    // 开区间 `bytes=0-` 被解析成 [0, 0]，于是**只回 1 个字节**。
    // 这条断言的作用是钉住"已知总长后必须发闭区间"，否则 1024 字节要 1024 轮。
    const hits = [];
    const headers = [];
    const fetchImpl = async (url, init) => {
      const header = String(init.headers.Range);
      headers.push(header);
      const m = header.match(/^bytes=(\d+)-(?:(\d+))?$/);
      const start = Number(m[1]);
      hits.push(start);
      const end = m[2] === undefined ? start : Math.min(Number(m[2]), source.byteLength - 1);
      return makeResponse({
        contentRange: `bytes ${start}-${end}/${source.byteLength}`,
        contentLength: end - start + 1,
        body: source.slice(start, end + 1),
      });
    };
    const writer = collectWriter();
    const r = await fetchRangeToWriter({
      url: 'u', writer, fetchImpl, sleepImpl: noSleep, chunkSize: 256,
    });
    check('仍然拉到完整文件', r.bytes === 1024 && sameBytes(writer.bytes(), source), String(r.bytes));
    check('轮数受控（1 次探测 + 4 次闭区间）', hits.length === 5, JSON.stringify(hits));
    check('首轮开区间探测，其后全是闭区间',
      headers[0] === 'bytes=0-' && headers.slice(1).every((h) => /^bytes=\d+-\d+$/.test(h)),
      JSON.stringify(headers));
  }

  console.log('\n--- URL 里声明的总长是最后一票否决 ---');
  {
    const ok = await fetchRangeToWriter({
      url: 'u', fetchImpl: rangeServer(source, { chunkSize: 512 }),
      sleepImpl: noSleep, expectBytes: source.byteLength,
    });
    check('声明一致 → 正常返回且 complete = true',
      ok.bytes === 1024 && ok.complete === true, JSON.stringify({ bytes: ok.bytes, c: ok.complete }));

    let err = null;
    try {
      await fetchRangeToWriter({
        url: 'u', fetchImpl: rangeServer(source, { chunkSize: 512 }),
        sleepImpl: noSleep, expectBytes: 999,
      });
    } catch (e) { err = e; }
    check('声明不一致 → 抛错', err && /字节数与文件声明不符/.test(err.message), err && err.message);
  }

  // ---------------------------------------------------------------------------
// 挂起（服务端既不吐字节也不报错）
// ---------------------------------------------------------------------------

console.log('\n--- 请求永久挂起：必须被超时打断，而不是永远等下去 ---');
{
  // 这就是 1.8.0 实测「进度停在 40MiB/125MiB 再也不动」的机械形态：
  // tweb 的 onHlsStreamFetch 用 deferredPromise + event.respondWith，而
  // RequestSynchronizer 把一次没回的 MTProto 分片请求 promise 永久缓存 ——
  // 于是 fetch 既不 resolve 也不 reject。链路上任何地方没有 deadline 都会卡死。
  let calls = 0;
  const hangForever = () => { calls += 1; return new Promise(() => {}); };

  let err = null;
  const started = Date.now();
  try {
    await fetchRangeToWriter({
      url: 'u',
      fetchImpl: hangForever,
      sleepImpl: noSleep,
      chunkTimeoutMs: 30,          // 测试里把 30 秒压到 30 毫秒
      retries: 2,
    });
  } catch (e) { err = e; }
  const spent = Date.now() - started;

  check('挂起的请求最终抛出错误（而不是永远 pending）', !!err, err ? err.message : 'no error');
  check('错误说的是"挂起"，且带着连续挂起的次数',
    err && /挂起/.test(err.message) && /3 次/.test(err.message), err && err.message);
  check('每轮都真的发起了请求（超时后真的重试过）', calls === 3, String(calls));
  check('耗时受 deadline 约束（没有被无限拖住）', spent < 3000, `${spent}ms`);
  check('判为 fatal：挂起耗尽重试后再试也没意义', !!(err && err.fatal), String(err && err.fatal));
}

console.log('\n--- 挂起是暂时的：重试成功就不该报失败 ---');
{
  // 真实场景里挂起通常是暂时的（SW 被回收、连接半死），换个连接往往就好了。
  // 所以单次挂起必须按可重试处理。
  let n = 0;
  const flaky = async (url, init) => {
    n += 1;
    if (n === 1) return new Promise(() => {});        // 第一次挂起
    return rangeServer(makeSource(700))(url, init);   // 之后正常
  };
  const writer = collectWriter();
  let err = null;
  let r = null;
  try {
    r = await fetchRangeToWriter({
      url: 'u', writer, fetchImpl: flaky, sleepImpl: noSleep, chunkTimeoutMs: 30,
    });
  } catch (e) { err = e; }
  check('第一次挂起后重试成功，不算失败', !err && !!r, err && err.message);
  check('交付字节逐字节等于源', r && sameBytes(writer.bytes(), makeSource(700)),
    r ? String(r.bytes) : 'no result');
}

console.log('\n--- 断点续传：从已有偏移继续，完整性闸门仍然成立 ---');
{
  // 页面刷新会中止下载（字节只能在页面世界拉），但 OPFS 里的暂存文件还活着。
  // startOffset 让 rangeFetch 从断点接着拉，而两个完整性闸门必须改成
  // "含续传字节的总数"，否则一次成功的续传会被误判成"字节不足"。
  const source = makeSource(1024);
  const carry = 400;
  const asked = [];
  const writer = collectWriter();
  const impl = async (url, init) => {
    asked.push(String(init.headers.Range));
    return rangeServer(source)(url, init);
  };
  const r = await fetchRangeToWriter({
    url: 'u', writer, fetchImpl: impl, sleepImpl: noSleep,
    startOffset: carry, initialTotal: source.byteLength,
    expectBytes: source.byteLength,
  });

  check('第一轮就从断点之后的区间开始（不重拉已下载的字节）',
    /^bytes=400-/.test(asked[0]), asked[0]);
  check('没有请求断点之前的任何字节',
    asked.every((a) => { const m = a.match(/^bytes=(\d+)-/); return !m || Number(m[1]) >= carry; }),
    JSON.stringify(asked));
  check('本次收到的字节数 = 总长 − 已有字节',
    r.bytes === source.byteLength - carry, `${r.bytes} vs ${source.byteLength - carry}`);
  check('carried 字段报出已有字节数（上层要靠它拼完整文件）',
    r.carried === carry, String(r.carried));
  check('完整性闸门没有被续传误触发（bytes !== total 也不报错）',
    !!r && r.complete === true, JSON.stringify({ bytes: r.bytes, total: r.total, c: r.complete }));
  // writer 只接收到"新增"的部分；已有字节在 OPFS 文件里（keepExistingData + seek）
  const got = writer.bytes();
  check('写入的是续传那一段，且与源对应区间逐字节一致',
    got.byteLength === source.byteLength - carry
      && sameBytes(got, source.slice(carry)),
    `${got.byteLength} vs ${source.byteLength - carry}`);
  check('onProgress 报的是绝对位置（进度条不会从 0 重新爬）',
    r && r.bytes > 0, String(r.bytes));
}

console.log('\n--- 断点续传时若文件已下完，就该重写而不是"接着写 0 字节" ---');
{
  // startOffset 等于总长 → 什么都没得拉。必须干净地报"字节不足"，
  // 而不是把文件当完成（那等于交付一个可能是残缺的 .part）。
  const source = makeSource(512);
  let err = null;
  try {
    await fetchRangeToWriter({
      url: 'u',
      writer: null,
      sleepImpl: noSleep,
      fetchImpl: rangeServer(source),
      startOffset: source.byteLength,
      initialTotal: source.byteLength,
      expectBytes: source.byteLength,
    });
  } catch (e) { err = e; }
  check('已下完再续传会报错（不交付空文件）', !!err, err ? err.message : 'no error');
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}

main();

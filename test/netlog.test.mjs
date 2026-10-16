/**
 * background.js 的净日志（netLog）归属规则回归测试。
 *
 * 跑法：node test/netlog.test.mjs
 *
 * 为什么值得单独测：候选 URL 的来源只有两条路（本标签页的请求、以及按 origin
 * 归档的共享请求），而这两条路的边界一旦错，症状是**静默下错文件**——
 * v1.3.8 实测：在 X 下完视频，再去 Telegram 点下载，下到的还是 X 的视频。
 * 根因是共享桶把所有 tabId = -1 的请求（包含扩展自己发起的下载）无差别合并
 * 进每个标签页的候选池。
 *
 * 这里把 background.js 装进 vm，用 chrome 桩跑**真实的** onMessage 路由，
 * 断言的是「哪个页面能看到哪条 URL」。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import realTimers from 'node:timers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'extension', 'background.js'), 'utf8');

const X_VIDEO = 'https://video.twimg.com/amplify_video/2105/vid/avc1/720x1280/clip.mp4';
const TG_STREAM = 'https://web.telegram.org/k/stream/12345';
const ARIA_RPC = 'http://127.0.0.1:16800/jsonrpc';

let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

const sleep = (ms) => new Promise((r) => realTimers.setTimeout(r, ms));

/**
 * 起一个 background.js 实例。`store` 可跨实例复用 —— 那就是「service worker
 * 被回收后重新唤醒」的场景，恢复逻辑正是走 session storage 里那份快照。
 */
function boot(store) {
  const session = store.session;
  const timers = [];
  const listeners = {
    webRequest: [],
    downloads: [],
    tabsRemoved: [],
    alarms: [],
    message: [],
  };

  const chrome = {
    storage: {
      session: {
        async get(key) {
          if (typeof key === 'string') return { [key]: session[key] };
          return Object.assign({}, session);
        },
        async set(obj) { Object.assign(session, obj); },
      },
      sync: {
        async get(key) {
          if (typeof key === 'string') return { [key]: store.sync[key] };
          return Object.assign({}, store.sync);
        },
        async set(obj) { Object.assign(store.sync, obj); },
      },
    },
    webRequest: {
      onBeforeRequest: { addListener: (fn) => listeners.webRequest.push(fn) },
    },
    downloads: {
      onCreated: { addListener: (fn) => listeners.downloads.push(fn) },
      onChanged: { addListener: () => {} },
      async search() { return []; },
      async cancel() {},
      async download() { return 1; },
    },
    tabs: { onRemoved: { addListener: (fn) => listeners.tabsRemoved.push(fn) } },
    alarms: {
      onAlarm: { addListener: (fn) => listeners.alarms.push(fn) },
      async create() {},
      async clear() {},
      async get() { return null; },
    },
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      sendNativeMessage(host, payload, cb) { cb({ ok: false, error: 'test: no host' }); },
    },
    scripting: { async executeScript() { return [{}]; } },
    notifications: { create() {} },
    action: {
      badges: [],
      titles: [],
      async setBadgeText(o) { this.badges.push(o); },
      async setBadgeBackgroundColor() {},
      async setTitle(o) { this.titles.push(o); },
    },
  };

  const sandbox = {
    chrome,
    console: { info() {}, warn() {}, error() {}, log() {} },
    // flush 是 1s 防抖，测试里手动触发，不真等。
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    URL,
    Promise,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    Error,
  };

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'background.js' });

  const api = {
    sandbox,
    /** 触发 webRequest 事件。 */
    request(details) {
      for (const fn of listeners.webRequest) {
        fn(Object.assign({ tabId: -1, type: 'xmlhttprequest' }, details));
      }
    },
    download(item) {
      for (const fn of listeners.downloads) fn(item);
    },
    removed(tabId) {
      for (const fn of listeners.tabsRemoved) fn(tabId);
    },
    /** 手动跑掉挂起的 flush 定时器（并等它落盘）。 */
    async flush() {
      const pending = timers.splice(0, timers.length);
      for (const fn of pending) fn();
      await sleep(2);
    },
    /** 走真实的 onMessage 路由；sender 模拟 content script。 */
    ask(pageUrl, tabId, msg) {
      if (!listeners.message.length) throw new Error('onMessage 未注册');
      return new Promise((resolve) => {
        const keep = listeners.message[0](
          msg,
          { tab: { id: tabId }, url: pageUrl },
          resolve,
        );
        if (keep !== true) throw new Error('onMessage 没有保持通道打开');
      });
    },
    /** 某个页面能看到的候选 URL。 */
    async urlsOn(pageUrl, tabId) {
      const reply = await api.ask(pageUrl, tabId, { type: 'getNetLog' });
      if (!reply || reply.ok !== true) throw new Error('getNetLog 失败: ' + JSON.stringify(reply));
      return reply;
    },
  };
  return api;
}

const newStore = () => ({ session: {}, sync: {} });

// ---------------------------------------------------------------------------

async function main() {
  console.log('\n--- 1. 每个标签页只看到自己的请求 ---');
  {
    const env = boot(newStore());
    env.request({ tabId: 1, type: 'main_frame', url: 'https://x.com/home' });
    env.request({ tabId: 1, url: X_VIDEO, initiator: 'https://x.com' });

    const onX = await env.urlsOn('https://x.com/home', 1);
    check('X 页面看得到自己请求的视频', onX.urls.includes(X_VIDEO));
    check('来源标记为本页', onX.tabUrls === 1 && onX.sharedUrls === 0,
      `tabUrls=${onX.tabUrls} sharedUrls=${onX.sharedUrls}`);

    const onTg = await env.urlsOn('https://web.telegram.org/k/', 2);
    check('Telegram 页面看不到 X 的 URL（v1.3.8 的错就在这里）',
      !onTg.urls.includes(X_VIDEO), JSON.stringify(onTg.urls));
  }

  console.log('\n--- 2. 扩展自己发起的下载不属于任何页面 ---');
  {
    const env = boot(newStore());
    env.request({ tabId: 1, type: 'main_frame', url: 'https://x.com/home' });
    // chrome.downloads.download() 建的下载：tabId = -1。
    env.download({ url: X_VIDEO, tabId: -1 });

    const onX = await env.urlsOn('https://x.com/home', 1);
    const onTg = await env.urlsOn('https://web.telegram.org/k/', 2);
    check('不记进 X 页面的桶', !onX.urls.includes(X_VIDEO));
    check('不记进 Telegram 页面的桶', !onTg.urls.includes(X_VIDEO));

    // 页面自己发起的下载（tweb 的 ↓ 按钮、<a download>）仍然要记。
    env.download({ url: X_VIDEO, tabId: 1 });
    const onX2 = await env.urlsOn('https://x.com/home', 1);
    check('页面发起的下载照常记录', onX2.urls.includes(X_VIDEO));
  }

  console.log('\n--- 3. tabId = -1 的请求按发起方 origin 归档 ---');
  {
    const env = boot(newStore());
    // Telegram 的 service worker 代页面取流。
    env.request({ tabId: -1, url: TG_STREAM, initiator: 'https://web.telegram.org' });
    // 下载管理器的本地 RPC（另一个扩展的 worker 发的）。
    env.request({ tabId: -1, url: ARIA_RPC, initiator: 'chrome-extension://abcdefghijklmnop' });
    // X 的 SW 取媒体。
    env.request({ tabId: -1, url: X_VIDEO, initiator: 'https://x.com' });

    const onTg = await env.urlsOn('https://web.telegram.org/k/', 2);
    check('同源共享请求会合并进来', onTg.urls.includes(TG_STREAM));
    check('其它 origin 的共享请求不合并',
      !onTg.urls.includes(X_VIDEO) && !onTg.urls.includes(ARIA_RPC),
      JSON.stringify(onTg.urls));
    check('共享桶计数只算同源那一个', onTg.sharedUrls === 1, `sharedUrls=${onTg.sharedUrls}`);

    const onX = await env.urlsOn('https://x.com/home', 1);
    check('X 页面拿到自己 origin 的共享请求', onX.urls.includes(X_VIDEO));
    check('X 页面拿不到 Telegram 的', !onX.urls.includes(TG_STREAM));
  }

  console.log('\n--- 4. 认不出发起方的请求一律不给 ---');
  {
    const env = boot(newStore());
    env.request({ tabId: -1, url: ARIA_RPC });

    const onTg = await env.urlsOn('https://web.telegram.org/k/', 2);
    check('不参与任何合并', !onTg.urls.includes(ARIA_RPC));
    check('单独计数，方便排查', onTg.unscopedUrls === 1, `unscopedUrls=${onTg.unscopedUrls}`);
  }

  console.log('\n--- 5. 顶层导航作废旧日志 ---');
  {
    const env = boot(newStore());
    env.request({ tabId: 1, type: 'main_frame', url: 'https://x.com/home' });
    env.request({ tabId: 1, url: X_VIDEO });
    env.request({ tabId: 1, type: 'main_frame', url: 'https://web.telegram.org/k/' });
    env.request({ tabId: 1, url: TG_STREAM, initiator: 'https://web.telegram.org' });

    const after = await env.urlsOn('https://web.telegram.org/k/', 1);
    check('换站后旧 URL 不再出现', !after.urls.includes(X_VIDEO), JSON.stringify(after.urls));
    check('新页面的 URL 正常记录', after.urls.includes(TG_STREAM));
  }

  console.log('\n--- 6. SW 被回收后唤醒，不会把旧快照当成本页数据 ---');
  {
    const store = newStore();
    const first = boot(store);
    first.request({ tabId: 1, type: 'main_frame', url: 'https://x.com/home' });
    first.request({ tabId: 1, url: X_VIDEO });
    await first.flush();
    check('快照已落盘', !!(store.session.mgNetLogV1 || {}).buckets, '  ' + Object.keys((store.session.mgNetLogV1 || {}).buckets || {}).join(','));

    // SW 被回收，同一个标签页已经换到了 Telegram 且没有触发过我们的监听。
    const second = boot(store);
    const queries = await second.urlsOn('https://web.telegram.org/k/', 1);
    check('同标签页换站后旧快照被丢弃',
      !queries.urls.includes(X_VIDEO), JSON.stringify(queries.urls.slice(0, 3)));
    check('并标记出来，便于定位', queries.staleTab === true);

    // 但原站点回来时，快照仍然有效（否则重启就会丢捕捉）。
    const backOnX = await second.urlsOn('https://x.com/home', 1);
    check('原 origin 访问时快照仍可用', backOnX.urls.includes(X_VIDEO));
  }

  console.log('\n--- 7. 兜底：缺 tabId / 无法解析的 sender 不抛异常 ---');
  {
    const env = boot(newStore());
    const bare = await env.ask(undefined, undefined, { type: 'getNetLog' });
    check('没有 sender 时返回 ok', bare && bare.ok === true, JSON.stringify(bare));
    const empty = await env.ask('about:blank', 99, { type: 'getNetLog' });
    check('非 http(s) 页面同样不抛', empty && empty.ok === true && empty.urls.length === 0);
  }

  console.log('\n--- 8. 工具栏角标：视频页显示、离开清掉 ---');
  {
    const env = boot(newStore());

    const on = await env.ask('https://web.telegram.org/k/', 7, { type: 'badge', count: 1 });
    check('视频页上报后被点亮', on && on.ok === true && on.on === true, JSON.stringify(on));
    const last = env.sandbox.chrome.action.badges.at(-1);
    check('角标文字 = 1，且只作用于该标签页',
      last && last.text === '1' && last.tabId === 7, JSON.stringify(last));

    const off = await env.ask('https://web.telegram.org/k/', 7, { type: 'badge', count: 0 });
    check('没有视频时报 0 就清空', off && off.on === false, JSON.stringify(off));
    check('清空同样是该标签页的局部操作',
      env.sandbox.chrome.action.badges.at(-1).text === '',
      JSON.stringify(env.sandbox.chrome.action.badges.at(-1)));

    // 顶层导航会先把角标清掉：新页面还没被识别过，留着旧页面的 1 会误导。
    env.request({ tabId: 7, type: 'main_frame', url: 'https://example.com/' });
    const afterNav = env.sandbox.chrome.action.badges.at(-1);
    check('顶层导航立即清角标',
      afterNav.text === '' && afterNav.tabId === 7, JSON.stringify(afterNav));

    const noTab = await env.ask('https://web.telegram.org/k/', undefined, { type: 'badge', count: 1 });
    check('拿不到 tabId 时跳过而不是全局点亮',
      noTab && noTab.ok === true && noTab.skipped === true, JSON.stringify(noTab));
  }

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(2);
});

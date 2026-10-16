/**
 * sites.js 的回归测试。
 *
 * 跑法：node test/sites.test.mjs
 *
 * 目的：钉住「登录 / 账号页不弹按钮」这条规则，以及它**不会**误伤正常视频站。
 * 触发原因很具体：微软「保持登录状态?」（KMSI）页中间那圈插画是个自动播放的
 * <video>，旧版 DOM 兜底把它当成可下载视频，按钮就飘在登录卡片上了。
 *
 * 这个文件只测纯字符串逻辑（detectFromUrl / isAuthHref），不碰 DOM ——
 * 之所以能这么测，是因为站点规则被刻意抽到了 sites.js 里。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'extension', 'sites.js'), 'utf8');

const sandbox = { console, URL };
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox);
const Sites = sandbox.MediaGrabSites;

let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

const kindOf = (href) => Sites.detectFromUrl(href).kind;

console.log('--- 登录 / 账号页必须安静 ---');
const AUTH_URLS = [
  'https://login.microsoftonline.com/common/kmsi',
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x',
  'https://login.partner.microsoftonline.cn/common/kmsi',
  'https://login.live.com/oauth20_authorize.srf',
  'https://accounts.google.com/v3/signin/identifier',
  'https://appleid.apple.com/auth/authorize',
  'https://example-corp.okta.com/oauth2/default',
  'https://acme.auth0.com/login',
  'https://weird-video-site.example.com/login',
  'https://weird-video-site.example.com/oauth2/authorize',
];
for (const href of AUTH_URLS) {
  check(`none  ${href}`, kindOf(href) === 'none', kindOf(href));
  check(`isAuthHref=true  ${href}`,
    Sites.isAuthHref(href) === true, String(Sites.isAuthHref(href)));
}

console.log('\n--- 正常视频站不能被误伤 ---');
const SITE_URLS = [
  ['https://x.com/someone/status/1234567890', 'site'],
  ['https://twitter.com/someone/status/1234567890', 'site'],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'site'],
  ['https://youtu.be/dQw4w9WgXcQ', 'site'],
  ['https://www.bilibili.com/video/BV1xx411c7mD', 'site'],
  ['https://www.instagram.com/reel/ABC123/', 'site'],
  ['https://www.tiktok.com/@user/video/7312345678901234567', 'site'],
];
for (const [href, want] of SITE_URLS) {
  check(`${want}  ${href}`, kindOf(href) === want, kindOf(href));
  check(`isAuthHref=false  ${href}`, Sites.isAuthHref(href) === false);
}

console.log('\n--- 直链媒体仍然要认 ---');
check('direct  https://cdn.example.com/a/clip.mp4',
  kindOf('https://cdn.example.com/a/clip.mp4') === 'direct');
// 媒体扩展名优先于 /login 路径规则：路径里有 login 不代表不能是媒体。
check('direct  https://cdn.example.com/login/clip.mp4（扩展名优先）',
  kindOf('https://cdn.example.com/login/clip.mp4') === 'direct');

console.log('\n--- Telegram 不能被当成登录页 ---');
// Telegram 的 normalize 返回 null（检测交给 DOM 兜底），但它绝不能被 auth 规则
// 拦掉，否则 Telegram 就没法下载了。
for (const host of ['web.telegram.org', 'webk.telegram.org', 'webz.telegram.org']) {
  const href = `https://${host}/k/`;
  check(`isAuthHref=false  ${href}`, Sites.isAuthHref(href) === false);
}

console.log('\n--- ytdlpOnly：浏览器通道结构性不可用的站点 ---');
// B 站是 DASH 分离流 + CDN 校验 Referer：chrome.downloads 不带 Referer 拿 403，
// 页面里 fetch 被 CORS 挡，播放器缓存里又是两条独立轨 —— 三条路都得不到能播的文件。
// 标记成 ytdlpOnly 之后，面板会把请求直接交给 yt-dlp（它自带该站的 Referer/cookie）。
{
  const bv = Sites.detectFromUrl('https://www.bilibili.com/video/BV1xx411c7mD');
  check('Bilibili 识别为站点', bv.kind === 'site' && bv.site === 'Bilibili', JSON.stringify(bv));
  check('Bilibili 标记 ytdlpOnly', bv.ytdlpOnly === true);
  check('Bilibili 归一化到 watch 地址',
    bv.url === 'https://www.bilibili.com/video/BV1xx411c7mD', bv.url);

  const live = Sites.detectFromUrl('https://live.bilibili.com/21452505');
  check('哔哩哔哩直播标记 ytdlpOnly', live.ytdlpOnly === true, JSON.stringify(live));

  // 没有 ytdlpOnly 的站点必须保持 undefined/false，否则会被误转走 yt-dlp。
  for (const [label, href] of [
    ['X', 'https://x.com/someone/status/123'],
    ['YouTube', 'https://www.youtube.com/watch?v=abc'],
    ['Telegram', 'https://web.telegram.org/k/'],
  ]) {
    const r = Sites.detectFromUrl(href);
    check(`${label} 不被打上 ytdlpOnly`, r.ytdlpOnly !== true, JSON.stringify(r));
  }

  // 不是视频页的 B 站地址仍然安静（首页、空间页…），别在哪儿都弹按钮。
  check('B 站首页不弹', kindOf('https://www.bilibili.com/') === 'none');
  check('B 站空间页不弹', kindOf('https://space.bilibili.com/12345') === 'none');
}

console.log('\n--- 乱七八糟的输入不许抛异常 ---');
for (const bad of ['', 'not a url', 'about:blank', 'chrome://extensions']) {
  let threw = false;
  try {
    Sites.detectFromUrl(bad);
    Sites.isAuthHref(bad);
  } catch (e) {
    threw = true;
  }
  check(`不抛异常  ${JSON.stringify(bad)}`, !threw);
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);

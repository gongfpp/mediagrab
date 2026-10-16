/**
 * Site recognition, shared by the content script and the popup.
 *
 * Exposes `globalThis.MediaGrabSites`. Kept dependency-free so it can be
 * loaded both as a content script and as a plain <script> in an extension page.
 */

(function () {
  const stripWww = (host) => host.replace(/^www\./, '');

  /**
   * 登录 / 账号 / SSO 页面一律不弹按钮。
   *
   * 为什么需要：这类页面经常带**装饰性 `<video>`**。典型就是微软「保持登录状态?」
   * （KMSI）页——中间那圈插画就是一个自动播放的 video，于是 DOM 兜底把它当成
   * 可下载视频，按钮就飘在登录卡片上了。用户看到的是一条毫无意义的「下载」。
   *
   * 判据刻意取窄：只列**确实是身份提供方**的域名，不做 `login.*` 这种前缀通配，
   * 免得哪天某个视频站把播放页放在 login 子域上被误杀。
   */
  const AUTH_HOST_RE = [
    /^login\.microsoftonline\.(?:com|us)$/,
    /^login\.partner\.microsoftonline\.cn$/,
    /^login\.microsoft\.com$/,
    /^login\.live\.com$/,
    /^account\.live\.com$/,
    /^accounts\.google\.com$/,
    /^accounts\.youtube\.com$/,
    /^appleid\.apple\.com$/,
    /^signin\.aws\.amazon\.com$/,
    /^auth\.services\.adobe\.com$/,
    /^login\.cloudflare\.com$/,
    /^login\.salesforce\.com$/,
    /^login\.qq\.com$/,
    /^(?:[a-z0-9-]+\.)?(?:auth0|okta|oktapreview|onelogin|pingidentity|duosecurity)\.com$/,
  ];

  // 路径兜底：host 不在名单里，但 URL 明显就是登录流程本身
  // （OAuth2 /authorize、SAML、SSO、KMSI…）。放在 RULES 之后判定，
  // 这样已知视频站永远优先。
  const AUTH_PATH_RE =
    /^\/(?:kmsi|login|signin|sign-in|signup|oauth2?|sso|saml2?|authorize|adfs)(?:\/|$)/i;

  function isAuthPage(url) {
    const host = stripWww(url.hostname);
    if (AUTH_HOST_RE.some((re) => re.test(host))) return true;
    return AUTH_PATH_RE.test(url.pathname);
  }

  /** 同上，但接收 href 字符串，方便 content script 在解析前先拦一道。 */
  function isAuthHref(href) {
    try {
      return isAuthPage(new URL(href));
    } catch (e) {
      return false;
    }
  }

  /**
   * `ytdlpOnly: true` —— 这个站的媒体**结构性**地用不了浏览器下载通道，
   * 必须交给 yt-dlp。判据是这两条同时成立：
   *
   *   1. 音视频分离（DASH）。浏览器下载器只能取一个 URL，拿到的是纯画面轨
   *      或纯音轨；播放器缓存（MSE）里同样是两条独立轨道，导出只能二选一。
   *   2. 媒体 CDN 校验 `Referer` / 登录态。`chrome.downloads.download` 不带
   *      页面 Referer，取到的响应是 403；页面里 `fetch` 又会被 CORS 挡掉。
   *
   * B 站两条全中：DASH + `*.bilivideo.com` 要求 `Referer: https://www.bilibili.com`。
   * yt-dlp 自带该站的 Referer 与 cookie 处理（`--cookies-from-browser chrome`
   * 已在设置里配上），是唯一能拿到合并后文件的通道。
   */
  const RULES = [
    {
      name: 'X / Twitter',
      match: (h) => /^(x|twitter)\.com$/.test(h),
      normalize: (u) => {
        const m = u.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
        return m ? `https://x.com/${m[1]}/status/${m[2]}` : null;
      },
    },
    {
      name: 'YouTube',
      match: (h) => /(^|\.)youtube\.com$/.test(h) || h === 'youtu.be',
      normalize: (u) => {
        if (u.hostname.replace(/^www\./, '') === 'youtu.be') {
          const id = u.pathname.slice(1).split('/')[0];
          return id ? `https://www.youtube.com/watch?v=${id}` : null;
        }
        if (u.pathname === '/watch') {
          const v = u.searchParams.get('v');
          return v ? `https://www.youtube.com/watch?v=${v}` : null;
        }
        const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/);
        return m ? `https://www.youtube.com/watch?v=${m[1]}` : null;
      },
    },
    {
      // 必须排在下面的 Bilibili 之前：`live.bilibili.com` 也匹配
      // /(^|\.)bilibili\.com$/，而 Bilibili 规则的 normalize 对 /<房间号> 返回
      // null —— 结果是直播间地址被判成「不是视频页」，这条规则从来没生效过。
      // （是 test/sites.test.mjs 把它照出来的。）
      name: '哔哩哔哩直播',
      match: (h) => /(^|\.)live\.bilibili\.com$/.test(h),
      ytdlpOnly: true,
      normalize: (u) => {
        const m = u.pathname.match(/^\/(?:blanc\/)?(\d+)/);
        return m ? `https://live.bilibili.com/${m[1]}` : null;
      },
    },
    {
      name: 'Bilibili',
      match: (h) => /(^|\.)bilibili\.com$/.test(h),
      ytdlpOnly: true,
      normalize: (u) => {
        const m = u.pathname.match(/^\/video\/(BV[\w]+|av\d+|BV[\w]+)/i);
        return m ? `https://www.bilibili.com/video/${m[1]}` : null;
      },
    },
    {
      name: 'Vimeo',
      match: (h) => /(^|\.)vimeo\.com$/.test(h),
      normalize: (u) => {
        const m = u.pathname.match(/\/(\d{6,})/);
        return m ? `https://vimeo.com/${m[1]}` : null;
      },
    },
    {
      name: 'Instagram',
      match: (h) => /(^|\.)instagram\.com$/.test(h),
      normalize: (u) => {
        const m = u.pathname.match(/^\/(p|reel|tv)\/([\w-]+)/);
        return m ? `https://www.instagram.com/${m[1]}/${m[2]}/` : null;
      },
    },
    {
      name: 'TikTok',
      match: (h) => /(^|\.)tiktok\.com$/.test(h),
      normalize: (u) => (/\/video\/\d+/.test(u.pathname) ? u.href.split('?')[0] : null),
    },
    {
      name: '微博',
      match: (h) => /(^|\.)weibo\.(com|cn)$/.test(h),
      normalize: (u) => (/^\/(?:\d+\/)?[A-Za-z0-9]{9,}/.test(u.pathname) && /\/(?:status|video|tv)\//.test(u.pathname)
        ? u.href.split('?')[0] : null),
    },
    {
      name: '抖音',
      match: (h) => /(^|\.)douyin\.com$/.test(h),
      normalize: (u) => (/\/video\/\d+/.test(u.pathname) ? u.href.split('?')[0] : null),
    },
    {
      name: 'Twitch',
      match: (h) => /(^|\.)twitch\.tv$/.test(h),
      normalize: (u) => {
        const m = u.pathname.match(/\/videos\/(\d+)/);
        return m ? `https://www.twitch.tv/videos/${m[1]}` : null;
      },
    },
    {
      name: 'Reddit',
      match: (h) => /(^|\.)reddit\.com$/.test(h),
      normalize: (u) => (/\/comments\//.test(u.pathname) ? u.href.split('?')[0] : null),
    },
    {
      name: 'Facebook',
      match: (h) => /(^|\.)facebook\.com$/.test(h),
      normalize: (u) => {
        const m = u.pathname.match(/\/(?:watch|videos|reel)\/(\d+)/);
        return m ? u.href.split('?')[0] : null;
      },
    },
    {
      name: 'Dailymotion',
      match: (h) => /(^|\.)dailymotion\.com$/.test(h),
      normalize: (u) => {
        const m = u.pathname.match(/\/video\/([\w]+)/);
        return m ? `https://www.dailymotion.com/video/${m[1]}` : null;
      },
    },
    {
      // Telegram Web / t.me: 视频源是运行时生成的 blob: URL 或 /k/stream/...，
      // 从页面 URL 本身无法判断当前是否有可下载的视频——所以 normalize 返回 null，
      // 把检测权交给 content.js 里的 DOM 兜底（<video currentSrc / src / <source>）。
      // 否则会出现在频道封面、联系人页、加载态等"没有视频"的页面也弹出下载按钮。
      //
      // 三个 Web 域都要认（抄 Neet-Nestor/Telegram-Media-Downloader 的 @match）：
      //   web.telegram.org（默认，会跳到 /k/ 或 /a/）
      //   webk.telegram.org（K 版直连）
      //   webz.telegram.org（Z 版直连）
      // 早先只写了第一个，从 webk / webz 直连进来的会话认不出来。
      name: 'Telegram',
      match: (h) => /^(t\.me|telegram\.me|web\.telegram\.org|webk\.telegram\.org|webz\.telegram\.org)$/.test(h),
      normalize: () => null,
    },
  ];

  function hostOf(href) {
    try {
      return stripWww(new URL(href).hostname);
    } catch (e) {
      return '';
    }
  }

  /**
   * Resolve a page URL to a downloadable media URL.
   * Returns { kind: 'site' | 'direct' | 'none', site?, url?, reason? }.
   * `direct` is only produced for obvious media URLs; the content script adds
   * a DOM-based fallback on top of this.
   */
  function detectFromUrl(href) {
    let url;
    try {
      url = new URL(href);
    } catch (e) {
      return { kind: 'none', reason: '无法解析地址' };
    }
    if (!/^https?:$/.test(url.protocol)) {
      return { kind: 'none', reason: '非 http(s) 页面' };
    }
    const host = stripWww(url.hostname);

    // 0. 身份提供方域名：直接放弃，不给 DOM 兜底任何机会。
    if (AUTH_HOST_RE.some((re) => re.test(host))) {
      return { kind: 'none', reason: '登录 / 账号页，已跳过' };
    }

    for (const rule of RULES) {
      if (!rule.match(host)) continue;
      const normalized = rule.normalize(url);
      if (!normalized) {
        return { kind: 'none', reason: `${rule.name} 页面，但当前地址不是视频页` };
      }
      return {
        kind: 'site',
        site: rule.name,
        url: normalized,
        // 见 RULES 上方注释：这类站点浏览器通道拿不到正确字节，必须走 yt-dlp。
        ytdlpOnly: rule.ytdlpOnly === true,
      };
    }

    if (/\.(mp4|webm|mov|m4v|mkv|m3u8|mpd)(\?|#|$)/i.test(url.pathname)) {
      return { kind: 'direct', site: host, url: href.split('#')[0] };
    }

    // 1. host 陌生，但路径明摆着是登录流程（OAuth2 /authorize、SAML、KMSI…）。
    //    放在媒体扩展名之后，`.mp4` 直链永远优先。
    if (AUTH_PATH_RE.test(url.pathname)) {
      return { kind: 'none', reason: '登录 / 账号页，已跳过' };
    }

    return { kind: 'none' };
  }

  globalThis.MediaGrabSites = { detectFromUrl, hostOf, isAuthPage, isAuthHref, RULES };
})();

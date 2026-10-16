# MediaGrab

Chrome 扩展 + 本机服务，让你在任意视频页面点一下就把视频下下来。

<p align="center">
  <img src="extension/icons/icon128.png" width="96" alt="MediaGrab 图标">
</p>

它解决的是一个很具体的问题：**在扩展面板里对着几十条 m3u8 猜哪条是自己的视频**。
你只需要点按钮，剩下的识别、解析、合并交给它。

- **优先走浏览器下载**。页面暴露了单文件直链时（X 的渐进式 mp4 等），扩展直接交给
  Chrome 下载器——不启动任何后台进程，进度落在你熟悉的下载栏里，也能被
  Rayburst / Motrix 这类下载器扩展接管。
- **只在必要时动用 [yt-dlp](https://github.com/yt-dlp/yt-dlp)**。页面没有直链
  （B 站、YouTube 这类音视频分离流）才走这条路，自动选最高画质、下分片、
  用 ffmpeg 合并音轨。
- **错误说人话**。「网络抖动，重试即可」和「代理挂了，重试没用，去修 Clash」是
  两回事，面板会分清——不会让你在一句英文报错前反复重试。

---

## 快速开始

**前置**：macOS，Node ≥ 20、Python ≥ 3.8（用于跑测试），以及：

```bash
brew install yt-dlp ffmpeg
```

**安装**：

```bash
git clone <this-repo> mediagrab
cd mediagrab
./install.sh
```

脚本会生成你自己的扩展密钥、部署本机服务、注册到所有 Chromium 系浏览器，
并做一次协议自检。**私钥在你本机生成**，仓库里不含任何人的密钥。

**加载扩展**（只需一次）：

1. 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选 `extension/` 目录
4. 记下显示的扩展 ID——脚本会把它打印出来，两边必须一致

点扩展图标，左上角出现「已连接」即成功。

> **为什么 ID 不是固定值？**
> Chrome 的扩展 ID 由 manifest 里的公钥决定。私钥不进仓库，所以每个人
> 第一次跑 `install.sh` 都会生成自己的一对，ID 也就各不相同。
> `install.sh` 会把 manifest 与 native host 清单对齐好，你只要在
> `chrome://extensions` 里核对一眼。

---

## 工作原理

```
 浏览器沙箱内                原生消息通道              本机
┌────────────────┐    4字节长度+JSON    ┌─────────────────────────┐
│ content.js     │ ──────────────────► │ mediagrab_host.py      │
│  面板/页面按钮  │◄────────────────── │  ├ 找 yt-dlp/ffmpeg    │
│                │                     │  ├ 探测可用的代理       │
│ background.js  │      jobId          │  ├ probe: 元数据        │
│  编排/轮询状态  │◄────────────────── │  └ download: 独立会话    │
└───────┬────────┘      status         └──────────┬──────────────┘
        │                                           │
        │ 页面有单文件直链时                          ▼
        │ chrome.downloads.download           yt-dlp 子进程
        ▼                                       │
   Chrome 下载栏                       jobs/<id>.log（完整输出）
```

三个值得说明的设计：

**扩展不能执行命令**，所以走 Chrome 官方的 native messaging。扩展与一个本机
stdio 进程对话——这就是「宿主」。Chrome 扩展跑在沙箱里，只能读写页面，
而 yt-dlp 是命令行工具，扩展碰不到。

**长任务不占用消息通道**。一次 probe 可能要几十秒，而 MV3 的 service worker
空闲就会被回收。所以 `start` 只负责 fork 一个**独立会话**的子进程
（`start_new_session=True`）并立刻返回 `jobId`，之后轮询 `status`——
**关掉浏览器，下载也会跑完**。

**字节只能在页面世界拉**。Telegram 这类站点在页面里运行时自己造流，
必须从 MAIN world 发请求；隔离世界的 `fetch` 会 302 到 CDN 而拿不到数据。
看到 302 就说明请求根本没进 service worker。

---

## 使用

### 页面内面板

访问视频页时，视频右上角出现「下载」按钮。面板会先看页面自己暴露了什么：

- 命中直链 → 直接显示可用分辨率，**不启动任何后台进程**
- 没命中 → 用 yt-dlp 解析一次，显示标题、时长、画质档

### 工具栏 popup

- 一键下载当前标签页的视频
- **复制直链**：粘进任何下载器（Rayburst、aria2、IDM…）
- 设置默认方式、画质、输出目录、Cookie 来源
- 查看/取消任务、在 Finder 中定位成品

### 两种通道怎么选

| | 谁在下载 | 进度在哪 | 什么时候用 |
|---|---|---|---|
| **浏览器下载**（默认） | Chrome 内置下载 | 下载栏 + 面板 | 页面有单文件直链 |
| **yt-dlp 下载** | 后台进程 | 只有面板 | 通吃。分离流站点必须走这条 |

如果你选了浏览器通道但页面只有 HLS/DASH 分离流，面板会明确提示改用 yt-dlp——
不会悄悄下出一个无声的视频。

浏览器通道用 Chrome 的默认下载目录，所以面板里的「目录」在该模式下会置灰，
要改请去 `chrome://settings/downloads`。yt-dlp 通道仍按面板设置输出。

### 支持的站点

内置规则：X / Twitter、YouTube、Bilibili、Vimeo、Instagram、TikTok、微博、
抖音、Twitch、Reddit、Facebook、Dailymotion、Bilibili 直播。

不在列表里也不要紧——页面只要有带直链的 `<video>` 元素就会出按钮。而 yt-dlp
本身支持 1800+ 站点，所以**只要地址对，理论上任何站点都能下**。规则表只是把
页面地址规范化成 yt-dlp 认得的视频页地址。

---

## 目录结构

```
mediagrab/
├── extension/              扩展本体（加载这个目录）
│   ├── manifest.json       MV3 清单（key 字段由 install.sh 本机填充）
│   ├── sites.js            站点识别（内容脚本与 popup 共用）
│   ├── content.js          页面内面板、两条通道的实现
│   ├── background.js       service worker：任务编排与轮询
│   ├── hooks.js            注入 MAIN world 的采集钩子
│   ├── rangeFetch.js       分块拉流（续传/合并）
│   ├── staging.js         暂存写盘（分块落地的落点）
│   ├── popup.html/js       工具栏面板
│   └── icons/
├── native/
│   ├── mediagrab-host      bash 启动器（挑选可用的 python3）
│   ├── mediagrab_host.py   宿主本体
│   └── com.mass.mediagrab.json   注册清单模板
├── test/
│   ├── run.sh              唯一测试入口
│   └── *.test.mjs / *.test.py
├── build/
│   ├── nm_client.py        按原生消息协议手动测宿主
│   └── make_icons.py       图标生成（纯 Python，无依赖）
├── install.sh
└── uninstall.sh
```

**运行时目录**（不在仓库里）：

| 路径 | 内容 |
|---|---|
| `~/Library/Application Support/MediaGrab/host/` | 部署后的宿主 |
| `~/Library/Application Support/MediaGrab/jobs/` | `<jobId>.log` 是 yt-dlp 完整输出 |
| `build/extension_key.pem` | 你本机的扩展私钥（install.sh 生成） |

---

## 开发

```bash
bash test/run.sh
```

这是**唯一**的测试入口。它会做语法检查、跑 6 个测试套件、执行 33 组
**反向验证**——每一组都把某处代码改回旧行为，确认对应断言真的会失败。

为什么要这么多？因为这个项目的 bug 大多不是"功能没写"，而是
**"看起来对但实际错"**：规则顺序搞反了、参数名对但值非法、补丁打上了
但脚本读的是别的文件。反向验证是唯一能照出这类问题的手段。

```
syntax + 346 项断言 + 33 组反向验证
```

改完宿主（`native/mediagrab_host.py`）后**必须**重跑 `./install.sh`——
Chrome 执行的是 `~/Library/Application Support/MediaGrab/host/` 下的副本。

---

## 排错

**面板显示「未连接」**
扩展 ID 与 native host 清单不一致。核对 `chrome://extensions` 显示的 ID 与
`build/extension_id.txt`，不一致就重跑 `./install.sh`。

**提示找不到 yt-dlp**
宿主读自己的 PATH，只认 `/opt/homebrew/bin`、`/usr/local/bin` 与系统路径。
装到别处就把它放进这两个目录之一，或改 `mediagrab_host.py` 里的 `find_binary`。

**下载失败**
先看 `~/Library/Application Support/MediaGrab/jobs/<jobId>.log`。
第一行是完整命令行，**可以在终端里原样重跑**。这个目录也是排查任何问题的
第一入口——它记录了每次尝试的输入、完整命令与 stderr。

**代理连不上**
宿主会逐个**实测**候选代理（发真实请求判可用性），而不是盲信环境变量——
沙箱注入的 `HTTP(S)_PROXY` 常常是失效的。它会依次尝试环境变量里的值和
`scutil --proxy` 里的系统代理（Clash Verge 就写在这里），坏的全部跳过。

**手动测试宿主**

```bash
PY=$(command -v python3)
"$PY" build/nm_client.py \
  "$HOME/Library/Application Support/MediaGrab/host/mediagrab-host" \
  '{"cmd":"ping"}'
```

支持 `ping` / `probe` / `start` / `status` / `list` / `cancel` / `reveal` /
`config` / `openDir`。

---

## 卸载

```bash
./uninstall.sh
```

移除浏览器注册与本机服务（都进废纸篓）。扩展本体需到 `chrome://extensions`
手动移除。

---

## 说明

- 仅供个人使用，请遵守你访问的网站的服务条款与版权规定。
- 依赖 [yt-dlp](https://github.com/yt-dlp/yt-dlp)（GPL-3.0）与 ffmpeg，
  安装前请了解它们的许可。
- 部分站点需要登录态：宿主支持从浏览器读取 Cookie（默认 Chrome）。
  Cookie 只在**你本机**使用，不上传任何地方。
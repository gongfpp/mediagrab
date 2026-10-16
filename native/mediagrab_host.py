#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MediaGrab native messaging host.

Talks to the WorkBuddy MediaGrab Chrome extension over Chrome's native
messaging protocol (4-byte native-endian length prefix + UTF-8 JSON).

Responsibilities:
  * locate yt-dlp / ffmpeg and work out proxy settings
  * probe a page URL for metadata and direct media URLs
  * run downloads in a detached session so they survive the browser closing
  * report progress by tailing the job log

Commands (request -> response):
  ping                                   -> environment report
  probe   {url, ...}                     -> synchronous metadata read (CLI use)
  start   {url, action, ...}             -> {jobId}; action is probe|download
  status  {jobId}                        -> progress snapshot (+ probe payload)
  list    {}                             -> recent jobs
  cancel  {jobId}                        -> {ok}
  reveal  {path}                         -> reveal in Finder
  config  {} | {config:{...}}            -> read / write defaults
  openDir {dir}                          -> open a folder

Every long-running operation runs as a *job*: `start` forks a detached child
(new session, so it survives the browser and this host exiting) and returns
immediately. The extension polls `status` instead of holding one long native
message open, which would outlive the MV3 service worker.
"""

import json
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import time
import uuid

HOST_VERSION = "1.0.0"

HOME = os.path.expanduser("~")
APP_DIR = os.path.join(HOME, "Library", "Application Support", "MediaGrab")
JOBS_DIR = os.path.join(APP_DIR, "jobs")
CONFIG_PATH = os.path.join(APP_DIR, "config.json")

EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]

DEFAULT_CONFIG = {
    "outDir": os.path.join(HOME, "Downloads"),
    "quality": "best",
    "mode": "ytdlp",
    "cookiesFromBrowser": "chrome",
    "filenameTemplate": "%(uploader)s_%(id)s.%(ext)s",
    "allowPlaylist": False,
    "proxy": "",
    "revealOnFinish": True,
}

QUALITY_CHOICES = {
    "best": "bv*+ba/b",
    "1080": "bv*+ba/b",
    "720": "bv*+ba/b",
    "480": "bv*+ba/b",
    "audio": "ba/b",
}

# Resolution targeting uses --format-sort rather than a `[height<=N]` filter.
# yt-dlp's `res` is the *shorter* side, so it behaves correctly on portrait
# video; a height filter would either miss (portrait 720x1542 has height 1542)
# or, worse, latch onto a smaller portrait stream and stop there.
QUALITY_SORT = {
    "best": "",
    "1080": "res:1080",
    "720": "res:720",
    "480": "res:480",
    "audio": "",
}


# --------------------------------------------------------------------------
# native messaging plumbing
# --------------------------------------------------------------------------

def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("@I", raw)
    if length == 0:
        return None
    payload = b""
    while len(payload) < length:
        chunk = sys.stdin.buffer.read(length - len(payload))
        if not chunk:
            break
        payload += chunk
    return json.loads(payload.decode("utf-8"))


def write_message(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


# --------------------------------------------------------------------------
# environment
# --------------------------------------------------------------------------

def find_binary(name, candidates=()):
    for path in candidates:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return shutil.which(name)


def ytdlp_path():
    return find_binary("yt-dlp", [
        "/opt/homebrew/bin/yt-dlp",
        "/usr/local/bin/yt-dlp",
        os.path.join(HOME, ".local/bin/yt-dlp"),
        "/opt/homebrew/Cellar/yt-dlp",
    ])


def ffmpeg_path():
    return find_binary("ffmpeg", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"])


_PROXY_CACHE = {"key": None, "value": "", "at": 0.0}
PROXY_TTL = 60.0


def _proxy_works(proxy, timeout=4):
    """真连一次才知道代理能不能用。

    ⚠️ 端口通 ≠ 代理能用：Clash 的 mihomo 内核端口（哪怕 127.0.0.1:50879）
    会接受 TCP 连接但转发失败，curl 表现为 http_code=000。所以必须发真实请求。
    """
    if not proxy:
        return False
    try:
        r = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
             "--max-time", str(timeout), "--proxy", proxy, "https://www.youtube.com"],
            capture_output=True, text=True, timeout=timeout + 3)
        return (r.stdout or "").strip() == "200"
    except Exception:
        return False


def _system_proxy():
    """Read the macOS system proxy (Clash writes here). Returns '' when off."""
    try:
        out = subprocess.run(["/usr/sbin/scutil", "--proxy"], capture_output=True,
                             text=True, timeout=5).stdout
    except Exception:
        return ""
    host = re.search(r"^\s*HTTPSProxy\s*:\s*(\S+)", out, re.M) or \
        re.search(r"^\s*HTTPProxy\s*:\s*(\S+)", out, re.M)
    if not host:
        return ""
    port = re.search(r"^\s*HTTPSPort\s*:\s*(\d+)", out, re.M) or \
        re.search(r"^\s*HTTPPort\s*:\s*(\d+)", out, re.M)
    return "http://%s:%s" % (host.group(1), port.group(1) if port else "1087")


def detect_proxy():
    """Return a **working** proxy, or '' when none works.

    ⚠️ 2026-10-16 实测的坑：这里原来"环境变量优先、拿不到才读 scutil"，
    而沙箱注入的 HTTP(S)_PROXY（127.0.0.1:<随机端口>）**常常是失效的** ——
    它每次都不一样（见过 59362/51541/58758），表现为"时好时坏"，
    极易误判成网络抖动。而 scutil 里的 Clash 端口（7897）一直是好的。

    所以现在：**每个候选都要实测能连上才用**，坏的就回落下一个。
    结果缓存 PROXY_TTL 秒，避免每次起 yt-dlp 都连一次外网。
    """
    env_key = "|".join(
        os.environ.get(v, "").strip()
        for v in ("https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "ALL_PROXY"))
    key = (env_key, int(time.time() / PROXY_TTL))
    if _PROXY_CACHE["key"] == key:
        return _PROXY_CACHE["value"]

    candidates = []
    for var in ("https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "ALL_PROXY"):
        v = os.environ.get(var, "").strip()
        if v and v not in candidates:
            candidates.append(v)
    # 系统代理放在**后面**当回落：它是用户显式配置的 Clash 端口，比沙箱注入的可靠。
    sysp = _system_proxy()
    if sysp and sysp not in candidates:
        candidates.append(sysp)

    value = ""
    for c in candidates:
        if _proxy_works(c):
            value = c
            break
    _PROXY_CACHE.update({"key": key, "value": value, "at": time.time()})
    return value


def ensure_dirs():
    os.makedirs(JOBS_DIR, exist_ok=True)


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    except Exception:
        pass
    return cfg


def save_config(patch):
    cfg = load_config()
    cfg.update(patch or {})
    ensure_dirs()
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)
    return cfg


def env_report():
    proxy = detect_proxy()
    return {
        "hostVersion": HOST_VERSION,
        "ytdlp": ytdlp_path() or "",
        "ffmpeg": ffmpeg_path() or "",
        "proxy": proxy,
        "appDir": APP_DIR,
        "python": sys.executable,
        "config": load_config(),
    }


# --------------------------------------------------------------------------
# yt-dlp invocation
# --------------------------------------------------------------------------

def cookies_args(meta):
    source = (meta.get("cookies") or "").strip()
    if not source or source == "none":
        return []
    if os.path.isfile(source):
        return ["--cookies", source]
    return ["--cookies-from-browser", source]


def format_selector(quality):
    return QUALITY_CHOICES.get(quality or "best", QUALITY_CHOICES["best"])


def base_args(meta, purpose):
    """Common yt-dlp arguments. `purpose` is 'probe' or 'download'."""
    binary = ytdlp_path()
    if not binary:
        raise RuntimeError("yt-dlp not found on this machine")

    args = [binary, "--no-colors", "--no-warnings"]
    args += cookies_args(meta)

    proxy = (meta.get("proxy") or "").strip() or detect_proxy()
    if proxy:
        args += ["--proxy", proxy]

    ffmpeg = ffmpeg_path()
    if ffmpeg:
        args += ["--ffmpeg-location", ffmpeg]

    if purpose == "probe":
        args += ["--simulate", "--no-playlist", "--socket-timeout", "20"]
    else:
        args += [
            "--newline",
            "--no-simulate",
            "--progress",
            # ⚠️ 30 秒对"经代理的中文站点"偏紧。实测（1.9.2）B 站下载以
            #   `Read timed out. (read timeout=30.0)` 失败，而**同样的参数**
            #   在本机手动跑 2 分钟下到 76% —— 说明这不是稳定复现的能力问题，
            #   是代理链路上偶发的长延迟。放宽到 60s + 退避重试，比让用户
            #   手动重试更划算（历史 job 里 30/41 成功，失败的绝大多数是这类）。
            "--socket-timeout", "60",
            "--retries", "10",
            # ⚠️ `linear` **必须带参数**：`linear=START[:END[:STEP]]`。
            #    写成裸 `linear` 会被 yt-dlp 当成表达式解析失败：
            #      yt-dlp: error: invalid http retry sleep expression 'linear'
            #    然后**整条命令以退出码 2 失败**，一个字节都下不到 ——
            #    而面板只显示「失败」，用户完全看不出是自己的参数写错了
            #    （1.9.2 实测：X 页面上连续两次都是这个，退出码 2）。
            #    1::2 = 第一次等 1 秒，之后每次多等 1 秒，最多 2 秒。
            #
            #    没有退避的话，--retries 10 会在几秒内全部撞上同一个坏连接。
            "--retry-sleep", "linear=1::2",
            "--fragment-retries", "10",
            "--trim-filenames", "150",
            "--no-mtime",
            "-f", format_selector(meta.get("quality")),
        ]
        sort = QUALITY_SORT.get(meta.get("quality") or "best", "")
        if sort:
            args += ["-S", sort]
        if not meta.get("allowPlaylist"):
            args += ["--no-playlist"]
        out_dir = os.path.expanduser(meta.get("outDir") or DEFAULT_CONFIG["outDir"])
        template = meta.get("filenameTemplate") or DEFAULT_CONFIG["filenameTemplate"]
        args += ["-P", out_dir, "-o", template]
    return args


PROGRESS_TEMPLATE = (
    "download:@@PROG@@%(progress._percent_str)s|%(progress._speed_str)s|"
    "%(progress._eta_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|"
    "%(progress._total_bytes_estimate_str)s|%(info.format_id)s"
)


def summarize_info(info, url):
    """Reduce a yt-dlp info dict to the small payload the extension needs.

    Native messages from the host are capped at 1 MB, and the raw dump carries
    several hundred KB of format/URL noise, so trim hard.
    """
    def clean(fmt):
        direct = None
        if fmt.get("protocol") in ("http", "https") and fmt.get("url"):
            direct = fmt["url"]

        raw_v = fmt.get("vcodec")
        raw_a = fmt.get("acodec")
        proto = fmt.get("protocol")
        height = fmt.get("height")
        width = fmt.get("width")

        # yt-dlp reports the codec as "none" when a stream is definitely
        # absent, but as None when it simply did not identify it. Twitter's
        # progressive mp4 originals fall in the latter bucket, so a null
        # codec must not be read as "missing".
        video_absent = raw_v == "none"
        audio_absent = raw_a == "none"
        has_video = not video_absent and (raw_v is not None or bool(height or width))
        has_audio = not audio_absent and (
            raw_a is not None
            or bool(fmt.get("abr"))
            or (bool(height) and proto in ("http", "https"))
        )

        return {
            "formatId": fmt.get("format_id"),
            "ext": fmt.get("ext"),
            "height": height,
            "width": width,
            "fps": fmt.get("fps"),
            "vcodec": raw_v if isinstance(raw_v, str) and raw_v else "?",
            "acodec": raw_a if isinstance(raw_a, str) and raw_a else "?",
            "abr": round(fmt["abr"]) if fmt.get("abr") else None,
            "filesize": fmt.get("filesize") or fmt.get("filesize_approx"),
            "protocol": proto,
            "directUrl": direct,
            "hasVideo": has_video,
            "hasAudio": has_audio,
        }

    entries = info.get("entries") or []
    formats = [clean(f) for f in (info.get("formats") or [])]

    # Single-file formats: usable by a plain downloader with no muxing step.
    progressive = [f for f in formats
                   if f["directUrl"] and f["hasVideo"] and f["hasAudio"]]
    progressive.sort(key=lambda f: (f.get("height") or 0, f.get("filesize") or 0),
                     reverse=True)

    result = {
        "id": info.get("id"),
        "title": info.get("title"),
        "uploader": info.get("uploader"),
        "duration": info.get("duration"),
        "extractor": info.get("extractor_key") or info.get("extractor"),
        "webpageUrl": info.get("webpage_url") or url,
        "isPlaylist": bool(entries),
        "entryCount": len(entries),
        "formats": formats[-30:],
        "progressive": progressive[:10],
    }
    if entries:
        result["entriesPreview"] = [
            {"id": e.get("id"), "title": (e.get("title") or "")[:120],
             "duration": e.get("duration"), "url": e.get("webpage_url") or e.get("url")}
            for e in entries[:20]
        ]
    return result



def cmd_probe(meta):
    """Synchronous probe, used by the CLI harness. The extension uses a probe
    job instead so a slow site cannot outlive the MV3 service worker."""
    url = (meta.get("url") or "").strip()
    if not url:
        return {"ok": False, "error": "missing url"}

    args = base_args(meta, "probe") + ["--dump-single-json", url]
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "probe timed out after 180s"}

    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()
        return {"ok": False, "error": tail[-1] if tail else "yt-dlp probe failed"}

    try:
        info = json.loads(proc.stdout)
    except Exception:
        return {"ok": False, "error": "could not parse yt-dlp metadata"}

    return dict(summarize_info(info, url), ok=True)


# --------------------------------------------------------------------------
# jobs
# --------------------------------------------------------------------------

def job_paths(job_id):
    return (
        os.path.join(JOBS_DIR, job_id + ".json"),
        os.path.join(JOBS_DIR, job_id + ".log"),
        os.path.join(JOBS_DIR, job_id + ".exit"),
    )


def read_job_meta(job_id):
    meta_path, _, _ = job_paths(job_id)
    try:
        with open(meta_path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def write_job_meta(job_id, meta):
    meta_path, _, _ = job_paths(job_id)
    tmp = meta_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, meta_path)


def cmd_start(meta):
    url = (meta.get("url") or "").strip()
    if not url:
        return {"ok": False, "error": "missing url"}
    if not ytdlp_path():
        return {"ok": False, "error": "yt-dlp not found; install it with: brew install yt-dlp"}

    action = meta.get("action") or "download"
    if action not in ("probe", "download"):
        action = "download"

    ensure_dirs()
    job_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    out_dir = os.path.expanduser(meta.get("outDir") or DEFAULT_CONFIG["outDir"])
    if not os.path.isdir(out_dir):
        try:
            os.makedirs(out_dir, exist_ok=True)
        except Exception:
            out_dir = DEFAULT_CONFIG["outDir"]

    record = {
        "jobId": job_id,
        "action": action,
        "url": url,
        "title": meta.get("title") or url,
        "pageUrl": meta.get("pageUrl") or url,
        "mode": meta.get("mode") or "ytdlp",
        "outDir": out_dir,
        "quality": meta.get("quality") or "best",
        "allowPlaylist": bool(meta.get("allowPlaylist")),
        "cookies": meta.get("cookies", DEFAULT_CONFIG["cookiesFromBrowser"]),
        "filenameTemplate": meta.get("filenameTemplate") or DEFAULT_CONFIG["filenameTemplate"],
        "proxy": meta.get("proxy") or "",
        "revealOnFinish": bool(meta.get("revealOnFinish", True)),
        "startedAt": time.time(),
        "startedAtISO": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    write_job_meta(job_id, record)

    _, log_path, _ = job_paths(job_id)
    log_fh = open(log_path, "w", encoding="utf-8")
    log_fh.write("@@JOB@@%s\n" % json.dumps(
        {"url": url, "action": action, "mode": record["mode"], "outDir": out_dir},
        ensure_ascii=False))
    log_fh.write("@@CMD@@%s\n" % " ".join(base_args(record, "probe" if action == "probe" else "download") + [url]))
    log_fh.flush()

    env = dict(os.environ)
    env["PATH"] = ":".join(EXTRA_PATH + [env.get("PATH", "")])
    env["PYTHONUNBUFFERED"] = "1"

    proc = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "--run-job", job_id],
        stdin=subprocess.DEVNULL, stdout=log_fh, stderr=subprocess.STDOUT,
        start_new_session=True, env=env,
    )
    record["pid"] = proc.pid
    write_job_meta(job_id, record)

    return {"ok": True, "jobId": job_id, "pid": proc.pid, "outDir": out_dir}


def parse_log(log_path, started_at):
    """Extract structured progress from a job log."""
    out = {"percent": None, "speed": None, "eta": None, "downloaded": None,
           "total": None, "title": None, "file": None, "lastLine": None,
           "probe": None, "streams": [], "streamIndex": 0, "errors": []}
    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    except Exception:
        return out

    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line.startswith("@@PROBE@@"):
            try:
                out["probe"] = json.loads(line[len("@@PROBE@@"):])
            except Exception:
                out["probe"] = None
        elif line.startswith("@@PROG@@"):
            parts = line[len("@@PROG@@"):].split("|")
            if len(parts) >= 5:
                pct = parts[0].strip().rstrip("%")
                try:
                    out["percent"] = float(pct)
                except ValueError:
                    out["percent"] = None
                out["speed"] = parts[1].strip()
                out["eta"] = parts[2].strip()
                out["downloaded"] = parts[3].strip()

                total = parts[4].strip()
                estimate = parts[5].strip() if len(parts) > 5 else ""
                # Fragmented streams report no upfront size; the running
                # estimate is the only usable figure.
                if total in ("N/A", "Unknown", ""):
                    total = "" if estimate in ("N/A", "Unknown") else estimate
                out["total"] = total or None

                # A separate format_id means yt-dlp moved on to the next
                # stream (video track then audio track), which resets the
                # percentage. Track the sequence so the UI can say "2/2".
                fmt = parts[6].strip() if len(parts) > 6 else ""
                if fmt and (not out["streams"] or out["streams"][-1] != fmt):
                    if fmt not in out["streams"]:
                        out["streams"].append(fmt)
                out["streamIndex"] = len(out["streams"])
        elif line.startswith("@@FILE@@"):
            out["file"] = line[len("@@FILE@@"):].strip()
        elif line.startswith("@@TITLE@@"):
            out["title"] = line[len("@@TITLE@@"):].strip()
        elif line.startswith("@@DONE@@"):
            try:
                payload = json.loads(line[len("@@DONE@@"):])
                out["file"] = payload.get("file") or out["file"]
                out["title"] = payload.get("title") or out["title"]
                if payload.get("file"):
                    out["file"] = payload["file"]
            except Exception:
                pass
        elif line.startswith("[download]") or line.startswith("[Merger]") \
                or line.startswith("[ExtractAudio]") or line.startswith("[hls") \
                or line.startswith("[twitter]") or line.startswith("[youtube]"):
            pass
        elif line.startswith("ERROR"):
            out["errors"].append(line)
        out["lastLine"] = line

    return out


def cmd_status(job_id):
    meta = read_job_meta(job_id)
    if not meta:
        return {"ok": False, "error": "unknown jobId"}
    meta_path, log_path, exit_path = job_paths(job_id)
    progress = parse_log(log_path, meta.get("startedAt", 0))

    state = "running"
    exit_code = None
    if os.path.exists(exit_path):
        try:
            with open(exit_path, "r", encoding="utf-8") as fh:
                exit_code = int(fh.read().strip() or "0")
        except Exception:
            exit_code = None
        if exit_code == 0:
            state = "done"
        else:
            state = "error"
    else:
        pid = meta.get("pid")
        if pid and not process_alive(pid):
            state = "error"
            progress["errors"].append("download process exited unexpectedly")

    result = {
        "ok": True,
        "jobId": job_id,
        "action": meta.get("action") or "download",
        "state": state,
        "exitCode": exit_code,
        "title": progress.get("title") or meta.get("title"),
        "url": meta.get("url"),
        "pageUrl": meta.get("pageUrl"),
        "outDir": meta.get("outDir"),
        "mode": meta.get("mode"),
        "startedAtISO": meta.get("startedAtISO"),
        "elapsed": round(time.time() - float(meta.get("startedAt") or time.time()), 1),
        "percent": progress.get("percent"),
        "speed": progress.get("speed"),
        "eta": progress.get("eta"),
        "downloaded": progress.get("downloaded"),
        "total": progress.get("total"),
        "streams": progress.get("streams", []),
        "streamIndex": progress.get("streamIndex", 0),
        "file": progress.get("file"),
        "lastLine": progress.get("lastLine"),
        "probe": progress.get("probe"),
        "errors": progress.get("errors", [])[-5:],
    }
    if result["state"] == "done" and not result["file"]:
        result["file"] = newest_media_file(meta.get("outDir"), meta.get("startedAt"))
    return result


def newest_media_file(directory, since_ts):
    if not directory or not os.path.isdir(directory):
        return None
    best, best_mtime = None, 0
    exts = (".mp4", ".mkv", ".webm", ".mov", ".m4a", ".mp3", ".opus", ".flac", ".ts")
    try:
        for entry in os.scandir(directory):
            if not entry.is_file() or not entry.name.lower().endswith(exts):
                continue
            mtime = entry.stat().st_mtime
            if mtime > best_mtime:
                best, best_mtime = entry.path, mtime
    except Exception:
        return None
    return best


def process_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False


def cmd_list():
    ensure_dirs()
    items = []
    try:
        names = sorted(os.listdir(JOBS_DIR), reverse=True)
    except Exception:
        return {"ok": True, "jobs": []}
    for name in names:
        if not name.endswith(".json"):
            continue
        job_id = name[:-5]
        status = cmd_status(job_id)
        if status.get("ok") and status.get("action") == "download":
            items.append(status)
        if len(items) >= 25:
            break
    return {"ok": True, "jobs": items}


def cmd_cancel(job_id):
    meta = read_job_meta(job_id)
    if not meta:
        return {"ok": False, "error": "unknown jobId"}
    pid = meta.get("pid")
    if pid and process_alive(pid):
        try:
            os.killpg(os.getpgid(int(pid)), signal.SIGTERM)
        except Exception:
            try:
                os.kill(int(pid), signal.SIGTERM)
            except Exception as exc:
                return {"ok": False, "error": str(exc)}
    _, _, exit_path = job_paths(job_id)
    with open(exit_path, "w", encoding="utf-8") as fh:
        fh.write("130")
    return {"ok": True}


def cmd_reveal(path):
    if not path or not os.path.exists(path):
        return {"ok": False, "error": "path not found: %s" % path}
    subprocess.Popen(["/usr/bin/open", "-R", path])
    return {"ok": True}


def cmd_open_dir(directory):
    directory = os.path.expanduser(directory or DEFAULT_CONFIG["outDir"])
    if not os.path.isdir(directory):
        return {"ok": False, "error": "not a directory: %s" % directory}
    subprocess.Popen(["/usr/bin/open", directory])
    return {"ok": True}


# --------------------------------------------------------------------------
# child process: actually run one download
# --------------------------------------------------------------------------

def run_job(job_id):
    """Executed in the detached child. Never talks to Chrome."""
    meta = read_job_meta(job_id) or {}
    _, log_path, exit_path = job_paths(job_id)
    log = open(log_path, "a", encoding="utf-8", buffering=1)

    env = dict(os.environ)
    env["PATH"] = ":".join(EXTRA_PATH + [env.get("PATH", "")])
    env["PYTHONUNBUFFERED"] = "1"

    if (meta.get("action") or "download") == "probe":
        code = _run_probe_job(meta, log, env)
    else:
        code = _run_download_job(meta, log, env)

    log.flush()
    log.close()
    with open(exit_path, "w", encoding="utf-8") as fh:
        fh.write(str(code))


def _run_probe_job(meta, log, env):
    args = base_args(meta, "probe") + ["--dump-single-json", meta.get("url")]
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=600, env=env)
    except Exception as exc:
        log.write("ERROR: probe failed: %r\n" % (exc,))
        return 1

    if proc.returncode != 0:
        for line in (proc.stderr or "").strip().splitlines()[-8:]:
            log.write(line + "\n")
        log.write("ERROR: yt-dlp probe exited with %s\n" % proc.returncode)
        return proc.returncode

    try:
        info = json.loads(proc.stdout)
    except Exception as exc:
        log.write("ERROR: could not parse metadata: %r\n" % (exc,))
        return 1

    summary = summarize_info(info, meta.get("url"))
    log.write("@@TITLE@@%s\n" % (summary.get("title") or "").replace("\n", " "))
    log.write("@@PROBE@@%s\n" % json.dumps(summary, ensure_ascii=False))
    log.write("[MediaGrab] 解析完成\n")
    return 0


def _run_download_job(meta, log, env):
    args = base_args(meta, "download")
    args += ["--print", "before_dl:@@TITLE@@%(title)s"]
    args += ["--print", "after_move:@@FILE@@%(filepath)s"]
    args += ["--progress-template", PROGRESS_TEMPLATE]
    args += [meta.get("url")]

    try:
        proc = subprocess.Popen(args, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True,
                                bufsize=1, env=env)
        for line in proc.stdout:
            log.write(line.rstrip("\n") + "\n")
        code = proc.wait()
    except Exception as exc:
        log.write("ERROR: failed to run yt-dlp: %r\n" % (exc,))
        return 1

    if code == 0:
        final = find_downloaded_file(meta)
        log.write("@@DONE@@%s\n" % json.dumps(
            {"file": final, "title": meta.get("title")}, ensure_ascii=False))
        log.write("[MediaGrab] 下载完成\n")
    else:
        log.write("[MediaGrab] 下载失败，退出码 %s\n" % code)
    return code


def find_downloaded_file(meta):
    """Best-effort: newest media file in the output dir created by this job."""
    out_dir = meta.get("outDir")
    since = float(meta.get("startedAt") or 0) - 5
    if not out_dir or not os.path.isdir(out_dir):
        return None
    exts = (".mp4", ".mkv", ".webm", ".mov", ".m4a", ".mp3", ".opus", ".flac")
    best, best_mtime = None, 0
    try:
        for entry in os.scandir(out_dir):
            if not entry.is_file() or not entry.name.lower().endswith(exts):
                continue
            stat = entry.stat()
            if stat.st_mtime >= since and stat.st_mtime > best_mtime:
                best, best_mtime = entry.path, stat.st_mtime
    except Exception:
        return None
    return best


# --------------------------------------------------------------------------
# dispatcher
# --------------------------------------------------------------------------

def handle(request):
    cmd = (request.get("cmd") or "").strip()
    if cmd == "ping":
        return dict(env_report(), ok=True)
    if cmd == "probe":
        return cmd_probe(request)
    if cmd == "start":
        return cmd_start(request)
    if cmd == "status":
        return cmd_status(request.get("jobId") or "")
    if cmd == "list":
        return cmd_list()
    if cmd == "cancel":
        return cmd_cancel(request.get("jobId") or "")
    if cmd == "reveal":
        return cmd_reveal(request.get("path") or "")
    if cmd == "openDir":
        return cmd_open_dir(request.get("dir") or "")
    if cmd == "config":
        if request.get("config"):
            return {"ok": True, "config": save_config(request["config"])}
        return {"ok": True, "config": load_config()}
    return {"ok": False, "error": "unknown command: %s" % cmd}


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--run-job":
        run_job(sys.argv[2])
        return
    ensure_dirs()
    while True:
        try:
            request = read_message()
        except Exception as exc:
            write_message({"ok": False, "error": "bad message: %r" % (exc,)})
            return
        if request is None:
            return
        try:
            response = handle(request)
        except Exception as exc:
            response = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
        try:
            write_message(response)
        except Exception:
            return


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""宿主生成的 yt-dlp 命令行**可执行性**检查。

1.9.3 实测（我自己造的 bug）：给 yt-dlp 传了裸 `--retry-sleep linear`，
而 `linear` 必须带参数（`linear=START[:END[:STEP]]`，如 `linear=1::2`）。
yt-dlp 于是直接

  Usage: yt-dlp [OPTIONS] URL [URL...]
  yt-dlp: error: invalid http retry sleep expression 'linear'

以**退出码 2** 收场，一个字节都没下到。宿主侧完全看不出问题 ——
它只是"起了一个进程，进程很快退了"；面板只显示「失败」。

这类 bug 的特点是**看起来完全正常**：参数名对、值"看起来像"个合法值。
所以断言必须落到"yt-dlp 本体认不认"上，而不是"字符串长不长"。
"""
import io
import json
import os
import re
import subprocess
import sys

# ⚠️ ROOT 必须**从本文件推导**，不能硬编码绝对路径。
#    反向验证会把源码复制到临时目录再在那里跑本脚本；硬编码会让脚本读回
#    仓库里的原件，于是"打了补丁的副本"根本没被检查 —— R30 就这样成了装饰
#    （手动跑全过、rev 却报"被抓住"，两边矛盾）。
#    脚本在 <root>/test/，源码在 <root>/native/。
import os as _os

HERE = _os.path.dirname(_os.path.abspath(__file__))
ROOT = _os.path.dirname(HERE)

PY = _os.environ.get('MG_PY') or _os.path.join(
    _os.path.expanduser('~'), '.workbuddy/binaries/python/versions/3.13.12/bin/python3')
YTDLP = '/opt/homebrew/bin/yt-dlp' 

out = subprocess.run(
    [PY, '-c',
     'import importlib.util, json\n'
     'spec = importlib.util.spec_from_file_location("mh", "native/mediagrab_host.py")\n'
     'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n'
     'print(json.dumps(m.base_args({"quality": "480p"}, "download")))'],
    cwd=ROOT, capture_output=True, text=True, timeout=60)
args = json.loads(out.stdout.strip())

print('生成的下载参数：')
print(' ', ' '.join(args))
print()

fails = 0


def check(name, cond, extra=''):
    global fails
    if not cond:
        fails += 1
    print('%s  %s%s' % ('PASS' if cond else 'FAIL', name, ('  ' + extra) if extra else ''))


def value_of(flag):
    return args[args.index(flag) + 1] if flag in args else None


# ---- 1. 关键开关存在 ----
check('--retry-sleep 存在（没有退避时重试全撞同一个坏连接）', '--retry-sleep' in args)
check('--socket-timeout 已放宽到 60', value_of('--socket-timeout') == '60',
      value_of('--socket-timeout') or '缺失')
check('--ffmpeg-location 指向真实存在的文件',
      os.path.exists(value_of('--ffmpeg-location') or ''),
      value_of('--ffmpeg-location') or '缺失')

# ---- 2. 值必须是"完整表达式"（1.9.3 的教训就在这里）----
#    yt-dlp 的 --retry-sleep 取值形式：
#      纯数字        2
#      linear=1::2   线性递增
#      exp=1:20      指数递增
#      还能带前缀    fragment:exp=1:20 / http:linear=1::5
#    裸 `linear` / 裸 `exp` 会被判成"无效表达式"。
#    ⚠️ 别用 ^(linear|exp)?=? 那种写法去匹配 —— `linear=1::2` 的数字在 '='
#    之后，那条正则会漏掉后半段而把合法值判成可疑（第一版就栽在这）。
SLEEP_OK = re.compile(r'^(?:(http|fragment|file_access|extractor):)?'
                      r'(?:[\d.]+|(?:linear|exp)=[\d.:]*)$')

bad = []
for i, a in enumerate(args):
    if a == '--retry-sleep':
        v = args[i + 1] if i + 1 < len(args) else ''
        if not SLEEP_OK.match(v):
            bad.append(v)
check('--retry-sleep 的值是完整表达式（裸 linear/exp 会被 yt-dlp 拒绝）',
      not bad, '可疑值：%s' % bad)

# ---- 3. 终局判据：把参数原样喂给本机 yt-dlp ----
#    --simulate + 一个不可达 URL：只验"参数能不能被解析"。参数解析失败会在
#    解析阶段立刻报 invalid ... expression / Unrecognized arguments 并退 2。
r = subprocess.run([YTDLP] + args + ['--simulate', 'https://example.invalid/x'],
                   capture_output=True, text=True, timeout=120)
err = r.stderr or ''
check('本机 yt-dlp 接受这套参数（--simulate 不报参数错误）',
      'invalid http retry sleep' not in err and 'Unrecognized arguments' not in err,
      (err.strip().splitlines() or [''])[-1][:110])
check('退出码不是「参数解析失败」的 2', r.returncode != 2, str(r.returncode))

print()
print('全部通过' if not fails else '%d 项失败' % fails)
sys.exit(1 if fails else 0)
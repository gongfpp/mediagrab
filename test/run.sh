#!/bin/bash
# 一条命令跑完全部验证。用法：
#
#   bash test/run.sh
#
# 三段：
#   1. 语法检查（extension/*.js + manifest.json）
#   2. 五套测试：netlog / sites / hooks / rangeFetch / flow
#      —— flow 那套是端到端仿真（真 content.js + 桩 DOM/OPFS/tweb 端点），
#         覆盖的正是以前只能靠你在浏览器里手点才能发现的问题
#   3. 四组反向验证：把代码改回旧行为，确认对应测试**真的会失败**
#      ——「测试全过」本身不构成证据，这条是本项目每轮改动的收尾动作
#
# 退出码 0 = 全绿；非 0 = 有失败项（末尾会列清单）。
#
# 可用环境变量：
#   MG_NODE  指定 node（默认取 PATH 上的 node，取不到则用托管版本）
#   MG_PY    指定 python3（反向验证的补丁脚本用）

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

# ---- 运行时定位 ----------------------------------------------------------
if [ -z "${MG_NODE:-}" ]; then
  for cand in node; do
    if command -v "$cand" >/dev/null 2>&1; then MG_NODE="$cand"; break; fi
  done
fi
if [ -z "${MG_NODE:-}" ]; then echo "找不到 node，请设 MG_NODE"; exit 2; fi

if [ -z "${MG_PY:-}" ]; then
  for cand in python3; do
    if command -v "$cand" >/dev/null 2>&1; then MG_PY="$cand"; break; fi
  done
fi

FAILED=0
note () { printf '\n\033[1m%s\033[0m\n' "$1"; }
bad  () { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=$((FAILED + 1)); }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$1"; }

# ---- 1. 语法 -------------------------------------------------------------
note "1/3 语法检查"
for f in extension/*.js; do
  if "$MG_NODE" --check "$f" >/dev/null 2>&1; then ok "$f"; else bad "$f 语法错误"; fi
done
if "$MG_NODE" -e "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8'))" 2>/dev/null; then
  ok "extension/manifest.json"
else
  bad "manifest.json 解析失败"
fi

# ---- 2. 测试 -------------------------------------------------------------
note "2/3 测试套件"
TOTAL_PASS=0
for t in test/*.test.mjs; do
  name="$(basename "$t")"
  out="$("$MG_NODE" "$t" 2>&1)"
  code=$?
  n="$(printf '%s\n' "$out" | grep -c '^PASS' || true)"
  TOTAL_PASS=$((TOTAL_PASS + n))
  if [ $code -eq 0 ]; then
    ok "$(printf '%-22s %3d 项断言' "$name" "$n")"
  else
    bad "$(printf '%-22s %3d 项断言，失败：' "$name" "$n")"
    printf '%s\n' "$out" | sed -n '/项失败/,$p' | sed 's/^/      /' | head -20
  fi
done
# 宿主生成的 yt-dlp 命令行必须**本机 yt-dlp 真能接受**。
# 这是独立的检查（要真的起 yt-dlp --simulate），所以不放进 *.test.mjs 里 ——
# 1.9.3 实测教训：裸 `--retry-sleep linear` 会让 yt-dlp 以退出码 2 收场，
# 而参数名对、值"看起来像"合法值，任何字符串断言都看不出来。
if [ -f test/hostargs.test.py ]; then
  hout="$("$MG_PY" test/hostargs.test.py 2>&1)"
  if [ $? -eq 0 ]; then
    ok "$(printf '%-22s %3d 项检查' hostargs.test.py "$(printf '%s\n' "$hout" | grep -c '^PASS' || true)")"
  else
    bad "hostargs.test.py —— 宿主命令行的 yt-dlp 参数不可用："
    printf '%s\n' "$hout" | grep '^FAIL' | sed 's/^/      /' | head -10
  fi
fi

printf '  —— 合计 %d 项断言\n' "$TOTAL_PASS"

# ---- 3. 反向验证 ---------------------------------------------------------
# 每组都问同一个问题：这条测试**能不能抓住**对应的旧 bug？抓不住就是装饰。
note "3/3 反向验证（改回旧行为，确认测试会失败）"
if [ -z "${MG_PY:-}" ]; then
  bad "找不到 python3，反向验证跳过（设 MG_PY 可恢复）"
else
TMP="$(mktemp -d /tmp/mg-reverse.XXXXXX)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# rev <标签> <要改的文件> <原文> <改后> [跑哪套测试]
# 默认跑 flow.test.mjs；改动落在别的模块时要把套件名写对，否则会出现
# 「改回旧行为后测试仍然全过」的假警报（那说明测的不是这条不变量）。
rev () {
  local label="$1" file="$2" from="$3" to="$4"
  local suite="${5:-flow.test.mjs}"
  local dir="$TMP/$(printf '%s' "$label" | md5)"
  rm -rf "$dir"; mkdir -p "$dir"
  # ⚠️ native/ 也要复制：宿主（mediagrab_host.py）同样是可测的代码，
  #    只复制 extension 会让改 native/ 的反向验证**必然打不上补丁**
  #    （R30 就这样失效过一次，症状是"补丁没打上（源码变了？）"）。
  cp -R extension test native "$dir/" 2>/dev/null

  # ⚠️ `$file` 是**相对仓库根**的路径（`extension/content.js` 或
  #    `native/mediagrab_host.py`），这里直接拼，**不要**硬编码 `extension/`。
  #    硬编码后传 native/… 会去找 extension/native/…（不存在），症状是
  #    「补丁没打上（源码变了？）」—— R30 连续失效两次就是这里。
  if ! TARGET="$dir/$file" FROM="$from" TO="$to" "$MG_PY" - <<'PYEOF' 2>/dev/null
import os, sys
p = os.environ['TARGET']
s = open(p, encoding='utf-8').read()
a, b = os.environ['FROM'], os.environ['TO']
if a not in s:
    sys.exit(3)
open(p, 'w', encoding='utf-8').write(s.replace(a, b, 1))
PYEOF
  then
    bad "$label —— 补丁没打上（源码变了？）这条反向验证已失效，请更新 run.sh"
    return
  fi

  # ⚠️ 打完补丁**必须**先过语法检查，而且要**按文件类型选检查器**：
  #    `node --check` 只认 JS，喂 Python 会误报（而 R30 改的正是 Python）。
  #    教训：补丁把源码改出 SyntaxError → 测试零输出 → 判定"静默退出"时
  #    `^Error:` 匹配不到 `SyntaxError:` → **假警报**（报"被抓住"，其实无效）。
  case "$file" in
    *.py) SYNTAX_OK="$MG_PY -m py_compile" ;;
    *)    SYNTAX_OK="$MG_NODE --check" ;;
  esac
  if ! $SYNTAX_OK "$dir/$file" >/dev/null 2>&1; then
    bad "$label —— 补丁把 $file 改出了语法错误，这条反向验证无效（请原地替换完整语句，别靠插一行）"
    return
  fi

  # ---- 跑被打了补丁的那套测试 -------------------------------------------
  #
  # ⚠️ macOS 没有 coreutils 的 `timeout`，这里自己实现一个看门狗。
  #    必须有：去掉请求超时之后，那条「请求永久挂起」的用例会**永远等下去**
  #    （1.8.0 实测「进度停在 30% 不动」的形态），没有看门狗整个验证会挂住。
  #
  # 套件按扩展名选运行器：`*.test.py` 是 python 的（宿主参数检查会真的起
  # yt-dlp，不能塞进 *.test.mjs）。用错运行器会立刻"零输出"，
  # 而零输出又会被判成"静默退出 = 被抓住" —— 又一次假警报。
  local outfile="$TMP/rev-out.$$"
  case "$suite" in
    *.py) RUNNER="$MG_PY" ;;
    *)    RUNNER="$MG_NODE" ;;
  esac
  ( cd "$dir" && $RUNNER "test/$suite" >"$outfile" 2>&1 ) &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge 30 ]; then
      kill -9 "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      ok "$label → 被抓住：进程卡死 30 秒仍不返回（病根原样复现）"
      return
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null
  local out
  out="$(cat "$outfile" 2>/dev/null)"

  # ---- 判断"是否被抓住" --------------------------------------------------
  #
  # 有**三种**形态都算抓住，只认 `^FAIL` 会漏掉后两种（这是本项目最贵的教训）：
  #   1. FAIL          —— 断言失败
  #   2. Error:        —— 抛错中断（比如续传被误判成"字节数与文件声明不符"）
  #   3. **零汇总行**  —— 退出码 0、什么都没打印。链路全是 promise 时事件循环
  #      空掉后 Node 会静默退出；去掉请求超时正是这个形态。
  #      判断依据是"没有汇总行"，不是退出码。
  local names
  names="$(printf '%s\n' "$out" | sed -n '/项失败/,$p' | grep '·' | head -3 \
           | sed 's/^ *· / · /' | tr '\n' ' ')"
  # rangeFetch / hooks 的汇总没有 · 前缀，退化成直接列 FAIL 行
  if [ -z "$names" ]; then
    names="$(printf '%s\n' "$out" | grep '^FAIL' | head -3 \
             | sed 's/^FAIL  / · /' | cut -c1-80 | tr '\n' ' ')"
  fi

  if [ -n "$names" ]; then
    ok "$label → 被抓住：$names"
  elif printf '%s\n' "$out" | grep -qE '^(Error|SyntaxError|TypeError|ReferenceError):'; then
    # ⚠️ 必须用 `printf | grep` 而不是 `grep ... "$out"`：后者把**内容**当成
    #    文件名，在没有同名文件时静默返回空 —— 这会让这条分支永远走不到
    #    （与之前那次 `$out` 撞名同类的坑，只是方向相反）。
    ok "$label → 被抓住：$(printf '%s\n' "$out" | grep -m1E '^(Error|SyntaxError|TypeError|ReferenceError):' | cut -c1-90)"
  elif printf '%s\n' "$out" | grep -q '全部通过\|项失败'; then
    bad "$label → 改回旧行为后测试仍然全过，说明这条测试是装饰"
  else
    ok "$label → 被抓住：零汇总输出（静默退出 = 病根复现）"
  fi
  rm -f "$outfile"
}

rev "R1 建写入器挪到探测之前（v1.5.0 另存为弹两次的错）" extension/content.js \
"        const probe = await probeStream(cand.url);" \
"        try { await (await (await navigator.storage.getDirectory()).getFileHandle('pre-probe.part', { create: true })).createWritable(); } catch (e) {}
        const probe = await probeStream(cand.url);"

rev "R2 整片失败自动改用播放器缓存（静默降级）" extension/content.js \
"      offerMseFallback(failures.join('；'));" \
"      await captureMseFile({ declared: lastDeclaredBytes, reason: failures.join('；') });
      offerMseFallback(failures.join('；'));"

rev "R3 Range 一律发开区间（v1.4.0 每轮 1 字节的错）" extension/rangeFetch.js \
'      const range = total === null
        ? `bytes=${offset}-`
        : `bytes=${offset}-${Math.min(offset + chunkSize - 1, total - 1)}`;' \
'      const range = `bytes=${offset}-`;'

rev "R4 运行时流守卫改回看 current.url（老写法从未生效）" extension/content.js \
"    if (current && current.mse === true) return true;
    if (isSameOriginStream((current && current.url) || '')) return true;
    return false;" \
"    return /^blob:/i.test((current && current.url) || '')
      || isSameOriginStream((current && current.url) || '');"

rev "R5 剥掉 ?_crbug1250841 的归一化（会拿到 SW 改过字节的补丁版）" extension/content.js \
"      if (u.searchParams.has('_crbug1250841')) u.searchParams.delete('_crbug1250841');" \
"      // 反向验证：故意不剥"

rev "R6 去掉完整性闸门（字节数与声明不符也照样交付）" extension/rangeFetch.js \
"    if (expectBytes !== null && carried + bytes !== expectBytes) {" \
"    if (false) {   // 反向验证：故意去掉 expectBytes 闸门" \
rangeFetch.test.mjs

rev "R8 暂存写盘失败不翻成人话（用户会误以为是网络问题）" extension/hooks.js \
"    if (Staging && Staging.isQuotaError(err)) return 'quota';" \
"    if (false) return 'quota';"

# ↓ v1.5.2 的病根：隔离世界的 fetch 不被页面 SW 拦截（实测 302 → CDN）。
#   把它改回"只用隔离世界拉"，必须被抓住。
rev "R9 退回隔离世界拉字节（v1.5.2 的病根：SW 不拦截隔离世界的请求）" extension/content.js \
"  function requestMainDownload(rawUrl, opts = {}) {" \
"  function requestMainDownload(rawUrl, opts = {}) {
    if (rawUrl) return Promise.resolve({ ok: false, reason: 'no-main' });"

# 页面世界里的"先探测、再建文件"顺序
rev "R10 页面世界先建写入器再探测（又会留下残骸）" extension/hooks.js \
"    const probe = await dlProbe(url);" \
"    await Staging.open(String(req.filename || 'video.mp4'));
    const probe = await dlProbe(url);"

rev "R11 文件名不取端点 URL 里的原名（/stream/ 的 fileName 被忽略）" extension/content.js \
"    const fromUrl = streamUrlFilename(url);" \
"    const fromUrl = null;"

rev "R12 画质档位映射错位（720p 拿到最高档，摘要与实际下载不符）" extension/content.js \
"  const STREAM_QUALITY_INDEX = { best: 0, 1080: 0, 720: 1, 480: 2 };" \
"  const STREAM_QUALITY_INDEX = { best: 0, 1080: 0, 720: 0, 480: 2 };"

rev "R13 普通直链退回 chrome.downloads（会被下载管理器接管、进度变瞎）" extension/content.js \
"    if (/^https?:/i.test(target.url)) {" \
"    if (false) {"

rev "R14 下载期间禁用按钮（下 A 时切到 B 就下不了）" extension/content.js \
"    resetProgress();
    // ⚠️ 刻意" \
"    resetProgress();
    elGo.disabled = true;
    // ⚠️ 刻意"

rev "R15 文件名退回页面标题（产出 Telegram_Web.mp4）" extension/content.js \
"    const title = meaningfulTitle(pageTitle());" \
"    const title = String(pageTitle() || '').trim();"

rev "R16 候选挑选退回按体积猜（下错视频、清晰度乱跳）" extension/content.js \
"    let freshest = cands[0];
    for (const c of cands) if (at(c) >= at(freshest)) freshest = c;" \
"    let freshest = cands.slice().sort((a, b) => streamSizeOf(b) - streamSizeOf(a))[0];"

rev "R17 去掉已下过守卫（同一个文件跑两遍）" extension/content.js \
"        const already = deliveredStreams.get(cand.url);" \
"        const already = null;"

# ↓ v1.8.1：下载卡在 30% 不动 + 刷新即静默重置

rev "R18 去掉每轮请求的超时（挂起即永久卡死）" extension/rangeFetch.js \
"    if (typeof setTimeout !== 'function') return promise;" \
"    if (true) return promise;   // 反向验证：假装没有超时能力" \
rangeFetch.test.mjs

rev "R19 完整性闸门不把续传字节算进去（续传被误判成字节不足）" extension/rangeFetch.js \
"    if (expectBytes !== null && carried + bytes !== expectBytes) {" \
"    if (expectBytes !== null && bytes !== expectBytes) {" \
rangeFetch.test.mjs

rev "R20 续传不保已有字节（刷新后 createWritable 抹平暂存，从头再来）" extension/staging.js \
"      const writable = await fileHandle.createWritable(
        resumeFrom ? { keepExistingData: true } : undefined
      );" \
"      const writable = await fileHandle.createWritable();"

rev "R21 任务不落 sessionStorage（刷新后静默归零，用户只能猜）" extension/content.js \
"      sessionStorage.setItem(JOB_STORE_KEY, JSON.stringify(list));" \
"      void list;   // 反向验证：不持久化"

rev "R22 中断混同成普通失败（说清'没在后台继续'的那句话没了）" extension/content.js \
"        done: 'interrupted'," \
"        done: 'failed',   // 反向验证"

rev "R23 中断的历史任务把'忙'顶起来（回到 1.7.0'下不了'的坑）" extension/content.js \
"    const busy = runningActiveCount() > 0 || !!elGo.disabled;" \
"    const busy = runningActiveCount() + resumedJobs.length > 0 || !!elGo.disabled;"

# ↓ v1.9.1：yt-dlp 通道连点两次（Errno 2）+ 面板永久停在"正在启动"

rev "R24 yt-dlp 通道不挡第二次点击（两个进程抢同一个 .part -> Errno 2）" extension/content.js \
"    if (isRunningYtdlp(key)) {" \
"    if (false) {"

rev "R25 render 不认 download 阶段（面板永久停在'正在启动'）" extension/content.js \
"    } else if (job.phase === 'running' || job.phase === 'browser' || job.phase === 'download') {" \
"    } else if (job.phase === 'running' || job.phase === 'browser') {"

rev "R26 tick 之后不 publish（popup 与角标读到的快照永远是旧值）" extension/content.js \
"    // 只是渲染结果从来没被上报出去。
    publish(true);" \
"    // 只是渲染结果从来没被上报出去。
    // 反向验证 R26：tick 不再上报
    // publish(true);"

# ↓ v1.9.2：B 站 yt-dlp 失败全是英文原文 + 摘要报假的"整片大小"

# ⚠️ 这条补丁必须**真的换位置**：删掉原位的笼统规则、插到最前面。
#    第一版写成"原地替换成同一条规则" —— 位置没变、语义没变，是**空操作**，
#    断言恒真（被"仍然全过"照出来了）。反向验证里"空操作"和"装饰"一样有害。
rev "R27 瞬时网络故障排在笼统规则之后（Read timed out 拿不到'重试即可'）" extension/content.js \
"    [/Unable to download webpage|Failed to resolve|getaddrinfo|Temporary failure in name resolution/i,
      'yt-dlp 打不开这个页面。若上面已说明是超时/连接中断，重试即可；'
      + '否则检查网络或代理'],
" \
"    [/Unable to rename file/i,
      '下载完成时改名失败（两个进程抢同一个临时文件）。'
      + '本扩展已加了去重守卫，若仍出现请检查是否另有一个 yt-dlp 在跑；'
      + '临时文件可安全删除'],
" \
"    [/Unable to rename file/i,
      '下载完成时改名失败（两个进程抢同一个临时文件）。'
      + '本扩展已加了去重守卫，若仍出现请检查是否另有一个 yt-dlp 在跑；'
      + '临时文件可安全删除'],
    [/Unable to download webpage/i,
      'REVERSE 笼统在前',],
"

rev "R28 Errno 2 改名失败不翻成人话" extension/content.js \
"    [/Unable to rename file/i," \
"    [/__never_matches_rename__/i,"

rev "R29 ytdlpOnly 站点仍报同源流端点与整片大小（B 站报假的 31MiB）" extension/content.js \
"      variants: (current && current.ytdlpOnly === true) ? [] : (() => {" \
"      variants: (() => {"

rev "R30 退回裸 --retry-sleep linear（yt-dlp 退出码 2，一个字节都下不到）" native/mediagrab_host.py \
'"--retry-sleep", "linear=1::2",' \
'"--retry-sleep", "linear",' \
hostargs.test.py

# ⚠️ 下面两条守的是"两类不同的失败别被混成一条"，锚点/替换值一律用 shell
#    **单引号**串（里面含双引号与反斜杠；用双引号串会被 shell 吃掉一层转义）。
#    Unsupported URL          = **输入地址**不认识 → 要换浏览器下载通道
#    invalid ... expression  = **命令行参数**写错了 → 重试毫无意义
#    混起来会把用户引向相反方向（1.9.3 踩过）。
# ⚠️ 单引号串里 shell **不做转义**，所以 `\w` 要原样写成 `\w`（一个反斜杠）。
#    写成 `\\w` 会传成两个反斜杠，与源码不匹配 → 补丁打不上（R31/R32 曾因此失效）。
# ⚠️ R31/R32 的锚点是**含反斜杠的正则行**。
#    手抄必然出错（1.9.3 栽过：锚点 96 字符、源码 94，补丁怎么都打不上）。
#    下面两行的 FROM 是从源码那一行逐字节复制来的。
rev "R31 参数规则误吞 Unsupported URL（把用户引向相反方向）" extension/content.js \
'    [/Unrecognized arguments|invalid http retry sleep|invalid \w+ expression|^Usage: yt-dlp/i,' \
'    [/Unsupported URL|Unrecognized arguments|invalid http retry sleep|^Usage: yt-dlp/i,'

rev "R32 参数错误不被识别（用户只会一遍遍重试）" extension/content.js \
'    [/Unrecognized arguments|invalid http retry sleep|invalid \w+ expression|^Usage: yt-dlp/i,' \
'    [/NEVER_MATCHES_ARG_ERROR_1e9/i,'

# R33 守的是"代理挂了"与"网络抖动"必须分开：前者**重试无用**
#（该去修 Clash 节点），后者才该说"直接再点一次"。混起来会让用户一直白点。
# 锚点逐字节取自 content.js 那一行，不手抄（含反斜杠，手抄必错）。
rev "R33 代理层失败被当成网络抖动（用户被导向死路）" extension/content.js \
'    [/Unable to connect to proxy|Tunnel connection failed|ProxyError|502 Bad Gateway/i,' \
'    [/__never_matches_proxy_1e9/i,'

rev "R7 MSE 重复初始化段不去重（80MB 只播 5 秒的成因）" extension/hooks.js \
"    const fix = stripExtraInit(best.chunks);" \
"    const fix = { chunks: best.chunks, dropped: 0, droppedBytes: 0 };" \
hooks.test.mjs

fi  # MG_PY

# ---- 结论 ---------------------------------------------------------------
printf '\n'
if [ $FAILED -eq 0 ]; then
  printf '\033[32m全部通过\033[0m —— 语法 + %d 项断言 + 反向验证\n' "$TOTAL_PASS"
  exit 0
fi
printf '\033[31m%d 项检查未通过\033[0m（详见上方）\n' "$FAILED"
exit 1

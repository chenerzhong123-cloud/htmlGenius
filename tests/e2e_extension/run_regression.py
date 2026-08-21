#!/usr/bin/env python3
"""htmlGenius v0.9.17 扩展核心功能回归 E2E v2(Playwright + 自带 Chromium 加载未打包扩展)。

v2 修正:激活页管理(facet 操作前 bring_to_front)、SW 主动唤醒后再断言、
localhost 夹具=本地 artifact(send_hint 应隐藏)、失败时自动 dump 诊断。

用法: uv run python tests/e2e_extension/run_regression.py
"""
import hashlib
import http.server
import json
import pathlib
import shutil
import socket
import sys
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
EXT = ROOT / "extension"
PROFILE = pathlib.Path("/tmp/hg-e2e-profile")
FILE_TARGET = (ROOT / "docs" / "script-team-demo-2026-08-19.html").resolve()
RESULTS = []


def report(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"{'✅' if ok else '❌'} {name}" + (f" — {detail}" if detail else ""), flush=True)


def ext_id_from_manifest_key() -> str:
    import base64
    key = json.load(open(EXT / "manifest.json"))["key"]
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def free_port() -> int:
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class HttpFileServer(threading.Thread):
    def __init__(self, root):
        super().__init__(daemon=True)
        self.port = free_port(); self._srv = None; self.root = root

    def run(self):
        h = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(self.root), **kw)
        self._srv = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), h)
        self._srv.serve_forever()

    def stop(self):
        if self._srv: self._srv.shutdown()


def select_text(page, selector, start=0, length=12):
    page.evaluate(
        """([sel, s, n]) => {
            const el = document.querySelector(sel); const node = el.firstChild;
            const range = document.createRange();
            range.setStart(node, s); range.setEnd(node, Math.min(n, node.length));
            const s2 = window.getSelection(); s2.removeAllRanges(); s2.addRange(range);
        }""", [selector, start, length])


def cs_marker_seen(page):
    return any("[hg] cs loaded" in m.text for m in page.console_messages())


def via_active_tab(sp, msg):
    """从扩展页向当前活动 tab 发消息(与产品路径一致)。"""
    return sp.evaluate(
        """async (msg) => {
            const tabs = await chrome.tabs.query({active:true, currentWindow:true});
            if (!tabs.length) return {err: 'no tab'};
            try { return await chrome.tabs.sendMessage(tabs[0].id, msg); }
            catch (e) { return {err: String(e && e.message || e)}; }
        }""", msg)


def enable_file_access_pref(ext_id):
    pref = PROFILE / "Default" / "Preferences"
    prefs = json.loads(pref.read_text())
    st = prefs.setdefault("extensions", {}).setdefault("settings", {}).setdefault(ext_id, {})
    st["newAllowFileAccess"] = True; st["file_access"] = True
    pref.write_text(json.dumps(prefs))
    print(f"   [prefs] file access 开关已写入({ext_id})")


def dump_state(tag, sp, page, errors):
    print(f"   ── dump[{tag}] ──")
    if page:
        print("   page errors:", [m.text for m in page.console_messages() if m.type == "error"][:5])
    if sp:
        print("   sp errors:", [m.text for m in sp.console_messages() if m.type == "error"][:5])
        print("   sp draft-host:", (sp.locator("#draft-host").inner_text() or "")[:80].replace("\n", "|"))
    print("   collected pageerrors:", errors[:5])


def run_phase(tag, http_url, do_edit_and_contract=True):
    ctx_errors = []
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE), headless=False,
            ignore_default_args=["--disable-extensions"],
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
                  "--no-first-run", "--no-default-browser-check"],
            viewport={"width": 1440, "height": 950},
        )
        ctx.set_default_timeout(8000)
        def wire(pg):
            pg.on("pageerror", lambda e: ctx_errors.append(f"pageerror: {e}"))
            pg.on("dialog", lambda d: d.dismiss())
        ctx.on("page", wire)
        import subprocess as _sp
        def _watchdog():
            print(f"   [watchdog] {tag} 超时,强杀浏览器", flush=True)
            _sp.run(["pkill", "-9", "-f", "hg-e2e-profile"])
        wd = threading.Timer(180, _watchdog); wd.daemon = True; wd.start()
        sp = page = fpage = None
        try:
            # 扩展页(sidepanel 作为 tab)
            sp = ctx.new_page()
            ext_id = ext_id_from_manifest_key()
            sp.goto(f"chrome-extension://{ext_id}/sidepanel.html")
            sp.wait_for_timeout(1500)
            report(f"[{tag}] sidepanel 页加载", sp.locator("#tabbar").count() == 1)

            # SW:主动唤醒(未知消息类型即可;绝不能 await bridge-query-providers——会触发 provider 探测,本机装 bridge 时长达数十秒)
            sp.evaluate("(chrome.runtime.sendMessage({type:'hg-e2e-wake'},()=>void chrome.runtime.lastError), 'sent')")
            time.sleep(2)
            sws = ctx.service_workers
            report(f"[{tag}] SW 唤醒启动", any(s.url.startswith(f"chrome-extension://{ext_id}/") for s in sws),
                   f"count={len(sws)}")
            sw = next((s for s in sws if s.url.startswith(f"chrome-extension://{ext_id}/")), None)
            analytics_ready = bool(sw and sw.evaluate("typeof globalThis.HGAnalyticsCore === 'object'"))
            report(f"[{tag}] SW 加载 analytics core", analytics_ready, f"ready={analytics_ready}")

            regs = sp.evaluate("async()=>{if(!chrome.scripting?.getRegisteredContentScripts)return [];try{return await chrome.scripting.getRegisteredContentScripts()}catch(e){return ['ERR:'+e.message]}}")
            report(f"[{tag}] 未使用动态注册(revert 干净)", isinstance(regs, list) and len(regs) == 0, json.dumps(regs)[:100])

            # --- http 注入 ---
            page = ctx.new_page()
            page.goto(http_url); page.wait_for_timeout(1800)
            page.bring_to_front(); time.sleep(0.3)
            ok_http = cs_marker_seen(page)
            r = via_active_tab(sp, {"type": "get-annotations"})
            report(f"[{tag}] http 注入+响应", ok_http and r.get("type") == "annotations-list",
                   f"cs={ok_http} resp={r.get('type') or r.get('err')}")

            # --- D 评论流 ---
            # 以扩展页模拟 Side Panel 时，重点验证用户可见链路：选区浮窗 → 点击评论 → 草稿框出现。
            # 提交落库另由服务器/UI 测试覆盖；这里不要再依赖“活动 tab”这一与真实 Side Panel 不同的测试环境细节。
            if ok_http:
                select_text(page, "#p1", 0, 10)
                time.sleep(0.6)
                bb = page.locator('#hg-toolbar button[data-act="comment"]').bounding_box()
                shown = bb is not None
                report(f"[{tag}] 选区浮出工具栏", shown)
                broadcast_ok = False
                if shown:
                    page.mouse.click(bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2)
                    time.sleep(1.0)
                    sel_cleared = page.evaluate("getSelection().toString()") == ""
                    draft_visible = sp.locator("#draft-host .draft-card").count() == 1
                    broadcast_ok = sel_cleared and draft_visible
                    if not broadcast_ok:
                        dump_state("comment", sp, page, ctx_errors)
                report(f"[{tag}] 评论:工具栏点击→侧栏草稿框", broadcast_ok,
                       f"draft_visible={broadcast_ok}")
                if broadcast_ok:
                    sp.locator(".draft-input").fill("E2E 回归评论:这段要改")
                    sp.locator(".draft-save").click()
                    time.sleep(1.0)
                # 回到编辑页，避免草稿卡让后续编辑流的按钮处于隐藏 tab。
                sp.locator("#tab-edit").click()

            # --- B/C file:// 注入(用户症状页) ---
            # 模拟已登录团队账号：file:// 仍必须强制走本地评论，不发 RemoteStore/SSE。
            sp.evaluate("""async () => new Promise(resolve => chrome.storage.local.set({
                mode: 'synced', backend: 'https://example.invalid', session_token: 'test-token',
                user: {id: 'test-user', name: 'Test'}
            }, resolve))""")
            fpage = ctx.new_page()
            fpage.goto(FILE_TARGET.as_uri()); fpage.wait_for_timeout(1800)
            fpage.bring_to_front(); time.sleep(0.3)
            ok_file = cs_marker_seen(fpage)
            fr = via_active_tab(sp, {"type": "get-annotations"})
            report(f"[{tag}] file:// 注入(脚本文档)", ok_file and fr.get("type") == "annotations-list",
                   f"cs={ok_file} resp={fr.get('type') or fr.get('err')}")
            local_only = any("本地文件不参与团队同步" in m.text for m in fpage.console_messages())
            report(f"[{tag}] file:// 强制本地评论模式", local_only)
            # 本地 HTML 是最容易出现激活竞态的路径：必须验证“选区 → 评论工具栏”真实可用，
            # 不能只验证脚本已注入、消息能响应。
            local_toolbar = False
            if ok_file:
                target = fpage.locator("p").first
                if target.count():
                    fpage.evaluate("""() => {
                        const el = document.querySelector('p'); const node = el && el.firstChild;
                        if (!node) return;
                        const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(8, node.length));
                        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
                    }""")
                    fpage.wait_for_timeout(500)
                    local_toolbar = fpage.locator('#hg-toolbar.show button[data-act="comment"]').count() == 1
            report(f"[{tag}] file:// 选区显示评论工具栏", local_toolbar)
            # 保持下一个浏览器 phase 的 HTTP fixture 为离线本地模式；当前 file:// 页已经完成了本轮断言。
            sp.evaluate("""async () => new Promise(resolve => chrome.storage.local.set({
                mode: 'local', session_token: '', user: null
            }, resolve))""")

            # 独立扩展页在 Playwright 中会成为 active tab，而真实 Side Panel 不会；
            # 这会让依赖 active tab 的编辑/契约按钮错误地指向扩展页。此环境仅执行
            # 可忠实模拟的页面评论链路，编辑/契约由各自的单元测试覆盖。
            standalone_extension_tab = sp.evaluate("""async () => {
                const me = await chrome.tabs.getCurrent();
                const active = (await chrome.tabs.query({active:true, currentWindow:true}))[0];
                return !!(me && active && me.id === active.id);
            }""")
            # --- E 编辑流(先切回 fixture 活动页!) ---
            if do_edit_and_contract and ok_http and not standalone_extension_tab:
                page.bring_to_front(); time.sleep(0.3)
                sp.locator("#edit-btn").click(); time.sleep(0.8)
                er = via_active_tab(sp, {"type": "get-annotations"})
                editing = bool(er.get("editing"))
                report(f"[{tag}] 进入编辑态(content-script 确认)", editing, f"editing={er.get('editing')}")
                if editing:
                    select_text(page, "#p2", 0, 6); time.sleep(0.3)
                    sp.locator("#act-bold").click(); time.sleep(0.5)
                    w = page.evaluate("()=>{const b=document.querySelector('#p2 b')||document.querySelector('#p2 font[weight]');return b?getComputedStyle(b).fontWeight:'none'}")
                    report(f"[{tag}] 加粗生效", w in ("700", "bold"), f"fontWeight={w}")
                    sp.locator("#act-undo").click(); time.sleep(0.5)
                    back = page.evaluate("()=>!document.querySelector('#p2 b')")
                    report(f"[{tag}] 撤销还原", back)
                    sp.locator("#act-reset").click(); time.sleep(0.5)

                # --- F 任务流 ---
                sp.locator("#tab-comment").click(); time.sleep(0.3)
                sp.locator("#export-btn").click(); time.sleep(1.0)
                sheet = sp.locator("#contract-sheet")
                step = sheet.get_attribute("data-step")
                radios = sp.locator('input[name="contract-scope"]').count()
                visible_sheet = sheet.is_visible()
                # localhost 夹具=本地 artifact → send_hint 应隐藏(此为正确行为)
                hint = sp.locator("#contract-send-hint").is_visible()
                report(f"[{tag}] 契约页(三档范围/本地文档无发送提示)", visible_sheet and step == "compose" and radios == 3 and not hint,
                       f"step={step} radios={radios} send_hint(应False)={hint}")
                btn_txt = sp.locator("#contract-copy-prompt").inner_text()
                sp.locator("#contract-copy-prompt").click(force=True)
                time.sleep(0.8)
                after = sp.locator("#contract-copy-prompt").inner_text()
                fallback = sp.locator("#contract-output-fallback").is_visible()
                if not (after != btn_txt or fallback):
                    dump_state("contract", sp, page, ctx_errors)
                report(f"[{tag}] 复制 Prompt 反馈", after != btn_txt or fallback, f"'{btn_txt}'→'{after}' fallback={fallback}")

            fatal = [e for e in ctx_errors if "Receiving end does not exist" not in e and "Could not establish connection" not in e]
            report(f"[{tag}] pageerror 零致命", len(fatal) == 0, "; ".join(fatal[:2]))
        finally:
            wd.cancel()
            try: ctx.close()
            except Exception: pass
            time.sleep(1)
            import subprocess as _sp
            _sp.run(["pkill", "-9", "-f", "hg-e2e-profile"], capture_output=True)


def main():
    if PROFILE.exists(): shutil.rmtree(PROFILE)
    PROFILE.mkdir(parents=True)
    srv = HttpFileServer(ROOT / "tests" / "e2e_extension"); srv.start(); time.sleep(0.5)
    http_url = f"http://127.0.0.1:{srv.port}/fixture.html"
    try:
        print("══ Phase A:默认 profile ══")
        run_phase("A", http_url, do_edit_and_contract=False)
        print("\n══ Phase C:显式打开「允许访问文件网址」 ══")
        enable_file_access_pref(ext_id_from_manifest_key())
        run_phase("C", http_url, do_edit_and_contract=False)
    finally:
        srv.stop()
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n════ 总计 {passed}/{len(RESULTS)} 通过 ════")
    for n, ok, d in RESULTS:
        if not ok: print(f"  ❌ {n} {('— ' + d) if d else ''}")
    sys.exit(0 if passed == len(RESULTS) else 1)


if __name__ == "__main__":
    main()

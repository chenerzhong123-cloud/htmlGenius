// i18n.js — htmlGenius 多语言(中/英/日)
// 同时运行于 sidepanel 扩展页(<script>)与 content-script 隔离世界(manifest 注入,在 content-script.js 之前)。
// 两个上下文各自持有一份实例,通过 chrome.storage.local(hg_lang)同步:sidepanel.setLang 写入 → content-script 监听 storage.onChanged 重建。
// 首屏 _lang 先用 detect()(匹配浏览器语言,不匹配默认 en)避免闪烁,init() 再用本地存储的选择覆盖。
(function () {
  "use strict";
  if (window.HG_I18N) return; // 防重复

  var STORAGE_KEY = "hg_lang";
  var ORDER = ["zh", "en", "ja"];

  var DICT = {
    zh: {
      "tab.edit": "编辑",
      "tab.comment": "批注",
      "mode.connecting": "正在连接当前页面…",
      "mode.editingLocal": "编辑中 · 本地文档(可保存)",
      "mode.editingRemote": "临时编辑网页 · 刷新或关闭后会丢失",
      "mode.idleLocal": "本地文档 · 可直接编辑",
      "mode.idleRemote": "普通网页 · 可批注,也可临时编辑",
      "edit.start": "开始编辑",
      "edit.exit": "退出编辑",
      "tool.undo": "撤销",
      "tool.redo": "重做",
      "tool.reset": "还原到本次编辑初始",
      "tool.saveAs": "另存为 HTML",
      "color.text": "文字色",
      "color.highlight": "高亮色",
      "adv.enter": "切换高级模式",
      "adv.exit": "退出高级模式",
      "ep.delete": "删除控件",
      "ep.duplicate": "复制控件",
      "ep.parent": "父级",
      "ep.noSel": "在页面点选一个控件",
      "ep.dragHint": "拖动控件可在同级中重排 · Esc 取消 · Del 删",
      "ep.editText": "编辑文字",
      "style.font": "字体",
      "style.letter": "字间距",
      "style.line": "行距",
      "style.padding": "内边距",
      "emoji.title": "插入表情",
      "edit.confirmRemote": "编辑仅本地临时修改,刷新或关闭页面后丢失,无法保存回原网页。\n\n进入编辑模式?",
      "tips.html": "选中文字可<b>加批注</b>;点「<b>开始编辑</b>」后,选中文字可改<b>样式 / 颜色 / 字号 / 对齐</b>(Ctrl+Z 撤销)",
      "reloadHint": "若批注或编辑长时间无响应,刷新当前页面即可恢复",
      "comment.empty": "选中文字 → 点「批注」",
      "export.btn": "一键复制所有评论",
      "export.copied": "已复制 ✓",
      "export.empty": "暂无批注",
      "presence.online": "在线: ",
      "presence.count": "本页在线 {n} 人",
      "draft.label": "新建批注",
      "draft.placeholder": "写评论…(Enter 保存 · Shift+Enter 换行)",
      "draft.cancel": "取消",
      "draft.save": "保存",
      "reply.placeholder": "回复…(Enter 保存 · Shift+Enter 换行)",
      "delete.confirm": "删除这条?回复一并删除。",
      "delete.cancel": "取消",
      "delete.ok": "确认删除",
      "card.reply": "回复",
      "card.delete": "删除",
      "card.edit": "编辑",
      "toast.editForbidden": "只能编辑自己的评论",
      "card.noComment": "(无评论)",
      "author.fallback": "作者",
      "refresh.title": "刷新网页即可开始编辑",
      "refresh.tipLocal": "TIPS:你现在编辑的是本地网页,编辑后将自动保存",
      "refresh.tipRemote": "TIPS:你现在编辑的是远程网页,编辑只在当前窗口内有效,无法保存到本地",
      "refresh.confirm": "刷新",
      "refresh.cancel": "取消",
      "stale.section": "历史评论",
      "stale.hint": "该评论引用的原文已不在当前页面",
      "stale.purge": "一键删除多余评论",
      "toast.deleteForbidden": "只能删除自己的批注",
      "sheet.title": "登录后开启团队协作",
      "sheet.sub": "实时共享批注 · 作者身份绑定账号 · 仅本人可删自己的批注",
      "avatar.title": "登录与团队",
      "login.lark": "飞书登录",
      "login.google": "Google 登录",
      "login.larkLoading": "飞书登录中…",
      "login.googleLoading": "Google 登录中…",
      "login.larkSuccess": "飞书登录成功",
      "login.googleSuccess": "Google 登录成功",
      "login.fail": "登录失败:",
      "login.okJoinCreate": "登录成功,请加入或新建团队",
      "state.loggedIn": "已登录:",
      "state.loggedOut": "已退出",
      "state.expired": "登录已失效,请重新登录",
      "state.logout": "退出",
      "state.invite": "邀请队友",
      "team.invitePh": "邀请码",
      "team.join": "加入团队",
      "team.create": "+ 新建团队",
      "team.fillInvite": "填邀请码",
      "team.joining": "加入中…",
      "team.joinFail": "加入失败(码无效?)",
      "team.joinSuccess": "已加入团队",
      "team.joinFailMsg": "加入失败:",
      "team.creating": "建团中…",
      "team.createSuccess": "已创建并加入团队",
      "team.createFail": "建团失败",
      "team.invitePrefill": "已填入邀请码,点「Google 登录」→「加入团队」",
      "team.needTeam": "请加入或新建团队",
      "team.inviteCopied": "邀请码已复制:",
      "team.inviteFail": "邀请失败",
      "lang.title": "语言",
      "theme.title": "主题",
      "lang.zh": "中文",
      "lang.en": "English",
      "lang.ja": "日本語",
      // 浮动工具栏
      "tool.comment": "批注",
      "tool.bold": "加粗",
      "tool.italic": "斜体",
      "tool.underline": "下划线",
      "tool.strikethrough": "删除线",
      "tool.color": "文字颜色",
      "tool.highlight": "背景高亮",
      "tool.size": "字号",
      "tool.sizeLabel": "字号",
      "tool.heading": "标题级别",
      "tool.align": "对齐",
      "tool.clear": "清除格式",
      "heading.normal": "正文",
      "heading.h1": "标题 1",
      "heading.h2": "标题 2",
      "heading.h3": "标题 3",
      "align.left": "左对齐",
      "align.center": "居中",
      "align.right": "右对齐",
      "align.justify": "两端对齐",
      "size.sm": "小",
      "size.std": "标准",
      "size.lg": "大",
      "size.xl": "特大"
    },
    en: {
      "tab.edit": "Edit",
      "tab.comment": "Comments",
      "mode.connecting": "Connecting to current page…",
      "mode.editingLocal": "Editing · Local doc (saveable)",
      "mode.editingRemote": "Temporary edit · lost on refresh/close",
      "mode.idleLocal": "Local document · edit directly",
      "mode.idleRemote": "Web page · comment or temporarily edit",
      "edit.start": "Start edit",
      "edit.exit": "Exit edit",
      "tool.undo": "Undo",
      "tool.redo": "Redo",
      "tool.reset": "Restore to initial",
      "tool.saveAs": "Save HTML as",
      "color.text": "Text",
      "color.highlight": "Highlight",
      "adv.enter": "Advanced mode",
      "adv.exit": "Exit advanced",
      "ep.delete": "Delete",
      "ep.duplicate": "Duplicate",
      "ep.parent": "Parent",
      "ep.noSel": "Click an element on the page",
      "ep.dragHint": "Drag to reorder among siblings · Esc to clear",
      "ep.editText": "Edit text",
      "style.font": "Font",
      "style.letter": "Spacing",
      "style.line": "Line height",
      "style.padding": "Padding",
      "emoji.title": "Insert emoji",
      "edit.confirmRemote": "Edits are local and temporary — lost on refresh/close, and cannot be saved back to the original page.\n\nEnter edit mode?",
      "tips.html": "Select text to <b>comment</b>; after <b>Start edit</b>, select text to change <b>style / color / size / alignment</b> (Ctrl+Z to undo)",
      "reloadHint": "If comments or editing stop responding, refresh the page to recover",
      "comment.empty": "Select text → click “Comment”",
      "export.btn": "Copy all comments",
      "export.copied": "Copied ✓",
      "export.empty": "No comments yet",
      "presence.online": "Online: ",
      "presence.count": "Online on this page: {n}",
      "draft.label": "New comment",
      "draft.placeholder": "Write a comment… (Enter to save · Shift+Enter for newline)",
      "draft.cancel": "Cancel",
      "draft.save": "Save",
      "reply.placeholder": "Reply… (Enter to save · Shift+Enter for newline)",
      "delete.confirm": "Delete this? Replies will also be removed.",
      "delete.cancel": "Cancel",
      "delete.ok": "Confirm delete",
      "card.reply": "Reply",
      "card.delete": "Delete",
      "card.edit": "Edit",
      "toast.editForbidden": "You can only edit your own comments",
      "card.noComment": "(no comment)",
      "author.fallback": "Author",
      "refresh.title": "Refresh the page to start editing",
      "refresh.tipLocal": "TIPS: You're editing a local page — edits are saved automatically.",
      "refresh.tipRemote": "TIPS: You're editing a remote page — edits apply only to this window and can't be saved.",
      "refresh.confirm": "Refresh",
      "refresh.cancel": "Cancel",
      "stale.section": "Past comments",
      "stale.hint": "The text this comment referred to is no longer on the page",
      "stale.purge": "Delete all stale",
      "toast.deleteForbidden": "You can only delete your own comments",
      "sheet.title": "Log in for team collaboration",
      "sheet.sub": "Real-time shared comments · authorship tied to account · only you can delete your own",
      "avatar.title": "Account & team",
      "login.lark": "Log in with Lark",
      "login.google": "Log in with Google",
      "login.larkLoading": "Logging in to Lark…",
      "login.googleLoading": "Logging in to Google…",
      "login.larkSuccess": "Lark login successful",
      "login.googleSuccess": "Google login successful",
      "login.fail": "Login failed: ",
      "login.okJoinCreate": "Logged in — join or create a team",
      "state.loggedIn": "Logged in: ",
      "state.loggedOut": "Logged out",
      "state.expired": "Session expired, please log in again",
      "state.logout": "Log out",
      "state.invite": "Invite teammate",
      "team.invitePh": "Invite code",
      "team.join": "Join team",
      "team.create": "+ New team",
      "team.fillInvite": "Enter invite code",
      "team.joining": "Joining…",
      "team.joinFail": "Join failed (invalid code?)",
      "team.joinSuccess": "Joined team",
      "team.joinFailMsg": "Join failed: ",
      "team.creating": "Creating team…",
      "team.createSuccess": "Team created & joined",
      "team.createFail": "Failed to create team",
      "team.invitePrefill": "Invite code filled — click “Log in with Google” → “Join team”",
      "team.needTeam": "Join or create a team",
      "team.inviteCopied": "Invite code copied: ",
      "team.inviteFail": "Invite failed",
      "lang.title": "Language",
      "theme.title": "Theme",
      "lang.zh": "中文",
      "lang.en": "English",
      "lang.ja": "日本語",
      "tool.comment": "Comment",
      "tool.bold": "Bold",
      "tool.italic": "Italic",
      "tool.underline": "Underline",
      "tool.strikethrough": "Strikethrough",
      "tool.color": "Text color",
      "tool.highlight": "Highlight",
      "tool.size": "Font size",
      "tool.sizeLabel": "Size",
      "tool.heading": "Heading level",
      "tool.align": "Align",
      "tool.clear": "Clear format",
      "heading.normal": "Normal",
      "heading.h1": "Heading 1",
      "heading.h2": "Heading 2",
      "heading.h3": "Heading 3",
      "align.left": "Left",
      "align.center": "Center",
      "align.right": "Right",
      "align.justify": "Justify",
      "size.sm": "Small",
      "size.std": "Normal",
      "size.lg": "Large",
      "size.xl": "XL"
    },
    ja: {
      "tab.edit": "編集",
      "tab.comment": "コメント",
      "mode.connecting": "現在のページに接続中…",
      "mode.editingLocal": "編集中 · ローカル文書(保存可)",
      "mode.editingRemote": "ウェブページを一時編集 · 更新または閉じると失われます",
      "mode.idleLocal": "ローカル文書 · 直接編集可",
      "mode.idleRemote": "ウェブページ · コメントや一時編集が可能",
      "edit.start": "編集開始",
      "edit.exit": "編集を終了",
      "tool.undo": "元に戻す",
      "tool.redo": "やり直し",
      "tool.reset": "編集開始時に戻す",
      "tool.saveAs": "HTML として保存",
      "color.text": "文字色",
      "color.highlight": "ハイライト",
      "adv.enter": "高度なモード",
      "adv.exit": "終了",
      "ep.delete": "削除",
      "ep.duplicate": "複製",
      "ep.parent": "親要素",
      "ep.noSel": "ページで要素をクリック",
      "ep.dragHint": "ドラッグで並び替え · Esc で解除",
      "ep.editText": "テキスト編集",
      "style.font": "フォント",
      "style.letter": "字間",
      "style.line": "行高",
      "style.padding": "余白",
      "emoji.title": "絵文字",
      "edit.confirmRemote": "編集はローカルの一時変更で、更新やページを閉じると失われ、元のページには保存できません。\n\n編集モードに入りますか?",
      "tips.html": "テキストを選択して<b>コメント</b>。「<b>編集開始</b>」後、テキストを選択して<b>スタイル / 色 / サイズ / 整列</b>を変更(Ctrl+Z で元に戻す)",
      "reloadHint": "コメントや編集が長時間応答しない場合、ページを更新してください",
      "comment.empty": "テキストを選択 →「コメント」をクリック",
      "export.btn": "すべてのコメントをコピー",
      "export.copied": "コピー済み ✓",
      "export.empty": "コメントはまだありません",
      "presence.online": "オンライン: ",
      "presence.count": "このページで {n} 人オンライン",
      "draft.label": "新規コメント",
      "draft.placeholder": "コメントを入力…(Enter で保存 · Shift+Enter で改行)",
      "draft.cancel": "キャンセル",
      "draft.save": "保存",
      "reply.placeholder": "返信…(Enter で保存 · Shift+Enter で改行)",
      "delete.confirm": "このコメントを削除?返信も削除されます。",
      "delete.cancel": "キャンセル",
      "delete.ok": "削除",
      "card.reply": "返信",
      "card.delete": "削除",
      "card.edit": "編集",
      "toast.editForbidden": "自分のコメントのみ編集できます",
      "card.noComment": "(コメントなし)",
      "author.fallback": "作成者",
      "refresh.title": "ページを更新して編集を開始",
      "refresh.tipLocal": "TIPS: ローカルページを編集中です。編集は自動的に保存されます。",
      "refresh.tipRemote": "TIPS: リモートページを編集中です。編集はこのウィンドウのみ有効で、保存できません。",
      "refresh.confirm": "更新",
      "refresh.cancel": "キャンセル",
      "stale.section": "過去のコメント",
      "stale.hint": "このコメントの元の文章が現在のページにありません",
      "stale.purge": "古いコメントを削除",
      "toast.deleteForbidden": "自分のコメントのみ削除できます",
      "sheet.title": "ログインしてチーム共同編集を開始",
      "sheet.sub": "リアルタイムコメント共有 · 作成者はアカウントに紐付け · 自分のコメントのみ削除可",
      "avatar.title": "ログインとチーム",
      "login.lark": "Lark でログイン",
      "login.google": "Google でログイン",
      "login.larkLoading": "Lark ログイン中…",
      "login.googleLoading": "Google ログイン中…",
      "login.larkSuccess": "Lark ログイン成功",
      "login.googleSuccess": "Google ログイン成功",
      "login.fail": "ログイン失敗: ",
      "login.okJoinCreate": "ログイン成功 — チームに参加または新規作成してください",
      "state.loggedIn": "ログイン済み: ",
      "state.loggedOut": "ログアウトしました",
      "state.expired": "セッションが期限切れです。再ログインしてください",
      "state.logout": "ログアウト",
      "state.invite": "チームメイトを招待",
      "team.invitePh": "招待コード",
      "team.join": "チームに参加",
      "team.create": "+ 新規チーム",
      "team.fillInvite": "招待コードを入力",
      "team.joining": "参加中…",
      "team.joinFail": "参加失敗(コード無効?)",
      "team.joinSuccess": "チームに参加しました",
      "team.joinFailMsg": "参加失敗: ",
      "team.creating": "チーム作成中…",
      "team.createSuccess": "チームを作成して参加しました",
      "team.createFail": "チーム作成に失敗",
      "team.invitePrefill": "招待コードを入力しました。「Google でログイン」→「チームに参加」",
      "team.needTeam": "チームに参加または新規作成してください",
      "team.inviteCopied": "招待コードをコピーしました: ",
      "team.inviteFail": "招待に失敗",
      "lang.title": "言語",
      "theme.title": "テーマ",
      "lang.zh": "中文",
      "lang.en": "English",
      "lang.ja": "日本語",
      "tool.comment": "コメント",
      "tool.bold": "太字",
      "tool.italic": "イタリック",
      "tool.underline": "下線",
      "tool.strikethrough": "取り消し線",
      "tool.color": "文字色",
      "tool.highlight": "背景ハイライト",
      "tool.size": "サイズ",
      "tool.sizeLabel": "サイズ",
      "tool.heading": "見出しレベル",
      "tool.align": "整列",
      "tool.clear": "書式解除",
      "heading.normal": "本文",
      "heading.h1": "見出し 1",
      "heading.h2": "見出し 2",
      "heading.h3": "見出し 3",
      "align.left": "左揃え",
      "align.center": "中央揃え",
      "align.right": "右揃え",
      "align.justify": "両端揃え",
      "size.sm": "小",
      "size.std": "標準",
      "size.lg": "大",
      "size.xl": "特大"
    }
  };

  // 首屏先用浏览器语言,避免 init() 异步读存储期间的闪烁
  var _lang = detect();
  var listeners = [];

  function detect() {
    var langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"]);
    for (var i = 0; i < langs.length; i++) {
      var low = String(langs[i] || "").toLowerCase();
      if (low.indexOf("zh") === 0) return "zh";
      if (low.indexOf("ja") === 0) return "ja";
      if (low.indexOf("en") === 0) return "en";
    }
    return "en";
  }

  function t(key) {
    var tbl = DICT[_lang] || DICT.en;
    if (tbl[key] != null) return tbl[key];
    if (DICT.en[key] != null) return DICT.en[key];
    return key;
  }
  function getLang() { return _lang; }

  function notify() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](_lang); } catch (e) {} } }

  function setLang(l) {
    if (!DICT[l] || l === _lang) { if (DICT[l]) notify(); return; }
    _lang = l;
    try { chrome.storage.local.set({ hg_lang: l }); } catch (e) {}
    notify();
  }

  // 重新读本地存储(跨上下文同步:content-script 监听 storage.onChanged 后调用)
  function reload() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([STORAGE_KEY], function (r) {
          var saved = r && r[STORAGE_KEY];
          if (saved && DICT[saved] && saved !== _lang) { _lang = saved; notify(); }
          resolve(_lang);
        });
      } catch (e) { resolve(_lang); }
    });
  }

  function onChange(fn) { listeners.push(fn); }

  function apply(root) {
    root = root || document;
    root.querySelectorAll("[data-i18n]").forEach(function (el) { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) { el.placeholder = t(el.dataset.i18nPlaceholder); });
    root.querySelectorAll("[data-i18n-title]").forEach(function (el) { el.title = t(el.dataset.i18nTitle); });
    root.querySelectorAll("[data-i18n-html]").forEach(function (el) { el.innerHTML = t(el.dataset.i18nHtml); });
  }

  // 首次:本地存储的选择 > 浏览器语言
  function init() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([STORAGE_KEY], function (r) {
          var saved = r && r[STORAGE_KEY];
          if (saved && DICT[saved]) _lang = saved;
          resolve(_lang);
        });
      } catch (e) { resolve(_lang); }
    });
  }

  window.HG_I18N = { t: t, getLang: getLang, setLang: setLang, reload: reload, onChange: onChange, apply: apply, init: init, detect: detect, ORDER: ORDER, DICT: DICT };
})();

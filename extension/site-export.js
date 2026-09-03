// site-export.js — 整站团队评论转成可直接交给 AI 的多页任务。
(function () {
  "use strict";
  if (window.SiteCommentExport) return;

  function siteOrigin(url) {
    try {
      var parsed = new URL(url);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.origin : null;
    } catch (e) { return null; }
  }

  function cleanItem(item) {
    item = item || {};
    var selector = item.selector || {};
    var body = item.body || {};
    var author = item.author || {};
    return {
      id: String(item.id || ""),
      parent_id: item.parent_id || null,
      author: String(author.name || ""),
      quote: String(item.quote || ""),
      selector: {
        exact: String(selector.exact || ""),
        prefix: String(selector.prefix || ""),
        suffix: String(selector.suffix || ""),
      },
      comment: String(body.comment || ""),
      requested_action: String(body.action || "none"),
      instruction: String(body.instruction || ""),
    };
  }

  function compactBundle(bundle) {
    bundle = bundle || {};
    return {
      site_origin: String(bundle.site_origin || ""),
      exported_comment_count: Number(bundle.total || 0),
      truncated: !!bundle.truncated,
      pages: (bundle.pages || []).map(function (page) {
        return {
          page_url: String(page.document_id || ""),
          path: String(page.path || ""),
          comments: (page.items || []).map(cleanItem),
        };
      }),
    };
  }

  function buildPrompt(bundle, lang) {
    var data = compactBundle(bundle);
    var json = JSON.stringify(data, null, 2);
    if (lang === "zh") {
      return "请修改这个网站对应的源代码，处理下方所有页面评论。\n\n"
        + "要求：\n"
        + "1. 先在代码库中找到每个 page_url 对应的源文件，不要直接修改压缩后的线上产物。\n"
        + "2. 逐页处理 comments；quote 与 selector 用于定位，comment / instruction 是修改要求。\n"
        + "3. 父评论与 parent_id 指向的回复需要结合理解。\n"
        + "4. 不要改动与评论无关的内容；完成后按页面列出修改摘要和未能完成的项。\n"
        + (data.truncated ? "5. 注意：本次导出已达上限，不是完整数据，不要声称已处理全部评论。\n" : "")
        + "\n<htmlgenius_site_feedback>\n" + json + "\n</htmlgenius_site_feedback>";
    }
    if (lang === "ja") {
      return "下記の全ページのコメントに基づき、対応するソースコードを修正してください。\n"
        + "各 page_url の元ファイルをリポジトリ内で特定し、quote/selector で箇所を確認し、comment/instruction を実装してください。関係ない箇所は変更せず、完了後はページごとの変更概要と未完了項目を報告してください。\n\n"
        + "<htmlgenius_site_feedback>\n" + json + "\n</htmlgenius_site_feedback>";
    }
    return "Modify the source code for this website to address every page comment below.\n\n"
      + "First map each page_url to its source file; do not edit minified production output. Use quote and selector to locate the target, and treat comment/instruction as the requested change. Read parent comments together with replies linked by parent_id. Leave unrelated content unchanged. Finish with a page-by-page change summary and list anything you could not complete.\n"
      + (data.truncated ? "Warning: this export reached its size limit and is incomplete; do not claim every comment was handled.\n" : "")
      + "\n<htmlgenius_site_feedback>\n" + json + "\n</htmlgenius_site_feedback>";
  }

  window.SiteCommentExport = {
    siteOrigin: siteOrigin,
    compactBundle: compactBundle,
    buildPrompt: buildPrompt,
  };
})();

(function () {
  var language = localStorage.getItem('htmlgenius-demo-language') || 'zh';
  var labels = { zh: '中文', en: 'English' };
  var logoPath = 'favicon.png'; // favicon.png 与品牌 logo 同源且位于部署根,http/file/扁平部署均可解析(原先指向 assets/... 在扁平部署会 404)
  document.documentElement.style.setProperty('--brand-logo', 'url("' + logoPath + '")');
  // WEB-4: wrapper 切语言时同步 privacy.html 内嵌 policy.html iframe 的 lang 参数,避免切英文后 iframe 仍中文。
  function syncPolicyFrame(lang) {
    var frame = document.querySelector('.policy-frame');
    if (!frame) return;
    var src = frame.getAttribute('src') || '';
    var updated = src.replace(/([?&]lang=)[^&]*/i, '$1' + lang);
    if (updated !== src) frame.setAttribute('src', updated); // 仅在 lang 实际变化时改 src,避免无谓 reload
  }
  syncPolicyFrame(language); // 尽早把 iframe 切到已存语言,减少初始闪动
  function setLanguage(next) {
    language = next;
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
    document.querySelectorAll('[data-zh][data-en]').forEach(function (el) {
      var value = el.dataset[next];
      // A few headlines intentionally contain a styled span. All copy is local,
      // static demo content; use HTML only for those authored headline accents.
      if (value.indexOf('<') !== -1) el.innerHTML = value;
      else el.textContent = value;
    });
    document.querySelectorAll('[data-copy-zh][data-copy-en]').forEach(function (el) { el.dataset.copy = el.dataset[next]; });
    document.querySelectorAll('[data-prompt-zh][data-prompt-en]').forEach(function (el) { el.textContent = el.dataset[next === 'zh' ? 'promptZh' : 'promptEn']; });
    document.querySelectorAll('[data-lang-current]').forEach(function (el) { el.textContent = labels[next]; });
    document.querySelectorAll('[data-language]').forEach(function (el) { el.classList.toggle('is-active', el.dataset.language === next); });
    syncDemoHome();
    localStorage.setItem('htmlgenius-demo-language', next);
    syncPolicyFrame(next);
  }
  function syncDemoHome() {
    if (!document.querySelector('main > .hero')) return;
    var storeUrl = 'https://chromewebstore.google.com/detail/htmlgenius/fcapmgclnpiljjlcaficmjjclkaepaon';
    document.querySelectorAll('.nav-cta,.hero .button:not(.ghost),.final .button').forEach(function (link) { link.href = storeUrl; link.target = '_blank'; link.rel = 'noreferrer'; });
    var zh = language === 'zh';
    var hero = document.querySelector('.hero h1');
    var lead = document.querySelector('.hero .lead');
    var primary = document.querySelector('.hero .button:not(.ghost)');
    var secondary = document.querySelector('.hero .button.ghost');
    var requirements = document.querySelector('.hero-requirements');
    if (hero) hero.innerHTML = zh ? '修改 HTML<br>如<span class="gradient">编辑文档般自然</span>' : 'Edit HTML<br>As natural as <span class="gradient">writing a doc</span>';
    if (lead) lead.textContent = zh ? 'htmlGenius 是一款开源、AI 驱动的 Chrome HTML 编辑器插件。直接在任意页面上修改内容，本地运行，安全即时。' : 'htmlGenius is an open-source, AI-powered HTML editor extension for Chrome. Make changes directly on any page—locally, securely, instantly.';
    document.querySelectorAll('.nav-cta').forEach(function (button) { button.textContent = zh ? '前往 Chrome 商店' : 'Chrome Store'; });
    if (primary) primary.textContent = zh ? '前往 Chrome 商店 ↗' : 'Chrome Store ↗';
    if (secondary) secondary.textContent = zh ? '查看如何工作 ↓' : 'See how it works ↓';
    if (requirements) requirements.innerHTML = zh
      ? '<div class="support-group"><span class="support-label">目前已支持</span><span class="support-chip">macOS</span><span class="support-chip">Chrome</span></div><div class="support-group"><span class="support-label">一键发送给 Agent</span><span class="support-chip">Codex</span><span class="support-chip">Claude Code</span><span class="support-chip">Copilot CLI</span></div>'
      : '<div class="support-group"><span class="support-label">Supported today</span><span class="support-chip">macOS</span><span class="support-chip">Chrome</span></div><div class="support-group"><span class="support-label">Send to Agent</span><span class="support-chip">Codex</span><span class="support-chip">Claude Code</span><span class="support-chip">Copilot CLI</span></div>';
    var demoPage = document.querySelector('.demo-page');
    if (demoPage) {
      demoPage.querySelector('small').textContent = zh ? '产品页面 / 文案审阅' : 'PRODUCT PAGE / COPY REVIEW';
      demoPage.querySelector('h3').innerHTML = zh ? '让每一个决定<br><span class="selection">在上下文中可见</span>' : 'Make every decision <span class="selection">visible in context</span>';
      demoPage.querySelector('p').textContent = zh ? '在内容所在的位置收集反馈，再将选中的评论整理为一份边界清晰的修改任务。' : 'Collect feedback where it belongs, then turn the selected comments into one bounded change task.';
      demoPage.querySelector('.editor-pop b').textContent = zh ? '评论' : 'Comment';
    }
    var panel = document.querySelector('.task-panel');
    if (panel) {
      panel.querySelector('header span').textContent = zh ? '选择要处理的评论' : 'Select comments for this task';
      panel.querySelector('.task-hint').textContent = zh ? '未选择的评论不会发送给 Agent' : 'Unselected comments are not sent to the Agent';
      var taskText = zh ? [
        ['把第一句改得更直接，说明用户会拿到什么。', '“让每一个决定…”'],
        ['保留留白，但 CTA 再更明显一些。', '“CTA”'],
        ['这一段的节奏可以再紧一点。', '']
      ] : [
        ['Make the first line more direct. Say what the reader gets.', '“Make every decision…”'],
        ['Keep the space, but make the CTA more prominent.', '“CTA”'],
        ['This section could move at a tighter pace.', '']
      ];
      panel.querySelectorAll('.task-comment').forEach(function (card, index) {
        card.querySelector('q').textContent = taskText[index][0];
        var quote = card.querySelector('.quote');
        if (quote) { quote.textContent = taskText[index][1]; quote.hidden = !taskText[index][1]; }
      });
      panel.querySelector('.task-agent span').innerHTML = '<i></i>' + (zh ? 'Codex 已连接' : 'Codex connected');
      panel.querySelector('.task-agent small').textContent = zh ? '本机 Agent' : 'Local Agent';
    }
    var featureCopy = zh ? [
      ['就在 Chrome 中<br><span class="gradient">就在你想修改的地方</span>', '无需导出，无需上传，也无需在源码中反复摸索。你看到什么，就直接在原处修改什么。'],
      ['如往常一样批注<br><span class="gradient">剩下的交给 Agent</span>', '在最需要的上下文中，准确说出你的想法。行内批注为 AI 提供足够细节，让它无缝完成后续工作。'],
      ['让批注只停留在<br><span class="gradient">你的团队之内</span>', '只与真正需要的人共享反馈，不让信息外泄。登录后，让每个决策持续沉淀在正确的团队中。']
    ] : [
      ['Right inside Chrome<br><span class="gradient">Right on the point</span>', 'No exports. No uploads. No wrestling with source code. Change the words and structure you see, right where they live.'],
      ['Comment your thoughts<br><span class="gradient">Let the Agent do the rest</span>', 'Say exactly what you mean, in the context where it matters. Inline annotations give your AI the details it needs to complete the task seamlessly.'],
      ['Keep comments<br><span class="gradient">within your team</span>', 'Share feedback with the people who need it—and no one else. Sign in to keep every decision connected and visible only to the right team.']
    ];
    document.querySelectorAll('main > .section:not(#workflow)').forEach(function (section, index) {
      var title = section.querySelector('.feature-copy h2');
      var text = section.querySelector('.feature-copy p');
      if (title) title.innerHTML = featureCopy[index][0];
      if (text) text.textContent = featureCopy[index][1];
      section.querySelectorAll('.feature-copy p').forEach(function (paragraph, paragraphIndex) { paragraph.hidden = paragraphIndex > 0; });
    });
    var editStage = document.querySelector('#features .feature-stage');
    if (editStage) editStage.innerHTML = zh ? '<div class="edit-demo"><article class="edit-canvas"><small>HTML 文档 / 编辑中</small><h4>让每个细节<br>都恰到好处</h4><p>内容、结构和样式，<mark>都能直接在页面上调整</mark>，无需回到源码里反复查找。</p><p class="edit-faded">每一次修改都保留在你的本地工作区。</p><div class="edit-toolbar"><button class="actual-comment">评论</button><i></i><button><b>B</b></button><button><i>I</i></button><button><u>U</u></button><button><s>S</s></button><i></i><button>A<span class="text-line"></span></button><button>▰</button><button>字号</button><button>H</button><button>☰</button><button>☺</button><i></i><button>×</button></div></article><aside class="edit-panel actual-panel"><header class="panel-brand"><b>htmlGenius</b><span>编辑</span></header><div class="panel-tabs"><b>编辑</b><span>评论</span></div><div class="panel-history"><button>↶</button><button>↷</button><button>↺</button><button>⇩</button></div><div class="panel-format"><button class="actual-comment">评论</button><button><b>B</b></button><button><i>I</i></button><button><u>U</u></button><button><s>S</s></button><button>×</button></div><div class="panel-colors"><button>A<span class="text-line"></span>文字色</button><button>▰ 高亮色</button></div><div class="panel-blocks"><button>字号</button><button>H</button><button>☰</button></div><button class="panel-emoji">☺ 插入表情</button><div class="advanced-box"><b>高级模式已开启</b><small>点选元素后可复制、删除、拖拽重排</small><div><button>复制</button><button>删除</button><button>拖拽</button></div></div></aside></div>' : '<div class="edit-demo"><article class="edit-canvas"><small>HTML DOCUMENT / EDITING</small><h4>Make every detail<br>feel considered</h4><p>Content, structure, and style <mark>can all be adjusted on the page</mark>, without digging back through source code.</p><p class="edit-faded">Every change stays in your local workspace.</p><div class="edit-toolbar"><button class="actual-comment">Comment</button><i></i><button><b>B</b></button><button><i>I</i></button><button><u>U</u></button><button><s>S</s></button><i></i><button>A<span class="text-line"></span></button><button>▰</button><button>Size</button><button>H</button><button>☰</button><button>☺</button><i></i><button>×</button></div></article><aside class="edit-panel actual-panel"><header class="panel-brand"><b>htmlGenius</b><span>Edit</span></header><div class="panel-tabs"><b>Edit</b><span>Comment</span></div><div class="panel-history"><button>↶</button><button>↷</button><button>↺</button><button>⇩</button></div><div class="panel-format"><button class="actual-comment">Comment</button><button><b>B</b></button><button><i>I</i></button><button><u>U</u></button><button><s>S</s></button><button>×</button></div><div class="panel-colors"><button>A<span class="text-line"></span>Text color</button><button>▰ Highlight</button></div><div class="panel-blocks"><button>Size</button><button>H</button><button>☰</button></div><button class="panel-emoji">☺ Insert emoji</button><div class="advanced-box"><b>Advanced mode</b><small>Select an element to duplicate, delete, or drag to reorder</small><div><button>Duplicate</button><button>Delete</button><button>Drag</button></div></div></aside></div>';
    if (editStage) {
      editStage.querySelectorAll('.edit-toolbar button').forEach(function (button) { if (button.textContent === '☺') button.textContent = '😊'; });
      var emojiButton = editStage.querySelector('.panel-emoji');
      if (emojiButton) emojiButton.textContent = zh ? '😊 插入表情' : '😊 Insert emoji';
      var textColorButton = editStage.querySelector('.panel-colors button');
      if (textColorButton) textColorButton.innerHTML = 'A<span class="text-line"></span>';
    }
    var contentSections = document.querySelectorAll('main > .section:not(#workflow)');
    var annotateStage = contentSections[1] && contentSections[1].querySelector('.feature-stage');
    if (annotateStage) annotateStage.innerHTML = zh
      ? '<div class="annotate-demo"><article class="annotate-page"><small>落地页 / 文案审阅</small><h4>让每一个决定<br><mark>在上下文中可见</mark></h4><p>在内容所在的位置收集反馈，再整理成一份明确的修改任务。</p><div class="comment-pin">评论 <span>↗</span></div></article><aside class="annotate-panel"><div class="sidepanel-brand"><b>htmlGenius</b><span>●</span></div><div class="sidepanel-tabs"><span>编辑</span><b>评论</b></div><header><span>评论</span><b>已选 2 条</b></header><div class="annotate-comment"><span class="mini-avatar">YL</span><p>把第一句改得更直接，说明用户会拿到什么。</p></div><div class="annotate-comment"><span class="mini-avatar cyan">KC</span><p>保留留白，但 CTA 再更明显一些。</p></div><div class="annotate-agent"><span><i></i>Codex 已连接</span><button>创建修改任务 →</button></div></aside></div>'
      : '<div class="annotate-demo"><article class="annotate-page"><small>LANDING PAGE / COPY REVIEW</small><h4>Make every decision<br><mark>visible in context</mark></h4><p>Collect feedback where it belongs, then turn it into one focused task.</p><div class="comment-pin">Comment <span>↗</span></div></article><aside class="annotate-panel"><div class="sidepanel-brand"><b>htmlGenius</b><span>●</span></div><div class="sidepanel-tabs"><span>Edit</span><b>Comment</b></div><header><span>Comments</span><b>2 selected</b></header><div class="annotate-comment"><span class="mini-avatar">YL</span><p>Make the first line more direct. Say what the reader gets.</p></div><div class="annotate-comment"><span class="mini-avatar cyan">KC</span><p>Keep the space, but make the CTA more prominent.</p></div><div class="annotate-agent"><span><i></i>Codex connected</span><button>Create edit task →</button></div></aside></div>';
    var teamStage = contentSections[2] && contentSections[2].querySelector('.feature-stage');
    if (teamStage) teamStage.innerHTML = zh
      ? '<div class="team-privacy-demo"><header><div><small>产品团队</small><b>落地页审阅</b></div><span class="team-badge">仅团队成员</span></header><div class="shared-comment"><span class="comment-avatar">YL</span><p>CTA 能否放到首屏更明显的位置？</p><small>该评论已共享给产品团队</small></div><div class="viewer-list"><div class="viewer allowed"><span class="viewer-avatar">YL</span><span>Yilin <small>产品团队</small></span><b>可见</b></div><div class="viewer allowed"><span class="viewer-avatar cyan">KC</span><span>Kai <small>产品团队</small></span><b>可见</b></div><div class="viewer blocked"><span class="viewer-avatar">?</span><span>团队外成员 <small>没有团队权限</small></span><b>🔒 已隐藏</b></div></div></div>'
      : '<div class="team-privacy-demo"><header><div><small>PRODUCT TEAM</small><b>Landing page review</b></div><span class="team-badge">Team only</span></header><div class="shared-comment"><span class="comment-avatar">YL</span><p>Can we make the CTA more obvious above the fold?</p><small>Comment shared with Product Team</small></div><div class="viewer-list"><div class="viewer allowed"><span class="viewer-avatar">YL</span><span>Yilin <small>Product Team</small></span><b>Can view</b></div><div class="viewer allowed"><span class="viewer-avatar cyan">KC</span><span>Kai <small>Product Team</small></span><b>Can view</b></div><div class="viewer blocked"><span class="viewer-avatar">?</span><span>Outside the team <small>No team access</small></span><b>🔒 Hidden</b></div></div></div>';
    var agentSection = document.querySelector('#workflow');
    if (agentSection) {
      var agentKicker = agentSection.querySelector('.feature-copy .kicker');
      var agentTitle = agentSection.querySelector('.feature-copy h2');
      var agentParagraphs = agentSection.querySelectorAll('.feature-copy p');
      var agentLink = agentSection.querySelector('.feature-copy .button');
      if (agentKicker) agentKicker.textContent = '03 / AI NATIVE';
      if (agentTitle) agentTitle.innerHTML = zh ? '一键发送<br><span class="gradient">Agent 本地修改</span>' : 'Send changes<br><span class="gradient">to your local Agent</span>';
      if (agentParagraphs[0]) agentParagraphs[0].textContent = zh ? '把评论一键发送给你的本地 Agent，自动生成新版候选文件。Codex、Claude Code、Copilot CLI 已支持' : 'Send comments to your local Agent to generate a new candidate file. Codex, Claude Code, and Copilot CLI are supported.';
      if (agentParagraphs[1]) agentParagraphs[1].remove();
      if (agentLink) { agentLink.href = 'setup.html'; agentLink.textContent = zh ? '配置说明文档 →' : 'Setup guide →'; }
      var agentRunHead = agentSection.querySelector('.run-head');
      var agentStream = agentSection.querySelector('.stream');
      var agentCandidate = agentSection.querySelector('.candidate span');
      if (agentRunHead) agentRunHead.innerHTML = '<i class="run-dot"></i>' + (zh ? 'Codex · 正在生成候选版本' : 'Codex · Generating a candidate');
      if (agentStream) agentStream.innerHTML = zh ? '<b>read</b> landing.html<br><b>write</b> landingV1.1.html<br>…候选 v1.1 已生成' : '<b>read</b> landing.html<br><b>write</b> landingV1.1.html<br>…candidate v1.1 generated';
      if (agentCandidate) agentCandidate.textContent = zh ? '原文件未被修改' : 'Original file unchanged';
    }
    var finalTitle = document.querySelector('.final h2');
    var finalText = document.querySelector('.final p');
    var finalButton = document.querySelector('.final .button');
    if (finalTitle) finalTitle.innerHTML = zh ? '新世代工作方式<br><span class="gradient">一键开启</span>' : 'The next gen workflow<br><span class="gradient">is just one click away</span>';
    if (finalText) finalText.textContent = zh ? '将文档编辑般的自然体验，带到你处理的每一个 HTML 页面中。' : 'Bring the naturalness of a document editor to every HTML page you work with.';
    document.querySelectorAll('.final .checks span').forEach(function (tag, index) {
      tag.textContent = (zh ? ['开源', '免费', 'Chrome 插件'] : ['Open Source', 'Free', 'Chrome Extension'])[index];
    });
    if (finalButton) finalButton.textContent = zh ? '前往 Chrome 商店 ↗' : 'Chrome Store ↗';
    var footer = document.querySelector('footer .footer-row > span:first-child');
    if (footer) footer.textContent = '© 2026 htmlGenius';
    if (typeof renderTaskSelection === 'function') renderTaskSelection();
  }
  document.querySelectorAll('[data-language]').forEach(function (button) {
    button.addEventListener('click', function () { setLanguage(button.dataset.language); document.querySelectorAll('.lang-menu,.mobile-menu').forEach(function(m){m.classList.remove('is-open');}); });
  });
  document.querySelectorAll('[data-language-toggle]').forEach(function (button) {
    if (!button.querySelector('.language-chevron')) button.insertAdjacentHTML('beforeend', '<span class="language-chevron" aria-hidden="true">⌄</span>');
    Array.from(button.childNodes).forEach(function (node) { if (node.nodeType === Node.TEXT_NODE && node.nodeValue.trim() === '⌄') node.remove(); });
    button.addEventListener('click', function (event) { event.stopPropagation(); button.parentElement.querySelector('.lang-menu').classList.toggle('is-open'); });
  });
  document.querySelectorAll('[data-mobile-toggle]').forEach(function (button) {
    button.addEventListener('click', function (event) { event.stopPropagation(); button.parentElement.querySelector('.mobile-menu').classList.toggle('is-open'); });
  });
  document.addEventListener('click', function () { document.querySelectorAll('.lang-menu,.mobile-menu').forEach(function (menu) { menu.classList.remove('is-open'); }); });
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-copy]');
    if (!button) return;
    var value = button.dataset.copy;
    var copied = function () {
      var original = button.textContent;
      button.textContent = language === 'zh' ? '已复制' : 'Copied';
      setTimeout(function () { button.textContent = original; }, 1400);
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(value).then(copied);
    else { var area = document.createElement('textarea'); area.value = value; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); copied(); }
  });
  var taskChecks = Array.from(document.querySelectorAll('[data-task-check]'));
  var taskCount = document.querySelector('[data-task-count]');
  var taskButton = document.querySelector('[data-send-codex]');
  function renderTaskSelection() {
    var selected = taskChecks.filter(function (check) { return check.checked; }).length;
    if (taskCount) taskCount.textContent = selected;
    if (taskButton) taskButton.textContent = selected ? (language === 'zh' ? '发送 ' + selected + ' 条评论给 Codex →' : 'Send ' + selected + ' comments to Codex →') : (language === 'zh' ? '至少选择一条评论' : 'Select at least one comment');
    taskChecks.forEach(function (check) { check.closest('.task-comment').classList.toggle('selected', check.checked); });
  }
  taskChecks.forEach(function (check) { check.addEventListener('change', renderTaskSelection); });
  if (taskButton) taskButton.addEventListener('click', function () { if (!taskChecks.some(function (check) { return check.checked; })) return; taskButton.classList.add('is-ready'); taskButton.textContent = language === 'zh' ? '任务已准备好 · 发送给 Codex →' : 'Task ready · Send to Codex →'; });
  renderTaskSelection();
  var agentGrid = document.querySelector('.two-col');
  if (agentGrid && document.title.indexOf('Agents') !== -1) {
    agentGrid.className = 'agent-grid';
    agentGrid.insertAdjacentHTML('beforeend', '<article class="agent-card"><div class="card-label" data-zh="同样支持" data-en="ALSO SUPPORTED">同样支持</div><h2>GitHub Copilot</h2><p class="agent-meta" data-zh="通过本机已登录的 Copilot CLI 执行" data-en="Runs through your locally signed-in Copilot CLI">通过本机已登录的 Copilot CLI 执行</p><div class="capability-list"><div><i>✓</i><span data-zh="复用本机 Copilot 登录态，不读取或保存凭据" data-en="Reuses your local Copilot sign-in without reading or saving credentials">复用本机 Copilot 登录态，不读取或保存凭据</span></div><div><i>✓</i><span data-zh="受控工作区内只写候选版本" data-en="Writes only the candidate inside a controlled workspace">受控工作区内只写候选版本</span></div><div><i>✓</i><span data-zh="过程可见，随时可以终止任务" data-en="Progress stays visible and the task can be stopped anytime">过程可见，随时可以终止任务</span></div></div><a class="button ghost" href="https://docs.github.com/en/copilot" target="_blank" rel="noreferrer" data-zh="了解 Copilot ↗" data-en="About Copilot ↗">了解 Copilot ↗</a></article>');
    setLanguage(language);
  }
  var bridgeVersion = '1.0.11';
  var officialExtensionId = 'fcapmgclnpiljjlcaficmjjclkaepaon';
  var setupPromptZh = '请只帮我初始化 HTML Genius 的本地连接，不要修改任何项目文件、HTML 文件或 Agent 配置。\n\n用户已明确授权你在“当前用户目录”安装/修复 HTML Genius Local Bridge；不要请求管理员权限，不要安装或登录任何 Agent，不要读取历史会话、密钥、Cookie 或项目文件。\n\nChrome Extension ID：' + officialExtensionId + '\n需要的 Bridge 版本：' + bridgeVersion + '\n\n请按顺序执行：\n1. 先运行只读检查：\n   npx --yes @htmlgenius/bridge@' + bridgeVersion + ' doctor --json --extension-id ' + officialExtensionId + '\n2. 若检查显示 Bridge 未安装、损坏或需要修复，运行：\n   npx --yes @htmlgenius/bridge@' + bridgeVersion + ' setup --json --scope user --extension-id ' + officialExtensionId + '\n3. 再运行一次 doctor。\n\n最后只用简短中文汇报：Bridge 是否已就绪；哪些已支持 Agent 可用；哪些仍需要我自行登录或更新。不要输出绝对路径、token、会话信息或原始日志。';
  var setupPromptEn = 'Only initialize the local connection for HTML Genius; do not modify any project files, HTML files, or Agent configuration.\n\nThe user has explicitly authorized you to install/repair the HTML Genius Local Bridge in the current user\'s home directory. Do not request admin privileges, do not install or sign in to any Agent, and do not read past sessions, keys, cookies, or project files.\n\nChrome Extension ID: ' + officialExtensionId + '\nRequired Bridge version: ' + bridgeVersion + '\n\nRun in order:\n1. Read-only check first:\n   npx --yes @htmlgenius/bridge@' + bridgeVersion + ' doctor --json --extension-id ' + officialExtensionId + '\n2. If Bridge is not installed, corrupt, or needs repair, run:\n   npx --yes @htmlgenius/bridge@' + bridgeVersion + ' setup --json --scope user --extension-id ' + officialExtensionId + '\n3. Run doctor once more.\n\nFinally, briefly report whether Bridge is ready, which supported Agents are available, and which still need me to sign in or update. Do not output absolute paths, tokens, session info, or raw logs.';
  var backup = document.querySelector('.setup-alt > div:last-child');
  if (backup && !backup.querySelector('.prompt-card')) {
    backup.insertAdjacentHTML('beforeend', '<div class="prompt-card"><div class="prompt-card-head"><span data-zh="复制给 Agent 的 Prompt" data-en="PROMPT FOR YOUR AGENT">复制给 Agent 的 Prompt</span><button class="copy-button" data-zh="复制 Prompt" data-en="Copy prompt">复制 Prompt</button></div><pre data-prompt-zh="" data-prompt-en=""></pre><p data-zh="以下内容与扩展中的固定 Setup Prompt 相同；它不包含页面内容、评论、路径或凭证。" data-en="This is the same fixed Setup Prompt used by the extension. It contains no page content, comments, paths, or credentials.">以下内容与扩展中的固定 Setup Prompt 相同；它不包含页面内容、评论、路径或凭证。</p></div>');
    var promptCard = backup.querySelector('.prompt-card');
    var promptButton = promptCard.querySelector('.copy-button');
    var promptText = promptCard.querySelector('pre');
    promptButton.dataset.copyZh = setupPromptZh;
    promptButton.dataset.copyEn = setupPromptEn;
    promptButton.dataset.copy = language === 'zh' ? setupPromptZh : setupPromptEn;
    promptText.dataset.promptZh = setupPromptZh;
    promptText.dataset.promptEn = setupPromptEn;
  }
  var favicon = document.querySelector('link[rel="icon"]') || document.createElement('link');
  favicon.rel = 'icon';
  favicon.type = 'image/png';
  favicon.href = logoPath; // logoPath 已是 favicon.png(部署根),扁平部署可解析,避免回退到域名根 /favicon.ico
  if (!favicon.parentNode) document.head.appendChild(favicon);
  document.querySelectorAll('.setup-guide .command-card code').forEach(function (code) {
    code.textContent = code.textContent.replace('<你的扩展ID>', officialExtensionId);
  });
  document.querySelectorAll('.setup-guide [data-copy]').forEach(function (button) {
    button.dataset.copy = button.dataset.copy.replace('<你的扩展ID>', officialExtensionId);
  });
  var setupCommands = [
    'npx --yes @htmlgenius/bridge@' + bridgeVersion + ' doctor --json --extension-id ' + officialExtensionId,
    'npx --yes @htmlgenius/bridge@' + bridgeVersion + ' setup --json --scope user --extension-id ' + officialExtensionId
  ];
  document.querySelectorAll('.setup-guide .command-card').forEach(function (card, index) {
    var command = setupCommands[index];
    var code = card.querySelector('code');
    var copy = card.querySelector('[data-copy]');
    if (!command || !code || !copy) return;
    code.textContent = command;
    copy.dataset.copy = command;
  });
  var uninstallCommand = 'npx --yes @htmlgenius/bridge@' + bridgeVersion + ' uninstall --json --scope user';
  var uninstallCode = document.querySelector('.setup-uninstall code');
  var uninstallCopy = document.querySelector('.setup-uninstall [data-copy]');
  if (uninstallCode) uninstallCode.textContent = uninstallCommand;
  if (uninstallCopy) uninstallCopy.dataset.copy = uninstallCommand;
  var extensionIdNote = document.querySelector('.setup-guide .setup-inline-note');
  if (extensionIdNote) {
    extensionIdNote.dataset.zh = 'Chrome 商店正式版已预填扩展 ID。只有使用本地加载的开发版扩展时，才需要改为这台电脑在 chrome://extensions 中显示的 ID。';
    extensionIdNote.dataset.en = 'The Chrome Web Store build already uses its official extension ID. Only a locally loaded development build needs the ID shown for this computer at chrome://extensions.';
  }
  // v0.9.4:连接入口已并入发送按钮右侧的下拉菜单，官网不再引导用户寻找独立的 Connection Center。
  document.querySelectorAll('.setup-guide [data-zh], .setup-alt [data-zh], .setup-help [data-zh]').forEach(function (element) {
    element.dataset.zh = element.dataset.zh.replaceAll('Connection Center', '发送按钮右侧的下拉菜单');
    element.dataset.en = element.dataset.en.replaceAll('Connection Center', 'send menu beside “Send to Agent”');
  });
  document.querySelectorAll('.connection-visual .mini-side-head span, .check-visual .mini-side-head b').forEach(function (element) {
    element.textContent = language === 'zh' ? '发送菜单' : 'Send menu';
  });
  var installVisual = document.querySelector('.connection-visual');
  if (installVisual) {
    installVisual.innerHTML = '<div class="mini-side-head"><b>htmlGenius</b><span data-zh="发送菜单" data-en="Send menu">发送菜单</span></div><div class="menu-preview"><div class="menu-preview-agent"><i class="ready-dot"></i><span><b>Claude Code</b><small data-zh="未安装或未发现" data-en="Not installed or not found">未安装或未发现</small></span></div><div class="menu-preview-agent selected"><i class="ready-dot"></i><span><b>Codex</b><small data-zh="已连接" data-en="Ready">已连接</small></span><em>✓</em></div><div class="menu-preview-agent"><i class="ready-dot muted"></i><span><b>GitHub Copilot</b><small data-zh="未安装或未发现" data-en="Not installed or not found">未安装或未发现</small></span></div><div class="menu-preview-actions"><button data-zh="检查连接" data-en="Check connection">检查连接</button><button data-zh="复制诊断" data-en="Copy diagnostics">复制诊断</button></div></div><div class="mini-send-group"><button class="mini-send-main" data-zh="发送给 Codex" data-en="Send to Codex">发送给 Codex</button><button class="mini-send-toggle" aria-label="menu">⌄</button></div>';
  }
  var sendVisual = document.querySelector('.check-visual');
  if (sendVisual) {
    sendVisual.innerHTML = '<div class="mini-side-head"><b data-zh="已选择 Agent" data-en="Agent selected">已选择 Agent</b><span data-zh="本地 HTML" data-en="Local HTML">本地 HTML</span></div><div class="menu-preview compact"><div class="menu-preview-agent selected"><i class="ready-dot"></i><span><b>Codex</b><small data-zh="已连接 · 将生成候选文件" data-en="Ready · creates a candidate file">已连接 · 将生成候选文件</small></span><em>✓</em></div></div><div class="mini-send-group"><button class="mini-send-main" data-zh="发送给 Codex" data-en="Send to Codex">发送给 Codex</button><button class="mini-send-toggle" aria-label="menu">⌄</button></div>';
  }
  setLanguage(language);
  var setupGuide = document.querySelector('.setup-guide');
  if (setupGuide && !document.querySelector('.setup-toc')) {
    var tocEntries = [
      ['setup-steps', '.setup-guide', '完成连接', 'Connect'],
      ['setup-alternative', '.setup-alt', '备用方式', 'Alternative'],
      ['setup-use', '.setup-use', '连接后怎么用', 'After you connect'],
      ['setup-help', '.setup-help', '常见问题', 'Troubleshooting'],
      ['setup-uninstall', '.setup-uninstall', '卸载 Bridge', 'Uninstall Bridge']
    ];
    var tocItems = [];
    tocEntries.forEach(function (entry) {
      var section = document.querySelector(entry[1]);
      if (!section) return;
      section.id = entry[0];
      tocItems.push('<a href="#' + entry[0] + '" data-toc-target="' + entry[0] + '" data-zh="' + entry[2] + '" data-en="' + entry[3] + '">' + entry[2] + '</a>');
    });
    if (tocItems.length) {
      var toc = document.createElement('aside');
      toc.className = 'setup-toc';
      toc.setAttribute('aria-label', 'Setup guide sections');
      toc.innerHTML = '<span data-zh="本页目录" data-en="ON THIS PAGE">本页目录</span><nav>' + tocItems.join('') + '</nav>';
      document.body.appendChild(toc);
      var tocLinks = Array.from(toc.querySelectorAll('[data-toc-target]'));
      var tocSections = tocEntries.map(function (entry) { return document.getElementById(entry[0]); }).filter(Boolean);
      if ('IntersectionObserver' in window) {
        var tocObserver = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            tocLinks.forEach(function (link) { link.classList.toggle('is-active', link.dataset.tocTarget === entry.target.id); });
          });
        }, { rootMargin: '-22% 0px -68% 0px', threshold: 0 });
        tocSections.forEach(function (section) { tocObserver.observe(section); });
      }
      if (tocLinks[0]) tocLinks[0].classList.add('is-active');
    }
  }
  setLanguage(language);
}());

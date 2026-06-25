# htmleditor · 阶段 0(地基 + TextQuote 重定位保险栓)

HTML 批注与反馈回灌系统的阶段 0 原型。设计文档见 `docs/2026-06-25-html-annotation-feedback-loop-design.md`,实现计划见 `docs/2026-06-25-stage0-plan.md`。

## 运行

```bash
uv run uvicorn server.app:app --port 8000
```

浏览器打开:
- 卡片样本:`http://localhost:8000/static/viewer.html?doc=01_token`
- 本项目 spec(dogfooding):`http://localhost:8000/static/viewer.html?doc=spec`

划词 → 在 prompt 里写评论 → 提交;刷新后应看到黄色高亮与状态栏计数(`已定位 N 条 · stale M 条`)。

## 测试

```bash
uv run pytest -v                       # 全量(11 项,Python 3.9)
uv run pytest tests/test_relocate.py   # 阶段0 退出标准:重定位成功 / 失效转 stale
```

## 阶段 0 验收清单(spec §9)

- [x] 数据 schema(spec §6)落地:`server/models.py`
- [x] Locator 原型:DOM 选区 ⇄ TextQuoteSelector:`static/anchoring/text-quote.js`
- [x] 重定位验证:文字还在→重定位成功;文字被删→stale:`tests/test_relocate.py`
- [x] 非侵入 overlay(iframe):`static/viewer.html` + `annotate.js`

## 立住的骨架决策(spec §5)

S1 标准 selector · S2 批注与版本解耦 · S3 非侵入 overlay · S4 统一 payload · S5 sink 抽象(导出 sink 在阶段 A)· S6 存储留字段。

## 阶段 0 的已知边界

- Locator 为忠实复刻 Hypothesis text-quote 算法的自包含实现(BSD-2,标注来源),阶段 A 评估是否替换为 Hypothesis 完整模块。
- 选区跨多个块级元素时用 `RangeSelector` 兜底,阶段 0 未实现(spec §11 已列为后续)。
- 前端极简(`prompt()` 收评论、`<mark>` 高亮),气泡/富 UI 属阶段 A。

## 下一步(阶段 A)

完整 overlay UI(气泡/列表)、导出 sink(一键复制 prompt 回灌 Claude Code)、版本管理 UI。

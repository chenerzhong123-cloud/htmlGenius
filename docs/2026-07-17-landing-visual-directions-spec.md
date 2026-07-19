# htmlGenius Landing · 三条视觉方向施工 Spec

> 状态：设计 Spec，供实现 agent 直接施工。
>
> 目标：基于现有 `landing/genius.html` 的信息架构，分别产出三个**可独立查看的静态 Landing 方案**。不接入新业务逻辑，不改 Chrome Web Store / GitHub 链接，不改语言切换行为。

## 0. 总体决策

本次保留三条路线：

| ID | 名称 | 用途与判断 |
| --- | --- | --- |
| `bauhaus` | 包豪斯 Landing | 理性、结构化、有产品设计感；适合强调编辑工具的准确性。 |
| `memphis` | 企业孟菲斯 Landing | 友好、创造性、协作感强；适合面向产品、设计与内容团队。 |
| `nebula` | Nebula Workspace Landing | 当前 Landing 的升级基线；与 Chrome Side panel 暗色主题严格统一，最适合正式产品默认方案。 |

**不要**将五种风格都放进正式官网，也不要在一个正式页面中提供“换肤”。正式版本只能选定一条路线。

## 1. 实现边界

### 1.1 新建与保留

- 保留 `landing/genius.html`，施工阶段不得覆盖它。
- 新建以下三个独立预览文件（可复用公共 CSS，但每个文件需可独立打开）：
  - `docs/ui-mockups-v0.6/landing-bauhaus.html`
  - `docs/ui-mockups-v0.6/landing-memphis.html`
  - `docs/ui-mockups-v0.6/landing-nebula.html`
- 新建 `docs/ui-mockups-v0.6/index.html`，以卡片或 iframe 链接三种方案。
- 预览仅需静态 HTML/CSS；可沿用现有语言切换脚本，也可固定展示英文。不要为 mockup 接入 API。

### 1.2 不变项

- 保留现有页面结构：固定导航、Hero、浏览器/评论产品演示、三段 Feature、最终 CTA、Footer。
- 保留所有现有外部链接与 CTA 语义。
- 保留现有中英双语内容；若 mockup 不实现语言切换，则默认英文，中文辅助说明不必删除。
- 不使用外部图片、插画库或网格图库。几何装饰必须由 CSS 或 inline SVG 完成。
- 桌面主断点：`>= 900px`；移动端：`< 720px`。

### 1.3 信息架构与优先级

页面必须让用户在首屏依次读到：

1. `htmlGenius` 是什么：Chrome 中原地编辑 HTML。
2. 本地、安全、无需上传。
3. 产品实际界面：编辑、批注与团队协作。
4. 唯一主行动：`Add to Chrome`。

任何视觉装饰不得压过 Hero 标题、主 CTA 和产品演示框。

## 2. 三案共用布局规格

### 2.1 容器与栅格

| 项目 | 桌面 | 移动 |
| --- | --- | --- |
| 内容最大宽度 | `1160px` | `100% - 32px` |
| 顶部导航高度 | `64px` | `60px` |
| Hero 上下内边距 | `92px / 72px` | `64px / 52px` |
| Hero 标题 | `clamp(52px, 7vw, 84px)` | `46px` |
| Feature 间距 | `min-height: 680px` | 单列；上下 `80px` |
| 最终 CTA 卡片 | 上下 `88px` | 上下 `64px` |

### 2.2 组件状态

- 主 CTA：默认、hover、focus-visible、active 均必须有明确状态。
- 次 CTA：边框/ghost 形式，视觉权重不能超过主 CTA。
- 导航链接：hover 仅改变文字或出现细下划线，不做位移动画。
- 所有可点击元素必须有 `:focus-visible`，使用 2px 高对比 outline，外扩 3px。
- 动画仅用于 `150–220ms` 的 opacity、background、transform；遵守 `prefers-reduced-motion`。

### 2.3 产品演示框

- 演示框是页面最重要的视觉证据，不可换成抽象插画。
- 保留浏览器顶部栏、正文、右侧评论栏与悬浮编辑工具条。
- 桌面：正文/评论栏为 `1fr / 225px`；移动端隐藏右侧评论栏，不隐藏编辑工具条。
- 演示框内部必须跟随各方案的 token；不能保留无关的默认浅色 UI。

## 3. 方案 A：包豪斯（`bauhaus`）

### 3.1 设计意图

用基础几何、严格对齐和有限主色，表达“编辑的结构化与准确性”。它不是复古海报：内容必须保持现代 SaaS Landing 的清晰度。

### 3.2 Token

```css
:root {
  --bg-canvas: #EEE7DC;
  --bg-surface: #FFFDF7;
  --bg-surface-alt: #E4EDF4;
  --ink: #15263E;
  --text-muted: #617083;
  --line: #15263E;
  --red: #D6382E;
  --yellow: #EBBD39;
  --blue: #275FA0;
  --success: #2F8E66;
  --r-sm: 0px;
  --r-md: 0px;
  --shadow: none;
}
```

### 3.3 视觉规则

- 背景为暖灰纸色 `#EEE7DC`，卡片为米白；只允许右上黄圆、左下蓝色旋转方块两处大几何装饰。
- 所有主要卡片、浏览器框和最终 CTA 使用 `2px solid var(--line)`，无圆角、无毛玻璃、无彩色渐变。
- 品牌 Mark：红色实心圆，内含白色 `H`。
- 主 CTA：红色底 `#D6382E`、白字、直角；下方 `5px` 深红硬阴影 `#9D241D`。
- 次 CTA：透明白底、海军蓝 `2px` 边框，无阴影。
- Nav 以 `2px` 深蓝底线分隔；不要使用胶囊导航。
- Feature 编号和代码 token 用等宽字体，正文和标题用 `Inter` / system sans。
- 产品演示正文使用米白，评论栏使用浅蓝；悬浮工具条使用实心蓝。

### 3.4 排版

- Hero 标题：`font-weight: 800`，颜色海军蓝；仅关键短语可变红，禁止整句多色。
- 不能使用全大写 Hero（会降低当前中英文混排可读性）。
- 章节编号格式：`01 / EDIT IN PLACE`，10–11px 等宽、红色、`letter-spacing: .12em`。

### 3.5 禁止项

- 禁止圆角卡片、软阴影、渐变、发光、噪点纹理。
- 禁止超过三种主色同时出现在同一组件。
- 禁止把装饰几何放在正文或 CTA 上方。

## 4. 方案 B：企业孟菲斯（`memphis`）

### 4.1 设计意图

表达“协作、好用、带一点创造性”。企业孟菲斯不是儿童化：几何装饰只在留白区出现，核心控件依然像可信赖的 SaaS。

### 4.2 Token

```css
:root {
  --bg-canvas: #EEF4FF;
  --bg-surface: #FFFFFF;
  --bg-surface-alt: #EDFFFB;
  --ink: #263052;
  --text-muted: #65708F;
  --line: #C8D2EC;
  --purple: #7659DF;
  --purple-dark: #5338BD;
  --coral: #FF876A;
  --yellow: #FFCA52;
  --mint: #55C9BE;
  --r-sm: 10px;
  --r-md: 16px;
  --r-lg: 22px;
  --shadow: 0 12px 26px rgba(101, 118, 168, .16);
}
```

### 4.3 视觉规则

- 背景为极浅蓝 `#EEF4FF`；卡片为白色，使用细浅蓝边框和柔和阴影。
- 主 CTA：紫色 `#7659DF`，5–6px 深紫硬阴影；圆角 12px。hover 仅提升 1px 且加深底色。
- 品牌 Mark：珊瑚色圆角方块，轻微 `rotate(-8deg)`；禁止旋转整个文字 Logo。
- Hero 右侧/右上使用珊瑚点阵椭圆、黄色短条与薄荷色圆环；左下可使用一处薄荷斜纹 blob。
- 每个装饰都必须 `pointer-events:none`、放于 `z-index:-1` 或独立背景层，并与标题保持至少 32px 空隙。
- 产品演示：白色主体、薄荷评论栏、紫色悬浮编辑条；评论中 Agent 名称用珊瑚色。
- 最终 CTA：深蓝紫 `#263052` 面，白字；局部点阵可放在右下。

### 4.4 排版

- 标题：`font-weight: 800`，深蓝紫；强调短语用紫色。
- 正文不得使用彩色字；正文仅 `--text-muted`。
- pill、状态标记、标签可使用紫/薄荷，但必须保持文字对比度 AA。

### 4.5 禁止项

- 禁止超过三组装饰同时进入 Hero 视窗。
- 禁止把点阵、波浪或斜纹覆盖在 CTA、浏览器演示和正文上。
- 禁止使用荧光、高饱和全屏背景或无限浮动动画。

## 5. 方案 C：Nebula Workspace（`nebula`，推荐正式基线）

### 5.1 设计意图

让 Landing 与 Extension Side panel 成为同一产品：相同的深色面层阶梯、同一套靛蓝品牌色、同一类边框与圆角。当前 Landing 已接近该方向；本方案的重点是**完全对齐 Side panel token，而不是重新设计页面结构**。

### 5.2 强制复用的 Extension token

以下 token 必须从 `extension/sidepanel.css` 原样复用；不要自行换成近似颜色：

```css
:root {
  --bg-canvas: #080A12;
  --bg-surface: #10131F;
  --bg-surface-raised: #151929;
  --bg-input: #0D101A;
  --bg-overlay: #171B2A;
  --text-primary: #F6F7FB;
  --text-secondary: #C7CCDC;
  --text-muted: #8D95AA;
  --text-faint: #687086;
  --line-subtle: rgba(255,255,255,.08);
  --line-default: rgba(255,255,255,.12);
  --line-focus: rgba(139,153,255,.72);
  --brand: #7C8CFF;
  --brand-hover: #91A0FF;
  --brand-strong: #6879FA;
  --brand-soft: rgba(124,140,255,.14);
  --cyan: #79E9F7;
  --cyan-soft: rgba(121,233,247,.13);
  --violet: #B09CFF;
  --success: #83EFD7;
  --warning: #F5C86B;
  --danger: #FF8D98;
  --r-sm: 6px; --r-md: 9px; --r-lg: 12px; --r-xl: 16px; --r-pill: 999px;
  --shadow-float: 0 14px 34px rgba(0,0,0,.34);
  --glow-brand: 0 8px 24px rgba(104,121,250,.25);
  --cta-bg: linear-gradient(120deg, #8492FF, #A88BFF);
  --cta-border: rgba(163,177,255,.35);
}
```

### 5.3 页面映射

| Landing 区域 | 指定视觉 |
| --- | --- |
| Body / Nav | `--bg-canvas`；底部用 `--line-subtle` 分隔。Nav 背景必须实色，禁止玻璃模糊。 |
| Hero 背景 | 仅可使用两处低透明度光晕：顶部中心靛蓝、右侧青色；不超过 `opacity: .20`。可保留 48px 微弱网格。 |
| Hero 标题 | `--text-primary`；强调短语为白→淡靛蓝→青色的文字渐变。不要大面积紫色渐变背景。 |
| Hero pill | `--brand-soft` 背景、低透明靛蓝边框、`--success` 状态点。 |
| 主 CTA | 直接使用 `--cta-bg`、`--cta-border`、`--glow-brand`；半径 `--r-md`。 |
| 次 CTA | `rgba(255,255,255,.03)` 背景、`--line-default` 边框、无 glow。 |
| 浏览器演示 | 外框为 `--line-default`；内页可保持浅色内容，以加强“正在编辑真实网页”的对比；评论栏使用浅灰蓝。 |
| Feature stage | `linear-gradient(145deg,#151929,#0D101A)`，`--r-xl`，1px `--line-subtle`。 |
| 代码卡片 | `--bg-input` 背景；HTML tag 用 `--cyan`；attribute 值用 `--violet`；保存提示用 `--success`。 |
| Final CTA | `#10131E` 基底，顶部中心靛蓝径向光晕；`--r-xl`；避免额外大插画。 |

### 5.4 与 Side panel 的一致性验收

- 同一语义不得出现不同颜色：成功均为 `#83EFD7`，危险均为 `#FF8D98`，品牌均为 `#7C8CFF`。
- Landing 交互圆角只能使用 `6 / 9 / 12 / 16 / 999px`。
- Landing 表单、菜单、操作按钮的 hover 底色应与 Side panel 一致：`rgba(255,255,255,.06)` 左右。
- 字体优先 `Inter`；等宽信息使用 Side panel 的 `ui-monospace` token。不要继续引入新的展示字体。

## 6. 可访问性与响应式验收

### 6.1 无障碍

- 正文与背景对比度至少 4.5:1；大号标题至少 3:1。
- 不能仅用颜色传达状态；pill 和保存状态仍要有文字或图标。
- 所有图片/品牌图标提供有意义的 `alt`；纯装饰设为 `aria-hidden="true"`。
- 移动端不依赖 hover 才能发现内容。

### 6.2 移动端

- `<= 720px` 隐藏中间 nav links，保留品牌、语言和 `Add to Chrome`。
- Hero CTA 竖直排列、全宽但最大宽度 `320px`。
- 浏览器演示右侧评论栏隐藏；正文保持至少 220px 高；悬浮工具条缩小但不被裁切。
- Feature 全部改为单列；文案在前，演示在后。
- 包豪斯和孟菲斯装饰在移动端缩小或隐藏，不能产生横向滚动。

## 7. 验收清单

- [ ] 三个预览路径可独立打开，不依赖 localhost server 或后端。
- [ ] `index.html` 可直达三种预览。
- [ ] 所有外链与现有 Hero / Feature 内容被保留。
- [ ] 桌面 `1440px` 与移动 `390px` 下无横向滚动。
- [ ] Hero、产品演示、至少一段 Feature、最终 CTA 均已按对应风格实现。
- [ ] Nebula 方案的颜色和圆角与 `extension/sidepanel.css` token 一致。
- [ ] 通过浏览器截图人工复核；不要求接入自动化视觉回归。

## 8. 参考文件

- 现有正式 Landing：`landing/genius.html`
- Extension 暗色 token：`extension/sidepanel.css`
- 现有风格探索（仅作为方向参考，不要直接复制结构）：
  - `docs/style-experiments-2026-07/landing-style-lab.html?theme=bauhaus`
  - `docs/style-experiments-2026-07/landing-style-lab.html?theme=memphis`
  - `docs/style-experiments-2026-07/landing-style-lab-index.html`

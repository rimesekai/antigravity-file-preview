# 更新日志 / Changelog

## v0.3.6 (2026-11-22)

### 修复与优化 / Fixes & Improvements
- **修复 Word (`.docx`) 缺少预渲染分页符时整篇渲染为一整大页的问题**：
  - **新增几何溢出自动分页引擎（`src/utils/docxPaginator.ts`）**：针对由 `python-docx`、Pandoc、LibreOffice 或自动化脚本生成、缺少 `<w:lastRenderedPageBreak/>` 缓存标记的 `.docx` 文档，基于单页纸张 `min-height` 与 `<article>` 可用内容高度自动执行块级流式拆页；针对已有 Word 预渲染分页符的文档采用 `1.28x` 防误拆阈值，避免浏览器字体渲染微弱差异导致孤行误分页；
  - **跨页长段落与 `keepNext` 保护**：基于 `document.createRange()` 对跨页长段落执行视觉行边界二分切分并内置寡行/孤行保护，自动清除续段 `text-indent` / `margin-top`（并在 `src/renderers/renderers.css` 抑制续段列表编号伪元素重复）、两端对齐首段补充 `text-align-last: justify`，并将分节结束标记 `fp-sect-end-*` 迁移至末片段；支持 `keepNext` 标题连同后续段落一并推入下一页；
  - **跨页大表格安全切分**：避开 `rowSpan > 1` 纵向合并单元格边界安全拆表，并在续表顶部自动重复 `tblHeader` 表头行；
  - **页眉页脚模板与动态页码联动**：优化 `src/renderers/wordRenderer.ts` 后处理时序（CJK 布局与 MathML 规范化 $\to$ 等待图片解码就绪 $\to$ 几何分页 $\to$ 页码域解析与制表位重算），支持 `titlePage`（首页不同）与 `evenAndOddHeaders`（奇偶页不同）页眉页脚模板合成渲染，确保拆分后的多页页脚依次填入 `1..N` 页码与总页数；
  - **测试覆盖**：在 `tests/server.test.mjs` 新增 5 项几何自动分页单元测试，全量 16 个套件共 51 项测试全部通过。

## v0.3.5 (2026-11-22)

### 新增功能与体验升级 / Features & Improvements
- **接入 FlClash (`prism_ui`) 五层光学 Liquid Glass 滤镜系统**：
  - **真光学玻璃渲染引擎**：新增 `src/services/liquidGlass.ts` 与 `src/styles/liquid-glass.css`，基于 Canvas 离屏倒角位移贴图与 SVG `feDisplacementMap` RGB 差异化位移实现真实的边缘棱镜色散（Dispersion）与物理倒角折射；
  - **丰富光学预设**：内置 `regular`、`pill`、`menu`、`tinted` 与 `lens` 5 种预设剖面，并全面应用至顶部工具栏、抽屉、外观弹窗（AppearancePopover）、选区悬浮条（SelectionToolbar）、加载卡片、拖拽放置盒与轻提示（Toast）；
  - **跟手交互辉光与开关降级**：实时跟踪指针位置注入 `--fc-gx` / `--fc-gy` 环境反光，并在外观设置面板集成实时开关（关闭时平滑退化为纯色浮层，零 GPU 额外开销），完美适配浅色、深色与 OLED 纯黑模式。
- **分段控制器连续滑动物理胶囊（Segmented Indicator）**：
  - 新增 `attachSegmentedIndicator` 辅助引擎（`src/utils/uiHelpers.ts`），为外观色彩风格与语言选择等分段控制器挂载物理滑动胶囊；
  - 自动监听选项切换、DOM 树变动、多语言文本尺寸差异与 `document.fonts.ready`，首帧精准落位阻断从左上角飞入并平滑无缝滑移。
- **物理动效与手感规范对齐**：
  - **抽屉舞台退行**：打开工作区文件抽屉时主舞台（`.fp-shell-stage`）平滑下沉缩放（$0.985$）并附带景深微虚化；
  - **触发源锚定展开**：外观设置面板基于点击锚点按钮的中心位置精准映射 `transform-origin` 弹性展开；
  - **质感与细节打磨**：欢迎页引入 Hero Cookie-9 几何水印纹理，Toast 组件升级为平滑进出动效，并补充 `--fc-destructive` 语义色彩 Token。

## v0.3.4 (2026-11-21)

### 修复与优化 / Fixes & Improvements
- **修复 Word 与 PDF 适应宽度模式下滚动条临界死循环震荡与残影问题**：
  - **根因消除**：排查并消除了因水平内边距扣除不足导致的 4px 隐形横向溢出，以及高度溢出时“无滚动条（宽） $\to$ 放大溢出 $\to$ 纵向滚动条出现（窄） $\to$ 重新缩放变小 $\to$ 滚动条消失 $\to$ 再次放大”的高频帧震荡死循环（Layout Thrashing）；
  - **防震荡计算引擎**：新增 `src/utils/fitWidthLayout.ts`，基于内外盒尺寸度量严格扣除水平内边距与 4px 亚像素安全余量，并在高度将发生垂直溢出时主动预留 16px 滚动槽位一次性精准收敛；
  - **现代 CSS 槽位稳定化**：在 `.fp-word-viewport` 与 `.fp-pdf-scroll` 引入 `scrollbar-gutter: stable` 保证纵向滚动槽恒定，并在自适应宽度模式（`.is-fit-mode`）下锁定 `overflow-x: hidden` 杜绝横向滚动条闪现；
  - **ResizeObserver 差异阈值过滤**：记录上次观测的视口与缩放层宽高，仅在尺寸变化 $\ge 1\text{px}$ 时调度重排，阻断无效重绘；
  - **测试覆盖**：在 `tests/server.test.mjs` 新增防震荡自适应宽度算法单元测试，用例数增至 46 项且全部通过。

## v0.3.3 (2026-11-19)

### 修复与优化 / Fixes & Improvements
- **修复 Word (`.docx`) 中文字符单位缩进与行单位段距丢失问题**：
  - 针对底层 `docx-preview` 未解析 OOXML `*Chars`（`firstLineChars` / `hangingChars` / `leftChars` / `startChars` / `rightChars` / `endChars`）与 `*Lines`（`beforeLines` / `afterLines`）属性导致的中文文档段落首行缩进丢失问题，新增 `src/utils/docxCjkLayout.ts`；
  - 完整解析正文、表格单元格、SDT、文本框、页眉/页脚、脚注/尾注、`styles.xml` 样式继承链、`numbering.xml` 编号级别与分节 `docGrid.linePitch` 行高，并在 DOM 挂载后结合各段落实际正文渲染字号精确换算写回 `text-indent`、`margin-inline-start/end` 与 `margin-top/bottom`（兼容绝对值优先级、显式归零覆盖与跨页续段不重复首行缩进）；
  - 在 `src/renderers/wordRenderer.ts` 中启用 `keepOrigin: true` 并接入 CJK 布局修补（预处理完自动释放 `_xmlDocument` 引用，且置于制表位重算之前）；
  - 在 `tests/server.test.mjs` 补充 3 项自动化单元测试，总测试用例增至 45 项并全部通过。

## v0.3.2 (2026-11-19)

### 修复与优化 / Fixes & Improvements
- **接入 FlClash `prism_ui` 动效与物理手感规范**：
  - 在 `src/styles/tokens.css` 补充 `--fc-ease-droplet`（`linear()` 21 点弹簧曲线及 `@supports` 降级）、`--fc-ease-push` 与 `--fc-duration-ink` / `tab` / `droplet` 时长 Token，对齐 `4% / 10%` 墨水叠加透明度；
  - 为外观面板开关（`.fc-switch`）接入按住横向拉伸与液滴弹性回弹，为非禁用态按钮及分段控件补齐按压微缩回弹；
  - 统一工作区文件列表行、开关行与 PPT/PDF 缩略图卡的 `200ms` 墨水叠加过渡（保持绝不缩放），并完善 `.fp-appearance-popover[popover]`、`dialog.fp-drawer-dialog` 的 Top Layer `@starting-style` / `allow-discrete` 进出动画与 `prefers-reduced-motion` 无障碍降级。
- **仓库正式更名为 `antigravity-file-preview`**：同步更新 `package.json`、`plugin.json`、`README.md`、`README.en.md` 与 `.github/ISSUE_TEMPLATE/config.yml` 中的项目标题、徽章与仓库地址。

## v0.3.1 (2026-11-17)

### 修复与优化 / Fixes & Improvements
- **HTML 格式分类 Tab 顺序与换行展示**：将文件分类 Tab 顺序调整为 `['all', 'html', 'pdf', 'word', 'excel', 'ppt', 'mp4']`，使 HTML 靠前显示；针对抽屉面板与 `<=480px` 窄屏容器支持 `flex-wrap: wrap` 换行展示，彻底解决 370px 窄抽屉下单行截断溢出且因无滚动条导致排在末尾的 HTML / MP4 标签无法被看到的问题。
- **工作区三级智能回退扫描**：服务端扫描器新增三级回退链——优先使用 `workspaceUris`，空时回退到 `process.env.WORKSPACE_ROOT`，若仍无可用根目录且传入了 `currentFile`，自动回退扫描该文件所在目录 `dirname(currentFile)`，完整支持 Windows 路径与 `file://` URI。用户在非工作区环境下直接打开单个网页或文档时，抽屉可自动列出其所在目录的所有支持文件。
- **Bridge 延迟缓存与当前文件透传**：修复前端 Bridge 首次延迟返回空数组时永久阻断重试的缺陷；在展开抽屉、手动刷新、工作区变更及文件加载成功时均透传当前文件路径。
- **自动刷新休眠节流与即时唤醒（Page Visibility）**：采纳 Claude Opus 4.6 终审架构建议，结合 `document.visibilityState` 优化自动刷新轮询——当侧边栏处于后台折叠或不可见时自动暂停 `statFile` 轮询，消除无谓开销；当页面重新恢复可见或窗口重新聚焦时，立即触发一次静默更新检查，免去等待 2.5s 周期，体验更丝滑省电。
- **版本号单一来源化**：通过 `build-server.mjs` 在构建期注入 `package.json` 版本号（源码/测试运行自动回退读取清单文件），并将健康检查测试断言改为动态读取，消除多处手动同步漂移。
- **测试覆盖**：补充 3 项三级回退与 HTML 检测自动化测试，用例数增至 42 项且全部通过。

## v0.3.0 (2026-11-14)

### 新增功能 / Features
- **中英双语自适应界面（Auto / 中文 / EN）**：界面、工具栏、文件浏览器、选区提示与加载/错误提示默认跟随系统语言自动切换中文或英文，支持在欢迎页与顶部工具栏一键在「自动 / 中文 / EN」间切换并持久记忆偏好；同步将 `plugin.json`、`rules/AGENTS.md` 与 `skills/file-preview/SKILL.md` 升级为国际化英文描述以适配全球用户。
- **预览自动悬停选字、空白处拖拽平移与选区提示**：PPT / PDF / Word 放大后默认直接选字，无需任何模式切换按钮——鼠标停留在文字上自动切换文本光标并放行左键划选，空白处拖动自动切换抓手光标平移视图（中键全区可拖拽），同时增强文本与 PDF 透明文本层的高对比度 `::selection` 高亮；在预览区选中文字后自动弹出悬浮选区提示条（实时展示已选字数并支持一键复制，复制后在原文选区位置追踪绘制高亮框与状态提示胶囊，滚屏/缩放自动对齐并在后续操作或切页时自动清理）。
- **单页居中与滚轮翻页**：PPTX 与 PDF 在「单页」模式下支持画布水平垂直安全居中（放大溢出时仍可完整滚动查看），并支持鼠标滚轮上下翻页（带触控板惯性抑制，放大后先滚到顶/底边界再翻页）。

### 安全与稳定性优化 / Security & Fixes
- **大 PPTX 课件支持与原地刷新**：针对包含海量素材或内嵌字体的 PPTX 课件放宽 `PPTX_ZIP_LIMITS`（支持至多 `50,000` 条目 / `1.5GB` 媒体 / `2GB` 总解压体积）与 `PPTX_EMBEDDED_FONT_LIMITS`，并将超限与压缩包异常转换为清晰双语报错；新增 PPTX `reloadBuffer` 原地重载并消除布局切换竞态。
- **放大拖拽平移与 PPT 单页溢出修复**：文档（PPT / PDF / Word）在放大状态下默认支持空白处左键或任意位置中键拖动平移（自动避开交互控件与滚动条轨道），并修复 PPT 单页模式放大后左侧内容横向溢出截断问题。
- **报错格式徽标兜底与自动刷新自愈**：抽离 `fileMeta` 工具在加载异常时准确推断并保留真实格式徽标（避免非 Word 格式误显示为 `DOCX`），同时在非 `404` 异常时保留磁盘文件 `mtimeMs` / `size`，文件修复保存后可由 2.5s 自动刷新轮询自动恢复预览。
- **跨平台 CI 与构建脚本加固**：补充 GitHub Actions 双平台 CI 工作流，并修复 Linux 路径测试兼容性与构建依赖细节。

## v0.2.0 (2026-11-14)

### 新增功能 / Features
- **Excel 预览支持（`.xlsx` / `.xls` / `.csv` / `.tsv`）**：支持多 Sheet 工作表切换、顶部公式栏（展示原始公式与计算值）、按钮与 `Ctrl/Cmd+C` 一键复制、合并单元格还原与整区表头高亮、缩放及跨表搜索；`.csv` / `.tsv` 自动识别 UTF-8 与 GB18030 编码。
- **Word 全局搜索（`.docx`）**：支持跨文本 run 段落级高亮匹配、计数展示、`↑/↓` 导航与 `Ctrl/Cmd+F` 快捷聚焦。
- **HTML / PDF / MP4 核心增强**：新增 >20MB 大体积 PDF 与最高 4GB 本地 MP4 的 HTTP Range（`206 Partial Content`）按需分片流式加载、HTML 沙箱/交互/源码三模式隔离切换及手动「自动 / 浅色 / 深色」主题切换。

### 安全与稳定性优化 / Security & Fixes
- **依赖安全升级**：将 `xlsx` 升级至 SheetJS `0.20.3`；在 `pdfRenderer` 中设置 `isEvalSupported: false` 缓解 PDF.js CVE-2024-4367（GHSA-wgrm-67xf-hhpq）。
- **大图/大表保护与性能**：裁剪 Excel 稀疏 `!ref` 尾空行，行/列改为分批展开并设置渲染硬上限；搜索范围与可渲染边界对齐，命中未展开区域时自动扩展后高亮；PDF 远距跳页采用瞬移滚动避免渲染风暴。
- **日期显示与同文件原地刷新**：Excel 解析启用 `cellDates: false` + `cellNF: true`，消除日期兜底路径的 `+08:00` 尾巴；同文件刷新原地复用渲染器，保留当前 Sheet、选中单元格、滚动位置与搜索高亮。
- **服务端优化**：`/api/fs/read` 改为异步读取并实施分级上限（解析类文档 `60MB`，文本类 `80MB`）；静态资源内存缓存支持按 `mtimeMs` 与文件大小自动失效；剪贴板复制抽离公共实现并增加沙箱 `execCommand` 降级与失败提示。

## v0.1.0

- 初始版本：提供侧边栏 `.pptx`、`.docx`、`.pdf`、`.html` 基础预览框架、工作区文件浏览器与路径安全校验后端。

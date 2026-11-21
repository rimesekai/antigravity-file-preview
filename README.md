<div align="center">
  <img src="./assets/logo.svg" alt="File Preview Logo" width="88" height="88" />
  <h1>Antigravity File Preview</h1>
  <p>在 Antigravity 桌面端侧边栏（Aux Pane）高保真预览本地文档、表格、音视频与网页文件</p>

  <p>
    <a href="https://github.com/rimesekai/antigravity-file-preview/actions/workflows/ci.yml">
      <img src="https://github.com/rimesekai/antigravity-file-preview/actions/workflows/ci.yml/badge.svg" alt="CI Status" />
    </a>
    <a href="https://github.com/rimesekai/antigravity-file-preview/releases/latest">
      <img src="https://img.shields.io/github/v/release/rimesekai/antigravity-file-preview?label=version&amp;color=2563eb" alt="Version" />
    </a>
    <a href="./LICENSE">
      <img src="https://img.shields.io/badge/License-MIT-16a34a.svg" alt="License: MIT" />
    </a>
    <a href="https://nodejs.org/">
      <img src="https://img.shields.io/badge/node-%3E%3D20-339933.svg" alt="Node >= 20" />
    </a>
  </p>

  <p>
    <strong>简体中文</strong> | <a href="./README.en.md">English</a> | <a href="./CHANGELOG.md">更新日志</a>
  </p>
</div>

---

## 界面展示

<table>
  <tr>
    <td align="center" width="50%">
      <img src="./assets/screenshots/welcome-light.png" alt="欢迎页浅色主题" width="100%" /><br />
      <sub><b>欢迎页 · 浅色模式（支持自定义强调色）</b></sub>
    </td>
    <td align="center" width="50%">
      <img src="./assets/screenshots/welcome-dark.png" alt="欢迎页深色主题" width="100%" /><br />
      <sub><b>欢迎页 · 深色模式</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="./assets/screenshots/preview-ppt-light.png" alt="PPT 预览浅色模式" width="100%" /><br />
      <sub><b>PPTX 预览 · 浅色经典蓝</b></sub>
    </td>
    <td align="center" width="50%">
      <img src="./assets/screenshots/preview-ppt-dark.png" alt="PPT 预览深色模式" width="100%" /><br />
      <sub><b>PPTX 预览 · 深色暖琥珀</b></sub>
    </td>
  </tr>
</table>

## 支持格式一览

| 格式 | 解析 / 渲染方案 | 体积上限 | 核心能力 |
| --- | --- | --- | --- |
| **PPT**（`.pptx`） | `@aiden0z/pptx-renderer` | `60 MB` | 单页 / 滚动布局、自适应缩放与放大拖拽平移、缩略图栏、全文检索、支持至多 `50,000` ZIP 条目大课件与原地刷新保留页码 |
| **Word**（`.docx`） | `docx-preview` | `60 MB` | 保留分页 / 页眉页脚 / 表格、宽度自适应与放大拖拽平移、跨 run 全文搜索（`Ctrl/Cmd+F`） |
| **Excel / CSV**（`.xlsx` / `.xls` / `.csv` / `.tsv`） | `xlsx`（SheetJS `0.20.3`） | `60 MB` | 多 Sheet 标签切换、公式栏与 `Ctrl/Cmd+C` 复制、合并单元格整区高亮、稀疏边界裁剪与分批展开 |
| **PDF**（`.pdf`） | `pdfjs-dist` + 本地 HTTP Range | `1 GB` | 突破 >20MB 限制按需分片流式加载、单页 / 滚动、放大拖拽平移、缩略图、跨页搜索与远距跳页瞬移 |
| **MP4**（`.mp4`） | 原生 Video + 本地 HTTP Range | `4 GB` | 突破 >20MB 限制按需流式播放、任意拖拽定位、0.5x–2x 倍速与循环 |
| **HTML**（`.html` / `.htm`） | 独立端口静态服务 (`127.0.0.1:0`) | `80 MB`（文本源码） | 支持同目录相对 CSS / JS / 图片资源，提供「安全沙箱 / 交互模式 / 源码」三视图 |

## 主要功能

- **PPT 预览（`.pptx`）**：基于 `@aiden0z/pptx-renderer` 渲染幻灯片，支持单页 / 滚动布局、缩放自适应、缩略图导航与文本检索；放宽大课件 ZIP 条目上限（至多 `50,000` 条目）与内嵌字体限额，修复单页放大后横向溢出截断，支持放大后空白处按住左键或任意位置按住中键拖动平移视图（悬停文字自动切回选字光标）以及同文件原地重载并保留当前页码、滚动位置与搜索高亮。
- **Word 预览（`.docx`）**：基于 `docx-preview` 保留分页、页眉页脚、脚注尾注与表格样式；支持自适应宽度缩放、放大状态下空白处左键 / 任意位置中键拖拽平移视图（悬停文字自动选字）与跨 run 全文搜索（`Ctrl/Cmd+F` 快捷聚焦、匹配计数与上一处 / 下一处定位高亮）。
- **Excel 表格预览（`.xlsx` / `.xls` / `.csv` / `.tsv`）**：基于 `xlsx`（SheetJS `0.20.3`）解析工作簿，支持多 Sheet 工作表标签切换、顶部单元格检视与公式栏（展示原始公式 `=` 与计算值，支持按钮与 `Ctrl/Cmd+C` 一键复制）、合并单元格（`rowSpan` / `colSpan`）还原与整区表头高亮、稀疏 `!ref` 边界自动裁剪与行 / 列分批加载、缩放以及跨 Sheet 文本搜索；`.csv` / `.tsv` 自动检测 UTF-8（含 BOM）与 GB18030 编码，避免中文表格乱码。
- **PDF 预览（`.pdf`，含 >20MB 大文件流式预览）**：基于 `pdfjs-dist` 与本地独立端口 HTTP Range（`206 Partial Content`）分片流式加载服务，无需一次性将整份大文件读入内存即可按需渲染可视页面；支持单页 / 滚动布局、可折叠缩略图栏、适应 / 缩放、放大后空白处左键 / 任意位置中键拖拽平移视图（悬停透明文本层自动选字）、1-based 翻页跳页与跨页全文搜索。
- **MP4 视频播放（`.mp4`，含 >20MB 大视频流式播放）**：基于本地独立端口 HTTP Range（`206 Partial Content`）按需分片流式播放（最高支持 4GB 本地 MP4），支持拖动进度条、0.5x–2x 倍速调节与循环播放。
- **HTML 预览（`.html` / `.htm`）**：通过按需启动的本地独立端口静态预览服务（`127.0.0.1:0`）挂载渲染，完整支持同目录及工作区内相对路径资源（CSS / JS / 图片 / 字体），并与 Sidecar 主控台严格跨源隔离；支持安全沙箱、交互模式与源码视图切换。
- **原地自动刷新、外观引擎与中英双语切换**：默认开启文件变更自动刷新（2.5s 检查 `mtimeMs` / `size`），同文件更新时原地重载并保留当前页码 / 工作表、缩放、滚动位置与搜索高亮；加载失败时保留真实格式徽标并在文件修复后自动轮询恢复；采用四层无边框表面层级与等宽数字排版，接入 `flclash-ui`（`prism_ui`）五层光学 Liquid Glass 系统（Canvas 倒角折射位移贴图 + SVG `feDisplacementMap` RGB 边缘色散、上下定向镜面高光环、跟手高斯按压辉光，关闭开关时平滑回退纯色浮层）与物理动效规范（分段控制器连续滑动物理胶囊、抽屉展开底层退行缩放、触发源弹性展开、液滴弹性开关、按钮按压微缩回弹、列表行只叠加墨水不缩放、Hero Cookie-9 几何水印与 `prefers-reduced-motion` 无障碍降级），自动同步跟随 Antigravity 浅色 / 深色主题，并在右上角「外观与主题」面板内集成「跟随宿主 / 浅色 / 深色」、自动配对（浅蓝 / 深琥珀）及 6 套强调色种子、4 种色彩风格、OLED 纯黑深色、Liquid Glass 浮层与「跟随系统 / 中文 / English」语言切换。
- **默认直接选字、空白处拖拽平移与选区提示**：预览区（PPT / Word / Excel / PDF / HTML 源码等）默认支持直接划选文字，无需任何模式切换按钮；在 PPT / PDF / Word 放大后，鼠标停留在文字上自动显示文本光标并放行左键划选，移动到空白处自动切换抓手光标拖动平移视图（中键在任意区域均可拖拽平移），同时增强文本与 PDF 透明文本层的 `::selection` 高对比高亮；选中文字后弹出悬浮选区提示条，实时显示已选字数并支持一键复制，复制后在原文选区位置绘制追踪高亮选框与状态提示胶囊。
- **关联打开与工作区扫描**：支持通过点击工作区文件（`file_extensions`）、侧边栏文件列表、路径直达或拖拽文件快速切换预览对象。

## 快速安装（直接部署到 Antigravity）

本仓库已包含可直接运行的预构建产物 `dist/`。克隆仓库后无需额外安装依赖，直接执行本地安装脚本即可部署到全局插件目录 `~/.gemini/config/plugins/file-preview/`：

```powershell
git clone https://github.com/rimesekai/antigravity-file-preview.git
cd antigravity-file-preview
npm.cmd run install:local
```

（若在 macOS / Linux 下，可直接运行 `node scripts/install-local.mjs`。）

安装完成后重启或刷新 Antigravity 插件列表，即可使用 `/file-preview` 或点击 `[File Preview](sidecar://file-preview/viewer/)` 打开侧边栏，也可直接点击工作区中的 `.pptx`、`.docx`、`.xlsx`、`.xls`、`.csv`、`.tsv`、`.pdf`、`.mp4`、`.html`、`.htm` 文件自动触发预览。

## 从源码构建与测试

在 Windows PowerShell 中请使用 `npm.cmd`（避免 `.ps1` 执行策略限制），构建和打包需要安装平台对应的 `esbuild` / `rollup` 原生二进制依赖（位于 `optionalDependencies` 中，因此**不要**带 `--omit=optional`）：

```powershell
npm.cmd install --registry=https://registry.npmmirror.com
npx.cmd tsc --noEmit
npm.cmd test
npm.cmd run build
npm.cmd run install:local
```

构建产物输出至 `dist/`（`dist/index.html`、`dist/app.js`、`dist/styles.css`、`dist/server.mjs`、`dist/pdf.worker.js`），插件运行时无需携带 `node_modules/`。

## 已知格式与安全说明

- **暂不支持格式**：旧版二进制 `.ppt` 与 `.doc` 格式（浏览器端无法直接解析二进制复合文档，请在 PowerPoint / Word / WPS 中另存为 `.pptx` 或 `.docx` 后再预览）。
- **路径与内存安全边界**：后端路由校验路径仅允许访问当前工作区及用户允许目录，自动拦截路径穿越、跨边界符号链接及敏感日志目录；需整包载入渲染进程内存解析的格式（`.pptx` / `.docx` / `.xlsx` / `.xls` / `.csv` / `.tsv`）限制单文件上限为 `60MB`，Excel 单表默认最多加载前 `2,000` 行 × `100` 列并设安全渲染硬上限，PDF（最高 `1GB`）与 MP4（最高 `4GB`）均走独立本地端口 HTTP Range 分片流式读取。
- **PDF.js 与三方依赖说明**：
  1. `pdfRenderer` 已强制向 `pdfjs-dist` 传入 `isEvalSupported: false`，以禁用字体 / 路径中的动态脚本求值，缓解 CVE-2024-4367（GHSA-wgrm-67xf-hhpq）。
  2. `@aiden0z/pptx-renderer` 在内部处理 `.pptx` 嵌套 PDF 数据时仍使用其上游默认 `getDocument` 参数，请勿使用本插件打开不可信来源的 `.pptx` 文件。
  3. 开发依赖树中 `pdfjs-dist` 的可选依赖 `canvas` 会间接引入旧版 `tar`，仅用于 Node 侧可选安装期，不会被打包进浏览器端与 Sidecar 运行时产物 `dist/`。

## License

本项目采用 [MIT License](./LICENSE) 开源许可。

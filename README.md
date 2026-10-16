# SkyFlow Designer — 桌面版

把 [Web 版](https://github.com/1to3fall5/skyflow-designer) 移植为独立桌面应用：
**Tauri 2 + Rust 像素引擎 + React/Three.js 前端**。绘制动态天空盒 Flowmap 的工具。

## 目录

| 路径 | 说明 |
|---|---|
| `app/` | 桌面版本体（本仓库的主体） |
| `app/src-tauri/` | Rust 侧：像素引擎、笔刷、合成、TGA 编解码、工程文件、IPC 命令 |
| `app/src/` | 前端：2D 绘制视图、3D 预览、图层面板、快捷键、桌面外壳 |
| `src/` | Web 原版参考副本，**单独克隆自 1to3fall5/skyflow-designer，已 gitignore** |

## 构建

```bash
cd app
npm install
npm run dev      # 前端热更新（需要 Tauri 壳时改用下一条）
npx tauri dev    # 完整桌面应用
npx tauri build  # 打包：NSIS 安装包 + MSI
```

前置：Node 18+、Rust stable（MSVC 工具链，Windows）。

## 测试

```bash
cd app && npm test          # 前端 270 项 + Rust 引擎 90 项，共 360
cd app && npm run test:fe   # 仅前端
cd app && npm run test:rust # 仅引擎
```

## 与 Web 版的差别

- 像素运算全部移到 Rust（rayon 并行、脏矩形 diff、zstd + rmp-serde 工程文件）
- 原生窗口：无浏览器边框 / 右键菜单 / F5 / Ctrl+R，自带工程文件读写
- 笔刷改为**到线段距离场** + 覆盖率并集，消除串珠与接痕
- Photoshop 语义对齐：`强度` 是上限、`流量` 是速率，Alt 吸取强度
- 不透明度归图层面板、模糊做成 `fx` 图层效果（可开关 / 可删除，非破坏性）
- 钢笔路径是非破坏性的：锚点才是对象，像素只是它的一次渲染
- 图层顺序可调，且逐像素影响合成（上层可覆盖下层障碍）

细节见 [`app/README.md`](app/README.md)。

## 署名

- **界面配色**：Photoshop「Pro (Dark)」色值取自
  [PhotoCraft](https://github.com/storytold/photocraft) 的
  `crates/ui-egui/src/theme.rs`（MIT OR Apache-2.0）。PhotoCraft 是 Rust + egui
  实现，UI 代码本身不适用于本项目，仅参考其主题 token。
- **工具图标**：[Lucide](https://github.com/lucide-icons/lucide)（ISC），
  `brush / eraser / wand / pipette / hand`，以 SVG path 内嵌在 `app/src/icons.tsx`。
- Adobe 与 Photoshop 的商标仅用于描述交互兼容，本项目与其无关。

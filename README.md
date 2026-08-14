# DSH-Pet — DSH 桌宠插件

一个给 DeepSeek Harness（DSH）Web 界面的桌面宠物插件：宠物浮在界面角落，随会话状态变化表情动作。支持两类宠物，风格可自选：

- **像素图集宠物**（Codex 兼容格式）：`pet-hatch` skill 从任意图片孵化
- **Live2D 模型宠物**（Cubism 4）：直接渲染 `.moc3` 运行时模型（网格变形 + 骨骼 + 发丝物理），并内置一套**免 Editor 的 motion 生产线**

## 功能特性

- 渲染在 DSH Web GUI 的 `shell.overlay` 浮层，**拖动**移动位置（记住位置）
- 会话状态感知：空闲 / 思考 / 工具调用 / 等待 / 出错（像素宠物映射到 9 行动画；Live2D 映射到动作组）
- Live2D：自动眨眼、视线跟随、呼吸/物理、空闲打盹与随机小动作；动作由 motion3.json 驱动，也可纯参数驱动
- **试驾台**（`?dsh-pet-debug=1`）：滑杆面板实时驱动模型参数，校准"参数→观感"
- 内置诊断：`?dsh-pet=<id>` 深链选择；浏览器自报诊断写入 `~/.dsh/pets-echo.log`

## 架构

插件包是 **dual-face** 的：`package.json` 声明 `dsh.bundle.patch`（组合层：插入 `dsh-pet` 条目）与 `dsh.client`（浏览器半）；`exports["./client"]` 指向构建好的 bundle，由 DSH 的 client-modules 扫描进 `window.__DSH_BOOT__` 并在 `/plugins/<id>/client.js` 提供。

| 层 | 文件 | 作用 |
|---|---|---|
| 播放器（client plugin） | `src/client/` → `lib/client.js` | 注册进 `shell.overlay` slot；订阅会话快照；渲染图集或 Live2D 模型；处理拖动/点击/右键；驱动参数动画 |
| 资产服务（host plugin） | `lib/index.js` | 注册 `/api/pets`（列表）、`/api/pets/<id>/spritesheet`（图集字节）、`/api/pets/<id>/assets/<路径>`（Live2D 模型文件，带路径穿越防护）；扫描 `~/.dsh/pets/<id>/`；`POST /api/pets/echo` 诊断通道 |
| 生成器（skill） | `.dsh/skills/pet-hatch/` | 从一张图生成 Codex 兼容的像素图集（1536×1872，8×9 格，192×208/格）+ `pet.json` |

## 安装

### 标准安装（npm 包 / 本地路径 / git 仓库，需重启一次）

```bash
# 改代码才需要构建；lib/client.js 已提交，纯安装可跳过
npm install && npm run build:client

# 安装为 web profile 的 bundle（自动写入 dsh.profile.bundles）
dsh plugin --profile web add <包名|路径|git url>
# 重启 dsh web（bundle 列表在启动时读取）
```

### 免重启 live 安装（开发迭代用）

1. 把插件包放进 loader 可解析的位置：

```powershell
New-Item -ItemType Junction -Path "$env:DSH_HOME\profiles\node_modules\dsh-pet" -Target "<插件目录绝对路径>"
```

2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 添加条目（该 patch 有 live watcher，无需重启）：

```yaml
- insert:
    - id: dsh-pet
      name: 'dsh-pet'
      inject: [webServer]
```

> ⚠️ 实测踩坑（重要）：
> - **修改 patch 时必须先写回空列表 `[]`，等条目卸载后（约 3 秒）再写新条目**。非空 → 非空的直接替换会因新旧条目同时注册 `/api/pets` 路由（duplicate route）导致新条目挂载失败、整棵新树被回滚。
> - **写 package.json 别用 Windows PowerShell 的 `Set-Content -Encoding UTF8`（会加 BOM）**，BOM 会让 client-modules 的 `JSON.parse` 静默失败——宿主插件正常、路由正常，但浏览器半永远不进 boot 图。用 node/编辑器写。
> - Node 的 ESM 解析/模块缓存按 specifier 生效：改了插件代码后，同一 specifier 在本进程内会一直返回旧模块。要么换 specifier（并用 `DSH_PET_BUNDLE_ID=<同名> node scripts/build-client.mjs` 重打 bundle），要么重启 `dsh web`。

### 验证

```powershell
curl http://127.0.0.1:3080/api/pets                    # 宠物列表
curl http://127.0.0.1:3080/api/pets/<id>/spritesheet    # 图集字节
curl http://127.0.0.1:3080/api/pets/<id>/assets/<file>  # Live2D 模型文件
# 页面源码里 window.__DSH_BOOT__ 应包含 dsh-pet 行；/plugins/dsh-pet/client.js 应返回 200
```

### 卸载

1. 从 `~/.dsh/profiles/web/cordis.patch.yml` 删除 `dsh-pet` 条目（先 `[]` 再删，避免回滚问题）。
2. `cmd /c rmdir ~/.dsh/profiles/node_modules/dsh-pet`（junction 用 rmdir 删）。
3. 删除宠物：`rm -r ~/.dsh/pets/<id>`。
4. （若走 bundle 安装）`dsh plugin --profile web remove dsh-pet`。

## 宠物目录约定

所有宠物放 `~/.dsh/pets/<id>/`（`$DSH_HOME/pets`），`pet.json` 两种形态：

**像素图集宠物**：

```json
{ "id": "blobcat", "displayName": "Blob Cat", "description": "...", "spritesheetPath": "spritesheet.webp" }
```

图集契约与 Codex `hatch-pet` 同构：1536×1872，8 列 × 9 行，每格 192×208，透明底；9 行对应 9 种状态（idle/running-right/running-left/waving/jumping/failed/waiting/running/review）。现成的 Codex 宠物目录可直接复制进来。

**Live2D 模型宠物**：

```json
{ "id": "<id>", "displayName": "<名称>", "kind": "live2d", "model": "<相对路径>.model3.json" }
```

模型文件（`.moc3`/`.model3.json`/`.physics3.json`/纹理/motions 等）放在同一目录，模型内相对引用自动解析。`model3.json` 的 `FileReferences.Motions` 声明动作组，动作文件放 `motions/`。

## Live2D 动作（motion）生产线

motion3.json 本质是"参数 ID + 时间曲线"——**没有模型原工程也能定制动作**（无 Cubism Editor）。

| 工具 | 用途 |
|---|---|
| `scripts/motion-gen.mjs <spec.json> --apply [--pet <id>] [--model3 <文件名>]` | 曲线 DSL（sine/damped/pulse/ramp/keys）→ 合法 motion3.json；按参数表校验/裁剪；`--apply` 安装进对应宠物目录并挂载 Motions 组 |
| `motions-specs/*.json` | 动作规格示例（改数字即调幅度/速度） |
| `?dsh-pet-debug=1` 试驾台 | 滑杆实时驱动参数，校准"参数→观感" |
| `scripts/frame-strip.mjs` | 无头渲染动作连续帧 → `frame-strips/*.png` 供审阅 |
| `scripts/part-analysis.mjs <参数名>` | **顶点级**测量：参数对每个组件的位移/透明度影响 |

默认交互映射（在 `src/client/live2d/PetLive2D.js` 的 `motionForState` 与 `src/client/index.js` 中修改）：单击=点头（TapBody）、右键/出错=摇头（Sad）、空闲 30s=打盹（Drowse 循环）、空闲随机=待机变奏（IdleVar）。映射是示例性质的——不同模型的参数集不同，**先用试驾台确认哪些参数有效再定制动作**（某个模型的具体校准记录见 `motions-specs/PARAM-NOTES.md`，它是随附的示例，不属于插件通用部分）。

### 关键架构结论（踩坑记录）

- pixi-live2d-display 的内部模型更新（物理→网格→参数恢复）发生在**渲染阶段**；参数写入必须挂到其 `beforeModelUpdate` 事件（物理之后、网格计算之前），ticker 里的写入会被渲染阶段的 save/load 三明治洗掉。
- 参数 `readback` 被 loadParameters 恢复为旧值属正常——**视觉网格才是真值**，测试以截图像素差断言。
- Cubism Core 的 UMD 若被当作代码打包会覆写 bundle 导出——以文本打包 + 间接 eval（见 `src/client/live2d/setup.js`）。

## 孵化像素宠物

### 方式 A：让 agent 用 skill

把 `.dsh/skills/pet-hatch/` 复制到 `~/.dsh/skills/pet-hatch/`（或项目 `.dsh/skills/` 下），对 DSH 说"把这张图做成桌宠"即可。

### 方式 B：直接跑脚本

```bash
node .dsh/skills/pet-hatch/build-atlas.mjs \
  --source <图片> --name <kebab-case-id> \
  --display-name "<显示名>" --description "<介绍>" \
  [--out ~/.dsh/pets/<id>] [--chroma auto|#RRGGBB|none] [--format webp|png]
```

- **PNG 源图**：零依赖纯 Node 路径（自带 PNG 编解码器）。
- **JPEG/WebP/GIF**：需要 `sharp`（`npm install` 后即可）。
- 全离线、确定性：一张主图 + 微变换（位移/旋转/压扁/镜像）程序化生成 9 行 72 格动画。

## 开发与测试

```bash
npm run build:client          # esbuild 打包 + 包裹；DSH_PET_BUNDLE_ID 可换 bundle id
node scripts/smoke-client.mjs # Node 桩环境：bundle 执行 + apply 接线
node scripts/e2e-live2d.mjs   # headless Edge 端到端：动作触发/视线/拖拽/试驾台/渲染覆盖率
node scripts/frame-strip.mjs  # 动作帧条预览
node scripts/part-analysis.mjs <参数名>  # 参数→组件顶点位移测量
node scripts/breath-analysis.mjs         # 单参数的区域像素影响分析
```

## 目录结构

```
lib/index.js                    宿主插件：/api/pets 路由 + 目录扫描（零依赖）
lib/client.js                   构建产物：__ModuleLoader__ factory 包裹的 client bundle（已提交）
src/client/                     播放器源码（React；live2d/ 内含 Live2D 引导与渲染器）
scripts/                        构建与测试工具链
.dsh/skills/pet-hatch/          pet-hatch skill（SKILL.md + 图集构建器）
motions-specs/                  动作规格示例 + 参数校准记录示例
sample-pet/                     示例像素宠物产物
cordis.patch.yml                bundle patch（标准安装路径使用）
```

## 许可

- 本插件代码：MIT。
- **Cubism Core**（`src/client/live2d/live2dcubismcore.min.js`）：受 Live2D 专有软件许可约束（个人使用免费，商用需评估）。
- **Live2D 模型素材**：版权归各自原作者，请仅在授权范围内使用。

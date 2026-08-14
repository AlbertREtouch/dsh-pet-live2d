# DSH-Pet — DSH 桌宠

把 [Codex 桌宠](https://github.com/zixuanzhou0-ai/codex-pet-director)（`/pet`）的体验搬进 DSH Web 界面：一个浮在界面角落、随会话状态改变表情动作的像素宠物，配合 `pet-hatch` skill 从任意图片孵化新宠物。

## 它长什么样 / 怎么玩

- 宠物渲染在 DSH Web GUI 的 `shell.overlay` 浮层（右下角），纯 CSS 精灵动画。
- 会话状态 → 动画映射：

| 会话状态 | 动画（图集行） |
|---|---|
| 空闲 | idle (0) |
| 输出/思考中（partial 流式输出） | review (8) |
| 工具调用中（runningCalls） | running (7)，气泡显示工具名 |
| 等你回复（pending/queue） | waiting (6) |
| 会话出错（lastAgentError） | failed (5) |
| 单击宠物 | waving (3) |
| 双击宠物 | jumping (4) |

- 交互（Live2D 安可）：**拖动**移动位置（记住位置）、**单击**=点头、**右键**=摇头、**双击**无动画（已按需删除）；空闲 30s=打盹、空闲随机=待机变奏；视线跟随鼠标、自动眨眼、呼吸与发丝物理。
- 宠物目录 `/api/pets` 每 30 秒轮询一次，孵化新宠物后**刷新页面（F5）**即可看到。

## 架构（三层，对应 Codex pet 的分层）

| 层 | 文件 | 作用 |
|---|---|---|
| 播放器（client plugin） | `src/client/index.js` → `lib/client.js` | 注册进 `shell.overlay` slot；订阅 `ctx.sessions` 的会话快照，映射到 9 种动画；渲染图集、处理拖动/点击/切换 |
| 资产服务（host plugin） | `lib/index.js` | 注册 `/api/pets`（列表）与 `/api/pets/<id>/spritesheet`（字节）；扫描 `~/.dsh/pets/<id>/`（`pet.json` + `spritesheet.webp|png|gif`），与 Codex 的 `~/.codex/pets/` 布局同构 |
| 生成器（skill） | `.dsh/skills/pet-hatch/`（`SKILL.md` + `build-atlas.mjs`） | 从一张图生成 **1536×1872、8 列 × 9 行、每格 192×208** 的 Codex 兼容图集 + `pet.json` |

插件包是 **dual-face** 的：`package.json` 声明 `dsh.bundle.patch`（组合层：插入 `dsh-pet` 条目）与 `dsh.client`（浏览器半）；`exports["./client"]` 指向构建好的 bundle，由 `@deepseek-ai/dsh-client-modules` 扫描进 `window.__DSH_BOOT__` 并在 `/plugins/<id>/client.js` 提供。

## Live2D 通道（Cubism 4 模型）

除像素图集宠物外，DSH-Pet 支持直接渲染 **Live2D Cubism 4 模型**（网格变形 + 骨骼 + 发丝物理）：

- **目录约定**：`~/.dsh/pets/<id>/` 下放模型文件（`.moc3`/`.model3.json`/`.physics3.json`/纹理等，可含子目录），`pet.json` 声明：

```json
{ "id": "anko", "displayName": "安可", "kind": "live2d", "model": "352.model3.json" }
```

- **资产服务**：`GET /api/pets/<id>/assets/<相对路径>` 提供任意模型文件（json/png/moc3…，带路径穿越防护）；模型内相对引用自动解析。
- **运行时**：pixi.js 6.5 + pixi-live2d-display 0.4（cubism4）+ Cubism Core 5.1（`src/client/live2d/live2dcubismcore.min.js`，官方 Core 以文本方式打包、运行时在全局作用域执行——详见 `setup.js` 注释）。物理（physics3.json）自动生效；播放器额外驱动：自动眨眼、视线跟随（头部角度+眼珠）、单击=微笑+摇头、双击=整只跳起、拖动=挪位置。
- **状态映射**：当前 milestone 主要做表情/互动；会话状态→参数动画可继续加（思考=歪头、出错=眉毛下压等）。
- **深链选择**：`http://127.0.0.1:3080/?dsh-pet=anko` 强制选中指定宠物（测试与分享用）。
- **已知限制**：模型包若无 motion3.json/exp3.json（如安可素材），只有呼吸/物理/参数动画，没有打包好的挥手/跳跃动作。
- **许可**：Cubism Core 受 Live2D 专有软件许可约束；模型素材版权归原作者，仅供个人学习使用。

### 端到端测试（无需人工）

```bash
node scripts/smoke-client.mjs   # Node 桩环境：bundle 执行 + apply 接线
node scripts/e2e-live2d.mjs     # puppeteer-core 驱动 headless Edge：真实加载页面
                                # → 强制选 anko → 等模型挂载 → DOM/控制台/截图像素验证
```

`e2e-live2d.mjs` 输出页面状态、模型尺寸/缩放、截图非透明像素覆盖率（当前模型：500x500 → scale 0.68 → 覆盖率 100%）。

## 定制 Motion 生产线（为运行时模型做动画，无需 Cubism Editor）

motion3.json 本质是"参数 ID + 时间曲线"——**没有原工程也能为安可这类运行时模型定制动作**。工具链：

| 工具 | 用途 |
|---|---|
| `scripts/motion-gen.mjs <spec.json> --apply` | 曲线 DSL（sine/damped/pulse/ramp/keys）→ 合法 motion3.json；按参数表校验/裁剪范围；`--apply` 直接安装进 `~/.dsh/pets/anko/motions/` 并挂载到 352.model3.json 的 Motions 组 |
| `motions-specs/*.json` | 动作规格（nod/shake/shy/drowse/idle-var），改数字即可调幅度/速度 |
| `?dsh-pet-debug=1` 试驾台 | 页面滑杆实时驱动参数（经渲染阶段钩子直写网格），用于校准"参数→观感" |
| `scripts/frame-strip.mjs` | 无头渲染每个动作的连续帧 → `frame-strips/*.png` 供人工审阅 |

**已装动作与触发**：单击=点头(TapBody/nod，幅度 16°)、右键或出错=摇头(Sad，幅度 20°)、空闲 30s=打盹(Drowse 循环)、空闲随机=待机变奏(IdleVar)。害羞(Shy)动作文件已生成但当前未映射触发（双击动画已按需删除）。

**关键架构结论**（踩坑记录）：
- pixi-live2d-display 的内部模型更新（物理→网格→参数恢复）发生在**渲染阶段**；参数写入必须挂到其 `beforeModelUpdate` 事件（物理之后、网格计算之前），ticker 里的写入会被渲染阶段的 save/load 三明治洗掉。
- 参数 `readback` 被 loadParameters 恢复为旧值属正常——**视觉网格才是真值**，测试以截图像素差断言。
- Cubism Core 的 UMD 若被当作代码打包会覆写 bundle 导出——以文本打包 + 间接 eval（见 `src/client/live2d/setup.js`）。
- 安可 rig 的已知事实（试驾台可自行验证更多）：`ParamAngleX` 头部转向变形幅度小；`ParamEyeLOpen` **无视觉绑定**（参数存在但网格未绑定，眼睛开关需换参数或接受静态眼）。

## 快速开始（本机已装好的状态）

当前这台机器已经 live 安装并验证：

- 插件：`~/.dsh/profiles/web/cordis.patch.yml` 插入了 `dsh-pet3` 条目，解析到 `~/.dsh/packages/dsh-pet3/`（经 `~/.dsh/profiles/node_modules/dsh-pet3` 链接）。该包 = 本仓库构建产物的快照。
- 宠物：`~/.dsh/pets/dsh-kitten/`（像素猫）、`dsh-blob/`（粉团子）、`anko/`（Live2D 模型，`kind: "live2d"`）。
- 刷新 DSH Web 页面（http://127.0.0.1:3080）后**右键宠物**循环切换三种宠物。

> 为什么条目名是 `dsh-pet-live` 而不是 `dsh-pet`：live 热挂载期间 Node 的 ESM 解析缓存按 specifier 缓存了旧 URL。重启一次 `dsh web` 后缓存清空，你可以把 patch 里的名字改回 `dsh-pet` 并直接链接本仓库（见下文"标准安装"）。

## 孵化新宠物

### 方式 A：让 agent 用 skill

对 DSH 说"把这张图做成桌宠"即可（`pet-hatch` skill 已在本仓库 `.dsh/skills/` 下，本会话可见）。skill 会运行：

```bash
node .dsh/skills/pet-hatch/build-atlas.mjs \
  --source <图片> --name <kebab-case-id> \
  --display-name "<显示名>" --description "<介绍>" \
  [--out ~/.dsh/pets/<id>] [--chroma auto|#RRGGBB|none] [--format webp|png]
```

- **PNG 源图**：零依赖纯 Node 路径（自带 PNG 编解码器）。
- **JPEG/WebP/GIF**：需要 `sharp`（本仓库 `npm install` 后即可）。
- 全离线、确定性：一张主图 + 微变换（位移/旋转/压扁/镜像）程序化生成 9 行 72 格动画。

全局可用（所有项目）：把 `.dsh/skills/pet-hatch/` 复制到 `~/.dsh/skills/pet-hatch/`。

### 方式 B：直接跑脚本

同上的命令行，产物 `pet.json + spritesheet` 放进 `~/.dsh/pets/<id>/`，刷新页面。

## 安装到其他机器

### 标准安装（npm 包 / 本地路径，需重启一次）

```bash
# 在 DSH-Pet 仓库里先构建 client bundle（lib/client.js 已提交，可跳过）
npm install && npm run build:client

# 安装为 web profile 的 bundle（dsh 会调用 pnpm；自动写入 dsh.profile.bundles）
dsh plugin --profile web add <D:\Projects\DSH-Pet>
# 重启 dsh web 生效（bundle 列表在启动时读取）
```

### 免重启 live 安装（用户 patch 层，本机用的方式）

1. 把插件包放进 loader 可解析的位置：

```powershell
New-Item -ItemType Junction -Path "$env:DSH_HOME\profiles\node_modules\dsh-pet" -Target "D:\Projects\DSH-Pet"
```

2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 添加条目（profile 的 patch 有 live watcher，**无需重启**）：

```yaml
- insert:
    - id: dsh-pet
      name: 'dsh-pet'
      inject: [webServer]
```

> ⚠️ 实测踩坑（重要）：
> - **修改 patch 时必须先写回空列表 `[]`，等条目卸载后（约 3 秒）再写新条目**。非空 → 非空的直接替换会因新旧条目同时注册 `/api/pets` 路由（duplicate route）导致新条目挂载失败、整棵新树被回滚。
> - **写 package.json 千万别用 Windows PowerShell 的 `Set-Content -Encoding UTF8`（会加 BOM）**，BOM 会让 client-modules 的 `JSON.parse` 静默失败——宿主插件正常、路由正常，但浏览器半永远不进 boot 图（表现为 `[]` 但页面没有宠物）。用 node/编辑器写。
> - ESM 解析/模块缓存按 specifier 生效：改了插件代码后，`dsh-pet` 这个 specifier 在本进程内会一直返回旧模块。要么换一个 specifier 名（如 `dsh-pet-live`，同时用 `DSH_PET_BUNDLE_ID=<同名> node scripts/build-client.mjs` 重打 bundle 并改 bundle 内 id），要么重启 `dsh web`。

### 验证

```powershell
curl http://127.0.0.1:3080/api/pets                 # 宠物列表
curl http://127.0.0.1:3080/api/pets/<id>/spritesheet  # 图集字节
# 页面源码里 window.__DSH_BOOT__ 应包含 dsh-pet 行
# /plugins/dsh-pet/client.js 应返回 200
```

## 卸载

1. 从 `~/.dsh/profiles/web/cordis.patch.yml` 删除 `dsh-pet` 条目（先 `[]` 再删，避免回滚问题）。
2. `cmd /c rmdir ~/.dsh/profiles/node_modules/dsh-pet`（junction 用 rmdir 删）。
3. 删除宠物：`rm -r ~/.dsh/pets/<id>`。
4. （若走 bundle 安装）`dsh plugin --profile web remove dsh-pet`。

## 目录结构

```
lib/index.js                    宿主插件：/api/pets 路由 + 目录扫描（零依赖，纯 node 内置模块）
lib/client.js                   构建产物：__ModuleLoader__ factory 包裹的 client bundle（提交在仓库里）
src/client/index.js             播放器源码（React + useSyncExternalStore；外置 react 等平台种子模块）
scripts/build-client.mjs        esbuild 打包 + 包裹；DSH_PET_BUNDLE_ID 环境变量可换 bundle id
scripts/make-sample-source.mjs  示例像素小猫源图生成器（纯 Node）
scripts/check-atlas.mjs         图集结构校验（尺寸/各行动画 bbox/空白补位）
scripts/test-host-logic.mjs     宿主扫描逻辑单元测试
.dsh/skills/pet-hatch/          pet-hatch skill（SKILL.md + 零依赖/可选 sharp 的图集构建器）
sample-pet/                     示例宠物产物（pet.json + spritesheet.webp）
cordis.patch.yml                bundle patch（标准安装路径使用，内容与 live 安装的条目一致）
```

## 图集契约（与 Codex hatch-pet 同构）

- 尺寸 **1536×1872**：8 列 × 9 行，每格 **192×208**，透明底。
- 9 行 = 9 状态；每行有效帧数：idle 6、running-right 8、running-left 8、waving 4、jumping 5、failed 8、waiting 6、running 6、review 6；行尾未用帧保持全透明。
- 想换动画：编辑 `build-atlas.mjs` 的 `ROWS` 表（`base`/`shift:x:y`/`rotate:deg`/`squash:sy`/`flip`）。
- 宠物可与 Codex 宠物互换（同一格式），也可以把现成的 Codex 宠物目录直接复制进 `~/.dsh/pets/`。

# DEVLOG

> 开发日志。条目状态：探索中 / 已确认 / 已废弃 / 待同步 / 已同步。

---

## [2026-08-14 18:43] 架构分析与"宠物反客为主"拆分构想 — 已同步

> 本条目为**研究 + 设计构想**，尚未动手改代码。目的：把"保留核心实现、把宠物从 DSH 插件形态解耦为独立主体"的完整思路落成文字，供更强的 agent 审视后再决定实施路径。

### 0. 背景与动机

- 仓库：fork 自 `YilunLi-999/dsh-pet-live2d` → `AlbertREtouch/dsh-pet-live2d`（public），已用 Sapling（`.sl`）克隆到 `C:\MyCodeProject\live2D_pet`，`default` remote 指向 fork。
- 项目本体：**dsh-pet** —— DeepSeek Harness（DSH）Web 界面的桌宠插件。支持两类宠物：
  - 像素图集宠物（Codex 兼容格式，`pet-hatch` skill 从图片孵化）
  - Live2D 模型宠物（Cubism 4，`.moc3` 运行时渲染 + 免 Cubism Editor 的 motion 生产线）
- 动机（用户原话归纳）：
  1. **保留核心实现**：原作者在 Live2D 渲染、motion 生成上踩了大量坑（渲染阶段参数写入时序、Cubism Core 打包方式等），这部分不想改动。
  2. **宠物独立存在**：希望宠物可以不依附 DSH 单独启动。
  3. **反转关系**：反过来由宠物启动 DSH web——DSH 变成宠物"状态接口"的一个实现。
  4. **多源接入**：更远把 Codex 等别的系统也接进来当状态源。
- 本文档 = 现状架构梳理 + 依赖矩阵 + 拆分构想 + 风险清单 + 待审视问题。**结论不构成最终决策**。

---

### 1. 现状架构（直白版）

整体是**寄生在 DSH 插件协议里的三件套**：

```
┌─────────────────────────── DSH web 进程/页面 ───────────────────────────┐
│                                                                          │
│  浏览器半（client plugin）                    服务端半（host plugin）      │
│  lib/client.js（esbuild 产物）                lib/index.js（零依赖 Node） │
│  · apply(ctx) 挂 shell.overlay slot           · ctx.webServer.register    │
│  · ctx.sessions 订阅会话快照                    · /api/pets 路由三件        │
│  · 轮询 /api/pets（30s）                       · 扫描 ~/.dsh/pets/<id>/    │
│  · 渲染像素图集 / Live2D 模型                                            │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ 核心：src/client/live2d/ + scripts/ + .dsh/skills/pet-hatch/      │    │
│  │（渲染器、motion 生产线、孵化器——与 DSH 无关的部分）               │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

#### 1.1 播放器（浏览器半）— `src/client/index.js`（→ 产物 `lib/client.js`）

关键机制：

- **插件协议**：`export const inject = ["slots", "sessions"]`；`export function apply(ctx)` 中 `ctx.slots.register({name: "shell.overlay", id: "dsh-pet"}, PetOverlay)` 挂载浮层；`ctx.effect(...)` 注册副作用（挂载 + CSS 注入）。
- **状态订阅**（`useCurrentSnapshot`，index.js:101-121）：`useSyncExternalStore` 订阅 `sessions.list` → 取当前会话 `current` → `sessions.binding(currentId)?.session` → 再订阅该 session 的 getSnapshot。**这是与 DSH 会话系统的唯一数据通道。**
- **心情推导**（`deriveState`，index.js:88-98，精确顺序）：`lastAgentError` → failed；`running===true` 时：`runningCalls.length>0` → running、`partial` → review、**两者皆无也 → waiting**；`running` 非 true 且 `pending.length>0` → waiting；否则 idle。**这个函数本质上就是"DSH 快照 → 归一化宠物状态"的适配器。**
- **宠物列表**（`usePets`，index.js:124-148）：`fetch("/api/pets")` 首次 + 30s 轮询。
- **交互**：单击=waving（点头）、右键=failed（摇头）、拖拽位置持久化（localStorage `dsh-pet:position`）、`?dsh-pet=<id>` 深链选宠、`?dsh-pet-debug=1` 试驾台。注：拖拽代码计算了 `vx/vy` 但从未使用（没有惯性甩出，属死代码）；`src/client/index.js:14-15` 头部注释（双击跳、右键循环选宠）与实际实现不符——两处都列入 Phase 0 清理。
- **像素宠物渲染**：CSS `background-position` 切帧（8 列 × 9 行图集），跳行动画由播放器做抛物线抬升（`jumpLift`）。
- **Live2D 宠物渲染**：委托给 `<PetLive2D pet={pet} mood={mood} state={state} />`（`src/client/live2d/PetLive2D.js`）。
- **诊断**：`probe(event, data)`（`src/client/probe.js:4` 同样硬编码 `/api/pets/echo`）→ 服务端写 `homedir()/.dsh/pets-echo.log`。当前实现忽略 `$DSH_HOME`（与 pets 根目录解析不一致），独立形态必须改为注入式 `echoPath`。
- **主题**：CSS 用 DSH 变量 `--dsw-alias-*`（带 fallback，所以非 DSH 环境也能显示）。

#### 1.2 资产服务（服务端半）— `lib/index.js`

- **协议**：`export const inject = ["webServer"]`；`ctx.webServer.register({kind: "prefix", path: "/api/pets", handler})`。
- **路由**：
  - `GET /api/pets` → 宠物目录 JSON（每次请求现扫磁盘，新宠物免重启出现）
  - `GET /api/pets/<id>/spritesheet` → 图集字节（webp/png/gif 回退链）
  - `GET /api/pets/<id>/assets/<路径>` → Live2D 模型任意文件（`.moc3`/`.model3.json`/`.physics3.json`/纹理/motions），带路径穿越防护（resolve 后必须落在宠物目录内）
  - `POST /api/pets/echo` → 诊断通道
- **宠物根目录解析**（`defaultPetsRoot`）：`$DSH_PET_ROOT` > `$DSH_HOME/pets` > `~/.dsh/pets`。
- **目录约定**：`<root>/<pet-id>/pet.json` + 资产；`pet.json` 两种形态（sprite：`spritesheetPath`；live2d：`kind:"live2d"` + `model` 相对路径）。无清单或无可渲染资产则不收养。
- 零第三方依赖，纯 `node:fs`/`node:path`/`node:os`/`node:http` 风格。

#### 1.3 核心实现（要保留的部分）— 与 DSH 无关

**Live2D 渲染器** `src/client/live2d/PetLive2D.js`（React 组件，326 行）：

- 挂载 PIXI `Application`（240×340 透明 canvas，`sharedTicker: true`），`Live2DModel.registerTicker(PIXI.Ticker)`。
- 模型 URL 来自 `/api/pets/<id>/assets/<model>`（**唯一的 DSH 耦合点之一**）。
- `Live2DModel.from(url, {autoInteract:false, autoUpdate:false})` —— **autoUpdate:false 是关键**：库内部更新（motions+physics）由自家 tick 的 `model.update(delta)` 驱动，且参数写入挂在 `beforeModelUpdate` 事件（物理之后、网格计算之前）——这是原作者踩坑后确认的**唯一有效写入时机**（README"关键架构结论"）。
- 参数驱动引擎（`applyParams`，PetLive2D.js:186-229）：
  - 视线跟随：指针相对宠物盒归一化 → `ParamAngleX/Y` 缓动（Y 取负，Live2D 约定）
  - 心情脉冲：waving → `ParamAngleZ` 正弦摆头
  - 眨眼状态机：closing(80ms) → closed(50ms) → opening(100ms)，间隔 3200ms±
  - 试驾台 overrides 永远最后写、优先级最高
- 空闲行为（tick 内）：idle 态累计 30s → `Drowse` 循环 motion；8-20s 随机 → `IdleVar`。
- 状态→动作映射（`motionForState`）：waving → `["TapBody",0]`，failed → `["Sad",0]`。
- 调试钩子：`window.__dshPetDebug = {app, model, modelRef, ...}`（测试与手动调试用）。
- 卸载：销毁 tick、off beforeModelUpdate、destroy model、destroy app。

**Cubism Core 引导** `src/client/live2d/setup.js`（20 行，**必须原样保留**）：

- `live2dcubismcore.min.js` 以 **TEXT 资源打包**（见 build-client.mjs），运行时 `(0, eval)(coreSource)` 间接求值 → UMD 走浏览器全局分支 → `globalThis.Live2DCubismCore`。
- 踩坑原因：当代码打包会执行 CJS 分支覆写 bundle 的 `module.exports`；`new Function` 作用域会把 `var` 留在局部；只有全局间接 eval 等价于 `<script>` 标签加载。

**motion 生产线** `scripts/`（纯 Node，不认识 DSH）：

- `motion-gen.mjs <spec.json> --apply [--pet <id>] [--model3 <文件名>]`：曲线 DSL（sine/damped/pulse/ramp/keys）→ 合法 motion3.json；按参数表校验/裁剪；`--apply` 装进宠物目录并挂 Motions 组。
- `motions-specs/*.json`：动作规格示例（nod/shake/drowse/idle-var 等）。
- `frame-strip.mjs`：无头渲染动作连续帧 → `frame-strips/*.png` 审阅。
- `part-analysis.mjs <参数名>`：顶点级测量参数对组件位移/透明度影响。
- `breath-analysis.mjs`：单参数区域像素影响分析。

**孵化器** `.dsh/skills/pet-hatch/`：`build-atlas.mjs` 从一张图程序化生成 1536×1872、8×9 格（192×208/格）Codex 兼容图集 + pet.json。PNG 源图零依赖；JPEG/WebP/GIF 需 `sharp`。全离线确定性。

**测试链**：`smoke-client.mjs`（Node 桩环境跑 bundle）、`e2e-live2d.mjs`（headless Edge 端到端：动作触发/视线/拖拽/试驾台/渲染覆盖率）、`check-atlas.mjs`、`test-host-logic.mjs`、`test-resolvemeta.mjs`。

#### 1.4 打包与安装形态

- `package.json` **dual-face**：`dsh.bundle.patch`（组合层 patch，`cordis.patch.yml`）+ `dsh.client`（`platform: "web"`）；`exports["./client"]` → `lib/client.js`。
- `scripts/build-client.mjs`：esbuild 打包 React/Pixi/pixi-live2d-display + **Cubism Core 文本打包**，产物用 `__ModuleLoader__` factory 包裹，`lib/client.js` 已提交。
- 安装：`dsh plugin --profile web add`（bundle 方式）或 junction + `cordis.patch.yml` 条目（live 方式，有"先写 `[]` 再写新条目"的坑——README 记录）。

---

### 2. 依赖矩阵：哪些必须依赖 DSH，哪些其实不依赖

**结论先行：现状必须依赖 DSH 才能启动（插件形态），但真正的"锁死点"只有 4 处，全部集中在入口胶水；核心几乎已经解耦。**

| # | 耦合点 | 位置 | 耦合内容 | 拆除方式（构想） |
|---|---|---|---|---|
| C1 | 插件协议 `apply(ctx)` / `inject` / `ctx.effect` / slots | `src/client/index.js:434-460` | 由 DSH client-modules 加载进 boot 图，挂载到 `shell.overlay` slot | 抽薄胶水层：`apply(ctx)` 只做"接线"，渲染核心不感知 ctx |
| C2 | 会话订阅 `ctx.sessions` | `src/client/index.js:101-121` | 快照→心情的数据通道 | 抽象 `PetStateSource` 接口，DSH 适配器封装这段逻辑（原样搬移） |
| C3 | 资产/诊断 URL 写死 `/api/pets/...` | `index.js:129,401` + `PetLive2D.js:133` + `probe.js:4` | 图集/模型/诊断（probe）都走 DSH webServer 路由 | 注入 `assetBase` / `fetchAsset(url)` / `probeFn`；裸 Node 服务可提供同构路由 |
| C4 | 路由注册 `ctx.webServer.register` | `lib/index.js:224-227` | 宿主进程内挂路由 | 抽出并导出 `createPetServer(options)` 工厂：现 routeHandler 与 DSH 协议无关，但**尚未导出**、echo 路径写死、且并非纯函数（含 fs 副作用），需先参数化再复用 |

**其余全部与 DSH 无关**：渲染核心（Pixi + pixi-live2d-display + Cubism Core 都是通用浏览器库）、motion 生产线、pet-hatch、图集契约（本就是 Codex `hatch-pet` 同构）、宠物目录约定、CSS（`--dsw-alias-*` 全部带 fallback）。

> 注意"运行时零依赖"的边界：浏览器 bundle 把 `react`/`react-dom`/`react/jsx-runtime` 列为 external，当前由 **DSH seed table** 提供；standalone 目标必须改为把 React 打进 bundle（或自行提供等价 seed），否则独立形态跑不起来。

**附带依赖清单**（devDependencies）：esbuild（构建）、pixi.js ^6.5.10、pixi-live2d-display ^0.4.0（渲染）、puppeteer-core（e2e 测试）、sharp（JPEG 源图孵化）、url。运行时零 npm 依赖（lib/index.js 零依赖；浏览器半全打包进 lib/client.js）。

---

### 3. 拆分构想：宠物反客为主

#### 3.1 核心抽象：状态源接口 + 归一化状态

现在的 `deriveState(snap)`（index.js:88-98）本质上就是"DSH 快照 → 归一化宠物状态"的适配器。把它接口化：

```ts
// 归一化状态（宠物唯一消费的状态形状）
interface PetState {
  version: 1;          // 协议版本（postMessage / 跨进程都要带）
  source: string;      // 来源标识（dsh / codex / local / mock …）
  activity: string;    // 配置注册的状态 key；内置 baseline：idle/review/running/waiting/failed
  detail?: {
    toolName?: string;   // 当前工具名（气泡文案用）
    message?: string;    // 错误信息等
    since?: number;      // 进入该状态的时间戳
  };
}

// 状态源接口（宠物只认识它）
interface PetStateSource {
  subscribe(listener: () => void): () => void;  // 返回退订函数
  getSnapshot(): PetState | null;
  dispose(): void;
}
```

现有 `deriveState` + `useCurrentSnapshot` 原封不动搬进 DSH 适配器 = **DSH 从此只是状态源的一个实现**。

**配置驱动扩展（用户方向，已确认）**：状态 key 不是写死的枚举，而是配置注册的字符串：

- 内置 baseline 五个（idle/review/running/waiting/failed）保证开箱即用；
- 性格预设/用户配置可以注册新 key（如 `speaking`/`coding`/`celebrating`），并把它**映射**到现有渲染动作（像素 9 行里挑一行、Live2D 挑动作组/参数动画、气泡文案模板）；
- 未注册 key 回落到 idle（或最近一次已知状态），接口和内核都不需要为每个新心情改代码；
- 像素图集的 9 行是资产上限不是接口上限——真正的新动画可以以后扩展图集格式，先靠映射复用。

**分层补充（review 后确认）**：`PetState` 只承载**状态源派生态**；单击/右键等**本地交互**是另一层（现有 `mood` one-shot），不进入状态源接口：

- `InteractionState { gesture: "none" | "waving" | "jumping" | "failed"; until: number }`
- 渲染时有效状态 = 交互态优先于后端 `activity`；气泡文案等 `detail` 仍来自后端。
- 这样"像素 9 行 vs Live2D 动作组"只影响**展示映射表**，不影响状态源接口。

#### 3.2 目标分层

```
┌────────────────────────────────────────────────────────┐
│  Pet 主体（框架无关的共享内核，一行踩坑代码不改）        │
│  · PetRuntime：状态总线 + 渲染 + 驱动引擎（shared）      │
│  · 皮肤层：sprite / live2d 资产，运行时可切换            │
│  · 性格层：行为预设（映射/节奏/交互/文案），可切换        │
│  · PetHost：资产服务（createPetServer 工厂复用）          │
└────────────────────────┬───────────────────────────────┘
                         │ PetStateSource 适配器
        ┌────────────────┼────────────────┬───────────────┐
   DSH 适配器        Codex 适配器      本地 CLI 适配器   模拟/演示适配器
   (ctx.sessions)   (CODEX_HOME 会话)  (进程 stdout)     (定时器喂心情)
```

#### 3.3 Phase 0：机械解耦（零行为变化，建议第一步）

1. 目录重组：`src/client/live2d/`、`scripts/`、`.dsh/skills/pet-hatch/`、`motions-specs/` 视为核心，**内容一行不动**（注释级修正除外）。
2. `PetLive2D` 注射化：模型 URL 由 props 传入（默认拼接 `assetBase`）；`probe` 改为注入回调（默认 no-op 或 console）。
3. 抽出 `PetStateBus` + DSH 适配器（`src/adapters/dsh.js`：订阅逻辑 + deriveState 原样搬移）；`PetStateBus` 只管后端派生态，交互 one-shot 单独一层（见 3.1 分层补充）；activity 改成字符串 key + 内置 baseline 注册表（行为不变，但为扩展留口）。
4. 把"皮肤"和"性格"先落成数据结构：**皮肤** = 现有 pet.json 资产描述（不变）；**性格** = 内置预设对象（状态映射/交互/眨眼/空闲节奏/文案）。Phase 0 只内置 default 一份，保证行为不变，切换机制随后接上。
5. `src/client/index.js` 瘦身为胶水：`apply(ctx)` 里实例化 DSH 适配器 → 喂给渲染组件；顺带清理死代码 `vx/vy` 和过时头部注释。
6. `lib/index.js` 抽出并导出 `createPetServer({ petsRoot, echoPath, log })` 工厂：返回 `handleRequest(req, res)` 与 `register(webServer)` 两个入口，DSH 与独立 server 共用同一份路由。
7. 顺手完成独立形态的安全底线（现在不做，后面就忘）：`decodeURIComponent` 包 try/catch 回 400；echo body 限 64KB 且自动创建 `echoPath` 父目录；资产路径改用 `realpath + path.relative` 校验（防 Windows junction/symlink 逃逸）；HEAD 请求不返回 body。
8. 构建脚本双目标：DSH 目标保持 React external；standalone 目标把 React 打进 bundle（或提供等效 seed）。
9. **验证**：现有 `smoke-client.mjs` + `e2e-live2d.mjs` + `test-host-logic.mjs` 全绿（本次 review 已实测 `test-host-logic` 与 `smoke-client` 通过，e2e 需 Edge 环境未跑）；新增 `test-pet-server.mjs`（列表/资产/echo/穿越/坏 URI/超限）与 `smoke-standalone.mjs`。行为不变即可随时回滚。

#### 3.4 Phase 1：独立宠物（双击图标即开，Electron 已确认）

- **交付形态是独立程序**：Electron 壳（用户拍板）。用户双击图标/EXE 即开，不依赖手动开浏览器；`pet.html` 只是壳内部加载的渲染页面（开发预览仍可直接打开）。
- Electron 主进程内直接挂 `createPetServer`（Phase 0 已导出）绑 127.0.0.1，渲染进程加载同一 bundle 的 standalone 目标，用"模拟状态源"（定时器）驱动；`~/.dsh/pets` 目录约定保留，独立宠物直接读取同一批资产。
- 构建：esbuild 双目标（DSH 插件 bundle / standalone bundle），共享同一份源码；standalone 目标需把 React 等 external 打包进去（见 Phase 0 第 8 条）。打包用 electron-builder（安装包/便携版）。
- **皮肤切换**：皮肤 = 已安装宠物目录（sprite/live2d 都可以）；运行中通过应用菜单/托盘切换，渲染内核按皮肤描述重挂载，与性格预设解耦。
- 发布形态：`package.json` 增加 `"./server"` 与 `"./standalone"` exports，`files` 补 `lib/pet-server.js`、`lib/standalone.js`、Electron 壳入口；motion-gen 等脚本继续走仓库使用，不进 npm 包（暂不加 bin，等有需求再说）。
- 里程碑："双击图标打开一只活宠物；不装 DSH 也能用"。

#### 3.5 Phase 2：桌面壳 + 反客为主（宠物启动 DSH）

- 壳选型（**已定 Electron**，以下对比仅作留档）：
  - **Electron**：生态最顺（React/Pixi/DOM 全兼容），代价 ~100MB 体积 + 打包复杂度。
  - **WebView2**（Windows 系统自带 Edge 运行时）：壳可以做得很小，但自动化打包/分发不如 Electron 成熟。
  - **纯浏览器窗口/PWA**：零打包，但"桌面宠物"质感（置顶透明无边框）受限。
- "启动 DSH"动作：壳内 `child_process` 拉起 `dsh web` → 探测 `http://127.0.0.1:3080` → 挂 DSH 适配器。
- **状态回传方案（关键设计）**：宠物窗用 iframe 内嵌 DSH web；插件在**嵌入模式**下不再渲染宠物浮层，改为 `postMessage` 向外报告归一化状态；父窗口用同一份渲染核心画宠物。这样：
  - 插件本体几乎不用改（多一个"嵌入模式"分支）；
  - DSH 状态源的实现 = 现有会话订阅代码原样搬进适配器；
  - **嵌入模式检测**：显式 opt-in 优先——URL 带 `?dsh-pet-embed=1` 且 `window.self !== window.top` 才算嵌入，避免误判；消息带 `version` 字段；
  - **双向 origin 白名单**：父窗口只接受 `event.origin === DSH 来源` 且 `event.source === iframe.contentWindow` 的消息；插件只向写死的父窗口 `targetOrigin` 发送（随 query 传入，拒绝 `*`）；
  - **前提**：DSH 页面当前无 CSP（setup.js 已有记录）；若未来加 CSP，嵌入模式需配置放行，属独立问题。
- **DSH 进程管理（补充设计，原则：宠物只是交互器，绝不反向影响 harness）**：
  - 启动前先探测 `http://127.0.0.1:<port>/api/pets`——已在跑就直接复用，绝不双开；
  - 端口可配置（默认 3080，`DSH_PET_DSH_PORT` / 配置文件覆盖）；
  - 未运行时 `child_process` 以 **detached + unref** 拉起 `dsh web`（宠物退出后 DSH 继续活着），指数退避探测（500ms 起、最多约 20s）；
  - **宠物退出/重启/崩溃都不关闭 DSH**，不设任何"随宠物关闭"逻辑；
  - DSH 挂掉后：状态源进入 failed/offline，按退避自动重连，不影响宠物本身。
- 反转完成：**宠物进程是主人，DSH 是它按需启动/关闭/重连的一个后端。**

#### 3.6 Phase 3：多状态源

- 状态源注册表由配置驱动（按优先级/多源混合策略，如：DSH 出错 > Codex 干活 > 本地空闲；优先级表可改）。
- **性格预设切换**：`config.json` / 界面里选 preset；每个预设 = 状态映射 + 交互动作 + 眨眼/空闲节奏 + 气泡文案；用户可以新增 preset 文件，内核不改代码。
- Codex 适配器候选接入点：`CODEX_HOME` 会话文件/进程状态（图集格式本来就声明"与 Codex hatch-pet 同构"，接 Codex 状态是顺势而为）。
- 其他候选：本地 agent CLI（spawn 后解析 stdout）、文件 tail、HTTP/WebSocket 远程状态、手动演示源。

---

### 4. 风险与开放问题

| # | 风险/问题 | 说明 | 待决 |
|---|---|---|---|
| R1 | **Cubism Core 许可** | Live2D 专有许可：个人免费、商用需评估。独立分发的桌面应用 = 新的分发形态，需重新审视；模型素材（安可等）版权归原作者，不能随应用分发 | 商用前需法务评估 |
| R2 | 双目标构建漂移 | 一个 esbuild 配置出插件/独立两目标，源码必须单一 | 建立"两目标必测"的 CI/脚本 |
| R3 | React 依赖是否保留 | 核心目前是 React 组件；若独立宿主也是网页形态，继续用 React 最省事；去框架化收益低 | 倾向保留 React |
| R4 | 状态协议版本化 | `PetState` 字段会演进（如加 `progress`、`speaking`），适配器与核心需要版本协商 | 字段加 optional + 未知字段透传 |
| R5 | 远程/跨进程状态传输 | DSH 若不在宠物进程内（iframe postMessage 方案外的场景），状态源需要 HTTP/WS/文件通道；轮询频率与实时性权衡 | iframe postMessage 优先，其余后议 |
| R6 | e2e 测试的宿主耦合 | `e2e-live2d.mjs` 依赖 DSH 页面环境，standalone 形态需要新的 e2e 入口 | Phase 1 补 standalone smoke |
| R7 | 壳的自动化测试 | Electron/WebView2 壳难做无头测试 | 壳保持薄，逻辑全在 web 层可测 |
| R8 | 与上游的关系 | fork 自原作者仓库；**当前未配置 upstream 路径**（`sl paths` 仅 default→fork），跟进前需先 `sl paths add upstream <原仓库>` | 待定，倾向低频率同步 |
| R9 | 独立服务暴露面 | 现路由有 `decodeURIComponent` 抛 URIError、echo body/日志无上限、Windows junction/symlink 可逃出宠物目录、默认绑定地址未定 | Phase 0 修前三项；默认只绑 127.0.0.1，局域网暴露为显式 opt-in |
| R10 | 双目标 external 差异 | DSH 目标 React external 靠 seed table；standalone 若忘记打包 React 会白屏 | 构建脚本强制两目标同时出产物并各自 smoke |
| R11 | DSH 生命周期 | 宠物启动 DSH 需处理已运行、端口、崩溃重连；**宠物退出绝不关闭 harness**（spawn detached） | 见 3.5 进程管理补充；壳保持薄 |
| R12 | npm 发布形态 | 现 `files` 只含 lib/ + patch，独立 server/standalone 入口未规划 | Phase 1 发布前补 exports/files；scripts 不进包 |

---

### 5. 待审视问题清单（交给更强的 agent；review 意见与补充设计见文末新条目）

1. 状态源抽象（3.1）是否过度设计？接口形状（subscribe/getSnapshot/dispose）是否是最小正确集？
2. `PetState.activity` 五态（idle/review/running/waiting/failed）是否够用？Codex/其他 agent 的状态能否无损映射？（对照：像素图集 9 行 = idle/running-right/running-left/waving/jumping/failed/waiting/running/review，Live2D 动作组映射是示例性质的）
3. 嵌入模式 postMessage 方案（3.5）的坑：iframe 内插件如何检测嵌入模式？双份渲染如何避免（插件在嵌入模式只导出状态不渲染）？DSH 的 CSP/安全策略是否允许 postMessage 透传？
4. 桌面壳选型（Electron vs WebView2 vs PWA）按"开发成本 × 分发体积 × 置顶透明无边框能力"怎么权衡？
5. 是否值得拆 monorepo（`packages/pet-core` / `packages/dsh-plugin` / `packages/pet-desktop`）？还是单仓库目录分层就够？
6. Phase 0 的目录重组会不会破坏 `lib/client.js` 已提交产物的消费者（`dsh plugin add` 路径、`exports["./client"]` 契约）？
7. motion 生产线（motion-gen 等）是否需要为"独立宠物"形态增加"无 DSH 直接编辑本地宠物目录"的路径（目前 `--pet <id>` 就是文件系统直写，似乎已满足）？
8. 资产服务的路径穿越防护、`SAFE_ID` 校验在独立形态下是否需要加固（暴露面从本机 DSH 变为可能的局域网）？

---

### 6. 后续动作

- [x] review 完成：事实修正 + 补充设计已写入本条目及文末修订条目（2026-08-14）
- [x] 用户批准设计：创建 `PROJECT.md` 并同步架构决策（2026-08-14）
- [ ] 实施 Phase 0（机械解耦，行为零变化）

---

## [2026-08-14 19:14] Review 修订 + 补充设计 — 已同步

> 对上一条目的 review（逐条对照代码 + 实测 `test-host-logic.mjs` / `smoke-client.mjs`）后所做的修订与设计补完。本条目不影响"结论待批准"的性质。

### A. 修订清单（已直接改入上一条目）

1. `deriveState` 补全 `running===true` 且无 calls/partial 时也返回 waiting 的分支。
2. 删除"拖拽带惯性"表述：`vx/vy` 计算了但从未使用（死代码）；同时记录 `index.js` 头部注释与实际交互不符。
3. C3 补上第 4 处硬编码 URL：`src/client/probe.js:4`（诊断通道）。
4. C4 改为：`routeHandler` 尚未导出、echo 路径写死、并非纯函数，需抽 `createPetServer(options)` 工厂。
5. "运行时零依赖"补边界：React 系列是 external，由 DSH seed table 提供；standalone 目标必须自行打包。
6. echo 日志路径与 `$DSH_HOME` 不一致问题入文。
7. R8 补"upstream 路径未配置"；风险表新增 R9-R12。
8. Phase 0/1/2 补安全底线、构建双目标、发布形态、嵌入检测、origin 白名单、DSH 进程管理。

### B. 关键决策（已获用户批准）

1. **保留 React**：核心继续是 React 组件；standalone 目标把 React 打进 bundle。现在去框架化收益为负。
2. **不拆 monorepo**：单仓库 `src/` 分层（core / adapters / entries），拆包等 pet-core 出现外部消费者再说。
3. **状态分两层 + 配置驱动**：`PetState`（状态源派生）与 `InteractionState`（本地交互 one-shot）分开，合并逻辑放 `PetStateBus`；`activity` 是配置注册的字符串 key（内置五个 baseline），扩展心情靠配置映射，不改内核。
4. **壳选型（用户拍板：Electron）**：交付独立可执行程序，双击图标即开；`pet.html` 仅作为壳内部页面/开发预览。WebView2 / PWA 归档为不采用。
5. **宠物是纯交互器**：只读状态、可帮忙拉起 DSH；退出/重启/崩溃绝不关闭它连接的 harness（`spawn detached + unref`）。
6. **皮肤与性格**：共享内核之上，皮肤 = 资产（sprite/live2d，运行时可切）；性格 = 行为预设配置（状态映射/交互/节奏/文案，运行时可切）。默认各内置一份，用户可新增。
7. **安全默认值**：独立 server 默认只绑 127.0.0.1；局域网暴露显式 opt-in；URI 解码/echo 上限/realpath 校验在 Phase 0 就修。
8. **多状态源合并策略（Phase 3 预告）**：优先级表配置化，默认 `DSH failed > 任一源 running > waiting > review > idle`；接口上先要求每个源输出 `{ activity, detail, source, version }`，细节到 Phase 3 再定。

### C. 已拍板事项

- 已创建 `PROJECT.md` 并同步本条目（用户批准，2026-08-14）；
- 上游同步策略：**不跟进上游**（用户决策，2026-08-14）。

### D. 后续动作

- [x] 用户批准本设计 → 创建 PROJECT.md 并同步（2026-08-14）
- [ ] 实施 Phase 0
- [ ] Phase 0 完成 → 追加验证结果条目

---

## [2026-08-14 19:27] 用户方向确认（配置驱动 / Electron / 纯交互器 / 皮肤·性格）— 已同步

> 用户拍板的新方向，已同步改写上文 3.1/3.2/3.3/3.4/3.5/3.6 与风险表。

1. **配置驱动优先**：心情状态不再写死五个；`activity` 是配置注册的字符串 key，内置五个 baseline，新状态（如说话/庆祝）通过配置映射到现有动作，内核不因新心情改代码。
2. **独立宠物 = 独立程序**：Electron 确认。交付双击图标即开的可执行程序（安装包/便携版），`pet.html` 只是壳内部页面与开发预览，用户不接触浏览器。
3. **宠物是纯交互器**：只连接/读取 harness 状态；即使宠物帮忙拉起了 DSH，宠物退出也绝不关闭它（进程 detached）。DSH 的启停不由宠物决定。
4. **皮肤可切换**：皮肤 = 已安装宠物资产（sprite / live2d），运行中通过菜单/托盘切换；与性格解耦。
5. **性格预设可切换**：性格 = 行为配置（状态→动作映射、交互响应、眨眼/空闲节奏、气泡文案），默认内置一份，用户可新增 preset 文件；内核 shared 不变。

### 后续动作

- [x] 用户批准本设计（2026-08-14）
- [x] 创建 PROJECT.md 并标记本批条目"已同步"（2026-08-14）
- [ ] 实施 Phase 0
- [ ] Phase 0 完成 → 追加验证结果条目

---

## [2026-08-14 19:38] PROJECT.md 创建 + 文档同步 — 已同步

- 经用户批准创建 `PROJECT.md`（项目唯一权威真相），沉淀：定位、当前状态、已确认决策、现状/目标架构、路线图、踩坑结论、风险与 VCS 约定。
- 上游同步策略正式记录为**不跟进**（本项目按自己的方向做）。
- DEVLOG 本批条目（18:43 / 19:14 / 19:27）全部标记"已同步"。
- 下一步：Phase 0 机械解耦（零行为变化）。

---

## [2026-08-14 19:58] Phase 0 实施完成（代码层） — 已同步

### 已完成

1. **目录分层**：新增 `src/core/`（PetOverlay / PetStateBus / personality）、`src/adapters/`（dsh-state / mock）、`src/entries/`（standalone）；`src/client/live2d/` 核心渲染器除注射化外未动。
2. **注射化**：`PetLive2D` 的模型 URL 改由 `assetBase` props 注入、`probe` 改为注入回调（默认 no-op）；`PetOverlay` 只消费 `stateSource`/`fetchPets`/`probe`/`assetBase`/`personality`。
3. **状态抽象**：`PetState {version, source, activity, detail}` + `PetStateSource {subscribe/getSnapshot/dispose}`；DSH 订阅逻辑与 `deriveState` 原样搬进 `src/adapters/dsh-state.js`；本地交互 one-shot 与状态源派生态分层。
4. **性格/皮肤数据结构**：`DEFAULT_PERSONALITY`（交互手势、状态→图集行映射、气泡文案），未知状态回落 idle。
5. **入口瘦身**：`src/client/index.js` 只剩 apply/inject/CSS 注入接线；删除了 `vx/vy` 死代码和过时交互注释；新增 `src/entries/standalone.js`（IIFE 目标，React 打进 bundle）。
6. **服务工厂**：`lib/index.js` 导出 `createPetServer({petsRoot, echoPath, log})`，返回 `handleRequest` + `register`；DSH apply 与裸 Node server 共用同一路由。
7. **安全修复**：坏 URI→400；echo body 限 64KB→413 且自动建日志父目录；资产路径 realpath + relative 校验（junction 逃逸→403）；HEAD 不返回 body；listPets 跳过根目录外的 junction。
8. **双目标构建**：`build-client.mjs` 同时产出 `lib/client.js`（DSH，React external）与 `lib/standalone.js`（IIFE，React 打入）；package.json 补 react/react-dom devDeps 与 `./standalone` export。

### 验证结果

- ✅ `scripts/smoke-client.mjs`（DSH bundle 执行 + apply 接线）
- ✅ `scripts/smoke-standalone.mjs`（standalone 不依赖 DSH seed table）
- ✅ `scripts/test-pet-server.mjs`（目录/图集/穿越/坏 URI/echo 上限/HEAD/junction 全部 PASS）
- ✅ `scripts/test-host-logic.mjs`
- ✅ `scripts/e2e-sprite.mjs`（**DSH 实机**：boot 含 dsh-pet、精灵渲染、拖拽持久化、无 pageerror）
- ✅ `scripts/e2e-live2d.mjs`（**DSH 实机**：用户提供模型 `C:\MyCodeProject\petAsset\pet\352`，装入 `~/.dsh/pets/anko`；motion-gen 现场生成 TapBody/Sad/Drowse/IdleVar 后，动作/视线/拖拽/试驾台/tick/hook/像素覆盖全 PASS）

### 实机回归抓到并修复的问题

1. `src/client/index.js` wrapper 与导入组件同名 `PetOverlay`，JSX 词法解析导致 wrapper 无限递归，DSH 页面挂死 → 改名 `DshPetOverlay`。
2. `src/core/PetOverlay.jsx` 外层返回了组件函数 `Overlay` 而非 `<Overlay />`，React 报 "Functions are not valid as a React child" 且不渲染 → 修正返回 JSX。
3. 定位手段：A/B 移除 live patch 条目确认问题在插件；`apply` 逐段二分（no-op / 仅 CSS / 仅 slot）+ echo 探针；standalone 真机预览隔离核心。诊断脚本已清理，`dev-standalone.mjs` 与 `e2e-sprite.mjs` 留作正式工具。

### 待办

- [x] DSH 实机回归（sprite 全绿）
- [x] Live2D 实机回归（e2e-live2d PASS，2026-08-14）
- [ ] 用户确认后推送 Phase 0 提交（`sl pr submit --stack`）
- [ ] 推送后把本条目同步进 PROJECT.md 并标记"已同步"

---

## [2026-08-14 19:57] 功能可行性：提醒 + 快捷批准 — 已同步

> 用户提出：宠物是否计划支持"任务进入需要用户输入的阶段时提醒"、以及"对 DSH 需要批准的操作做快捷批准"。对照本机 DSH 类型定义调研，**两个都可行，且 DSH 已有第一方通道**。

### 调研结论（DSH API 层面）

1. 会话快照 `ConversationSnapshot.pending: readonly PendingInteraction[]` 已经是权威的"等待用户"清单，包含两类：
   - `kind: "approval"`：payload = `{approvalId, toolName, callId?, reason?}`；
   - `kind: "question"`：payload = `{questions: AskUserQuestionItem[]}`（问题/选项/多选/plan-review intent）。
2. 每个 `PendingWait` 自带 `respond(result)`：内部回填 rpcId，走 `POST /api/respond`。
   - 批准：`respond({ ok: true, value: { sessionId, approvalId, outcome: "allowed-once" } })`；
   - 拒绝：`outcome: "rejected"`；
   - 回答问题：`respond({ ok: true, value: { sessionId, answer: { answers: [...] } } })`。
   - 挂起项 settlement 由 `approval/resolved` / `question/resolved` 帧驱动，无需宠物维护状态。
3. 现有 `deriveState` 只把 `pending.length>0` 折叠成 `waiting`——**信息已经到手，只是没拆开用**。

### 计划形态（待用户拍板后进 PROJECT）

- **提醒**：
  - 适配器把 pending 展开进 `PetState.detail.pending`（kind / 摘要 / 请求时间），渲染层显示气泡（"需要你批准：执行命令"）+ 提醒动画；
  - 性格预设新增 `attention` 节奏：首次提示 → 间隔重复（如 30s）→ 升级（更频繁动作 / Electron 系统通知）；
  - 无 pending 自动恢复。
- **快捷批准**：
  - 状态源接口增加可选 `perform(action)`（跨进程安全：postMessage 嵌入模式下父窗口只传动作 key，iframe 里的 DSH 适配器执行），内核不直接碰 DSH API；
  - 批准/拒绝：宠物气泡旁出现明确的 ✓/✕ 小按钮（不做"单击宠物=批准"，避免误触）；支持快捷键/右键菜单后续扩展；
  - 问答题：单选择题直接渲染选项按钮；多选/自由文本/plan-review 先显示摘要并引导到 DSH 界面回答（快捷批准先只做二选一）。
- **落点**：Phase 2（宠物连上 DSH 后）第一批功能；Phase 0 只需确保 `detail` 形状预留 `pending` 字段即可，不提前实现。

### 待用户拍板

- [x] 是否把"提醒 + 快捷批准"纳入正式路线图（Phase 2 首批功能）→ **纳入（用户确认）**
- [x] 批准交互默认用"气泡按钮"还是"手势"（倾向气泡按钮）→ **气泡按钮（用户确认）**
- [x] Live2D 实机 e2e 的模型来源（用户问询中：模型=外部资产，仓库不含）→ **用户提供 `C:\MyCodeProject\petAsset\pet\352`，e2e PASS**

---

## [2026-08-14 21:33] Phase 1 交接说明（给新会话） — 已确认

> 用户计划开新会话来实施 Phase 1。本条目把当前状态、环境、测试方式和 Phase 1 起手点写清楚，新会话先读 `PROJECT.md`，再读本条目。

### 0. 一句话状态

Phase 0 已完成并全量验证（sprite + Live2D 两个 DSH 实机 e2e PASS）。本地 Sapling 栈 4 个提交（docs #1 / refactor(phase0) / fix(phase0) / docs 验收），用户已批准 submit；如本条目提交后已完成 `sl pr submit --stack`，栈上应有 PR 链接，继续工作时先 `sl pull --rebase`。

### 1. 当前环境（不要无脑重置）

- **DSH live 安装仍在生效**：junction `~/.dsh/profiles/node_modules/dsh-pet` → `C:\MyCodeProject\live2D_pet`；`~/.dsh/profiles/web/cordis.patch.yml` 有 `dsh-pet` insert 条目（live watcher，改代码后重建 `lib/client.js` 即可热生效，不用重装）。
- **已安装宠物**：`~/.dsh/pets/dsh-kitten`（像素示例）、`~/.dsh/pets/anko`（用户提供的 Live2D 模型，含 motion-gen 现场生成的 TapBody/Sad/Drowse/IdleVar 动作组）。
- **模型来源**：`C:\MyCodeProject\petAsset\pet\352`（用户资产，勿提交进仓库；e2e 用它）。
- **DSH web**：`http://127.0.0.1:3080`（端口配置在 DSH patch 里，默认 3080）。

### 2. Phase 0 之后的关键文件

| 文件 | 角色 |
|---|---|
| `src/core/PetOverlay.jsx` | 共享内核渲染面（sprite/Live2D、拖拽/点击、气泡），只认 props |
| `src/core/PetStateBus.js` | useSyncExternalStore 兼容状态总线（当前单源，Phase 3 多源） |
| `src/core/personality.js` | 性格预设：交互手势 / 状态→图集行 / 气泡文案 |
| `src/adapters/dsh-state.js` | ctx.sessions → PetState（deriveState 精确顺序见文件注释） |
| `src/adapters/mock.js` | 定时器演示状态源 |
| `src/client/index.js` | DSH 插件胶水（注意 wrapper 不要与导入组件同名——踩过坑） |
| `src/entries/standalone.js` | standalone IIFE 入口，`PetStandalone.mount(options)` |
| `lib/index.js` | `createPetServer({petsRoot, echoPath, log})` → `handleRequest` + `register` |
| `scripts/dev-standalone.mjs` | **Phase 1 雏形**：serves pet.html + standalone.js + /api/pets，端口 3410 |
| `scripts/e2e-sprite.mjs` / `e2e-live2d.mjs` | 两个 DSH 实机 e2e |

### 3. 构建与测试命令（全部验证过）

```bash
npm run build:client          # 双目标：lib/client.js（DSH，React external）+ lib/standalone.js（IIFE，含 React）
node scripts/smoke-client.mjs
node scripts/smoke-standalone.mjs
node scripts/test-pet-server.mjs
node scripts/test-host-logic.mjs
node scripts/e2e-sprite.mjs   # 需 DSH 运行 + headless Edge（沙箱里跑需 danger-full-access）
node scripts/e2e-live2d.mjs   # 同上，需要 ~/.dsh/pets/anko
node scripts/dev-standalone.mjs  # 浏览器预览 standalone（DSH_PET_ROOT 可指定宠物根目录）
```

### 4. Phase 1 起手清单（按 PROJECT.md 路线图展开）

1. **Electron 壳**：
   - 新增 `electron` / `electron-builder` devDependencies（安装体积代价用户已接受）；
   - main 进程：`app.whenReady` 后开 **frameless / transparent / always-on-top** BrowserWindow，窗口内加载 standalone 页面；
   - main 进程内直接 `createPetServer({ petsRoot })` 绑 `127.0.0.1:<随机或固定端口>`，渲染进程 `PetStandalone.mount({ assetBase: "http://127.0.0.1:<port>/api" })`；
   - 托盘/菜单：皮肤切换（读 `/api/pets` 目录即可）、退出；**退出绝不关闭任何 DSH**。
2. **standalone 页面**：把 `scripts/dev-standalone.mjs` 里的 HTML 抽成正式 `standalone.html`（先继续用同一个 bundle 即可）。
3. **打包**：electron-builder 出便携版/安装包；验收里程碑 = 双击图标即开一只活宠物，不依赖 DSH、不依赖浏览器。
4. **性格/皮肤切换最小闭环**：先用内置 `DEFAULT_PERSONALITY` + 菜单切换宠物目录，配置文件的持久化放本阶段后期。
5. **测试**：`smoke-standalone` 保持绿；新增 `e2e-electron`（能测多少测多少，壳保持薄）；`dev-standalone` 继续作为无壳调试入口。
6. 完成标准与 Phase 0 相同：本地测试全绿 → DSH 实机不回归（本阶段不碰 DSH 路径）→ 用户确认 → 再 submit。

### 5. 已确认的方向（改之前先看 PROJECT.md §3）

配置驱动心情 / Electron / 宠物是纯交互器（绝不关 DSH）/ 皮肤性格分离 / 不拆 monorepo / 保留 React / 提醒+快捷批准在 Phase 2 首批、气泡按钮交互。

### 6. 遗留小事项（顺手可做，不阻塞）

- `npm audit` 报 3 个漏洞（1 high 2 critical，来自依赖树），Phase 1 加依赖时一并评估。
- `test-resolvemeta.mjs` 还是探索脚本（硬编码 `C:\Users\Yilun`），要么改成参数化要么标废弃。
- 实机调试经验：DSH 页面在 headless Edge 冷 profile 下 `Page.enable`/`evaluate` 可能长时间超时，先做 A/B（移除插件条目）再归因，不要直接怀疑环境。

---

## [2026-08-15 05:10] Phase 1 实施完成（Electron 独立宠物） — 已确认

> 新会话按 `PROJECT.md` 路线图 + 21:33 交接条目实施 Phase 1。全部代码已落地，本地测试 + Electron e2e + 两个 DSH 实机回归全绿，安装包/便携版均已产出。

### 已完成

1. **Electron 壳**（`electron/main.cjs` + `preload.cjs` + `tray.png`）：
   - 主进程内 `createPetServer` 绑 `127.0.0.1:<随机空闲端口>`；渲染层用同一端口 `assetBase` 加载 standalone 页面。
   - 窗口 = 主显示器工作区全尺寸、frameless/transparent/always-on-top/skipTaskbar/focusable:false；**鼠标点击穿透**，renderer 通过 preload IPC 在指针进入 `.dsh-pet`/hint/debug 区域时临时恢复交互（`setIgnoreMouseEvents(true,{forward:true})`）。
   - 托盘菜单：显示/隐藏、**皮肤切换**（radio 列表 + 刷新）、性格（内置"经典"）、退出；关闭窗口 = 隐藏到托盘，退出绝不涉及任何 DSH 进程。
   - 单实例锁；preload 只暴露 `onSelectPet`/`setIgnoreMouse`/`reportPet` 三个窄接口，contextIsolation + sandbox。
2. **皮肤切换闭环**：`PetOverlay` 新增可选 `selectedPetId`（受控覆盖，只接受目录里存在的 id，防过期菜单条目与回落选择打架）+ `onPetChange`；`standalone.js` 的 `mount` 返回 `unmount`（保持可调用）并扩展 `selectPet`/`getCurrentPet`；DSH 路径不传这两个 props，行为零变化。
3. **standalone 页面正式化**：`standalone.html`（Electron 与 dev 预览共用）；`dev-standalone.mjs` 改为读这个文件并兼容 `/standalone.js` 与 `/lib/standalone.js` 两条路径。
4. **发布形态**：`exports["./server"]` → `lib/index.js`；`files` 补 `standalone.html`/`electron/`；`build.extraMetadata.main` 指向壳入口（npm 包 `main` 仍为 `lib/index.js`，不破坏 DSH 宿主解析）；electron-builder 配 portable + NSIS（x64，oneClick per-user）。
5. **测试**：新增 `scripts/e2e-electron.mjs`（临时双宠物目录 → 启动壳 → 校验 `/api/pets`/mount/DOM/皮肤切换；`DSH_PET_E2E_BINARY` 可指 dist 产物）；`scripts/make-tray-icon.mjs` 零依赖生成托盘 PNG。

### 验证结果（全部实测）

- ✅ `smoke-client` / `smoke-standalone` / `test-pet-server` / `test-host-logic`
- ✅ `e2e-electron`：dev Electron PASS；`dist/win-unpacked/DSH Pet.exe` PASS（`port/pet/catalog/renderer/switchedPet/switchedKind` 全 OK）；用 `DSH_PET_E2E_ROOT=~/.dsh/pets` 实跑真实宠物目录，切到 `anko` 时 `switchedKind=live2d` PASS —— Electron 内 Live2D 皮肤可用
- ✅ `e2e-sprite`（DSH 实机）PASS；`e2e-live2d`（DSH 实机，anko）PASS —— DSH 路径零回归
- ✅ electron-builder 产出：`dist/DSH Pet-0.1.0-portable.exe`、`dist/DSH Pet Setup 0.1.0.exe`
- ✅ `npm pack --dry-run`：12 个文件，含 electron/ 与 standalone.html
- 说明：portable.exe 是 GUI 启动器（立即返回、stdout 不回流），e2e 脚本对其不适用；壳逻辑以 dev 与 win-unpacked 两次 e2e 为准。

### 环境/工具踩坑（Windows + 沙箱）

- 本机用户级 npm cache（`C:\Users\...\AppData\Local\npm-cache`）不可写：npm 安装要 `--cache <repo>\.npm-cache`，并给 `electron_config_cache=<repo>\.electron-cache` 再 `node node_modules/electron/install.js` 补下二进制。
- electron-builder 下载 NSIS/winCodeSign 工具用 `ELECTRON_BUILDER_CACHE=<repo>\.electron-builder-cache`（均已加 .gitignore）。
- electron 43.4.0 / electron-builder 26.15.3；`extraMetadata.main` 实测生效（package.json `main` 保持宿主入口）。
- electron-builder 提示 author 缺失 + 使用默认 Electron 图标（后续可选补应用图标）。

### 待办

- [ ] 用户试运行 `npm run electron`（或双击 dist 产物）确认交互手感
- [ ] 用户确认后 `sl pr submit --stack`（Phase 0 栈 + 本批提交）
- [ ] 批准后同步进 `PROJECT.md` 路线图 Phase 1 状态并标记本条目"已同步"

---

## [2026-08-15 05:30] Phase 1 追加：托盘试驾台 + 性格快捷生成设计 — 已确认

> 用户实测右键"出错了"后确认这是内置性格的预期行为（右键 = failed/Sad）。随后拍板两件事：**试驾台进托盘（现在做）**、**性格快捷生成只补设计（Phase 3b 实施）**。

### A. 托盘试驾台（已实现并验证）

1. **链路**：托盘菜单新增 "Live2D 参数试驾台" checkbox → main 发 `dsh-pet:set-debug` → preload `onSetDebug` → `PetStandalone.mount` 的 `setDebugPanel()` 重渲染 → `PetOverlay.debugPanel` → `PetLive2D` 显示面板；关闭同理。
2. **修掉两处硬编码**：`DebugPanel` 不再写死 `/api/pets/...` 与 `352.cdi3.json`——从 `pet.model` 推导 `*.cdi3.json`（`foo.model3.json` → `foo.cdi3.json`），并注入 `assetBase`；对其他 Live2D 模型也通用。
3. **验证**：`e2e-electron` 在真实宠物目录下选中 anko → `switchedKind=live2d` → 托盘开关打开/关闭时 `cockpitToggled=true`；DSH 侧 `e2e-live2d`（试驾台滑杆/override/视觉响应）仍全 PASS。

### B. 性格快捷生成设计（已写入 PROJECT.md Phase 3，实施推后）

- 预设目录：`~/.dsh/pet-personalities/<id>.json`，`DSH_PET_PERSONALITY_DIR` 可覆盖。
- schema v1 与内置 `DEFAULT_PERSONALITY` 同构：`{version, id, displayName, interactions, stateMapping, bubbles}`；未知字段透传，非法文件忽略 + 诊断。
- 托盘"性格"菜单：扫描预设目录 → radio 切换 → 实时热加载；"另存为新预设"以当前预设为模板生成 JSON（Phase 3b 与热加载一起做）。

### C. 待办

- [ ] Phase 1 最终验收（用户手动按测试清单过一遍）
- [ ] 验收通过后同步 PROJECT.md §2/§6 Phase 1 状态并标记本批条目"已同步"
- [ ] 推送 PR（`sl pr submit --stack`，等用户确认）

---

## [2026-08-15 23:05] Phase 1 修复：全屏透明蒙版 → 紧凑窗口（视频黑屏/失焦） — 已确认

> 用户实测报告：拖动/点击宠物时背后的网页"卡住"，视频黑屏只有声音，点回网页才恢复。诊断正确——旧壳是**覆盖整个工作区的透明 always-on-top 窗口**，鼠标进入宠物时整窗变为可交互，Windows 会把背后应用当作被遮挡/失焦。

### 根因与修法

- **根因**：旧壳 `BrowserWindow` 尺寸 = 整个主显示器工作区，透明部分只是"看不见"，但仍是覆盖全屏的窗口；交互时整窗参与命中/遮挡。
- **修法**：壳改为**紧凑窗口**（宠物尺寸 + 气泡边距 24/64/24/8），拖动宠物 = 用 `pointer.screenX/Y - 抓取偏移` 计算窗口屏幕坐标，`win.setPosition` 移动窗口；皮肤尺寸变化时 renderer 上报 `{width,height}`，main 自动 `setBounds`。
- **失焦硬保证**：窗口保持 `focusable:false`，并监听 `focus` 事件立即 `blur()`——覆盖 Windows"悬停激活窗口"设置，划过/点击宠物都绝不抢走前台应用的键盘焦点。
- **位置持久化**：从 localStorage 改为应用 userData 的 `shell-position.json`（main 进程 debounce 写入）；旧全屏位置（工作区原点）自动识别为 legacy 并回落默认右下角。
- **试驾台**：开启时窗口临时扩宽（面板右侧对齐，避免与宠物重叠），关闭恢复紧凑。
- **顺带修了组件重挂载 bug**：`PetOverlay` 内层 `Overlay` 原本每次渲染都创建新组件类型，托盘开关/切肤会整体卸载重挂、闪 hint；现在用稳定组件身份 + 显式 props，状态保留。
- **顺带修 hint 定位**：`.dsh-pet-anchor` 补 `width/height:100vw/100vh`，无宠物提示不再偏移。

### 验证（全 PASS）

- ✅ `e2e-electron`：紧凑窗口 bounds 正确（sprite 154×187 / Live2D 288×412）；**合成 pointer 拖拽 → 窗口真实移动**（`dragMoved:true`）；Live2D 试驾台开/关正常。
- ✅ 真实宠物目录（anko）与打包后 `dist/win-unpacked/DSH Pet.exe` 均 PASS。
- ✅ `e2e-sprite` / `e2e-live2d`（DSH 实机）PASS；smoke/unit 全绿。

### 待办

- [ ] 用户按"背后放视频 → 拖动/点击宠物"场景复验
- [ ] 通过后同步 PROJECT.md（§2/§6 Phase 1 完成状态 + 本节要点）并标记"已同步"

---

## [2026-08-15 23:50] Phase 1 修复：拖动边界逐次收缩/无法拖回 — 已确认

> 用户报告：每拖一次，可拖动的右/下边界就向里缩，最后回不到原位。Win32 真实鼠标复现后确认是两个叠加问题，已修并实测。

### 根因

1. **抓取偏移算错对象**：renderer 传的是"相对宠物元素的偏移"（`clientX - petRect.left`），但主进程用它从屏幕坐标还原的是**窗口左上角**。宠物上面有 64px 气泡、左边有 24px 边距，于是每次水平拖动窗口右偏 24、下偏 64——边界当然越拖越缩。
2. **renderer screenX/Y 反馈漂移**：窗口在指针下移动时，事件的 screenX/screenY 会跟着窗口位置自激，进一步把窗口推向右下角。

### 修法

- 拖拽偏移改为**相对窗口**：`beginDrag({offsetX: e.clientX, offsetY: e.clientY})`。
- 移动坐标改由**主进程读 `screen.getCursorScreenPoint()`**，renderer 只发 `drag-start/drag-move/drag-end` 信号，不再回传 screenX/Y。
- 移除紧凑窗口的悬停点击穿透开关（全屏蒙版已经不存在，这个开关只会制造竞态和失焦）；窗口小、始终可交互。

### 验证

- ✅ Win32 真实鼠标连续右拖 5 次：窗口从 (2084,752) → (2272,752)，**Y 稳定、尺寸始终 288×412**，到右边界后正确 clamp；不再逐次收缩。
- ✅ `e2e-electron` sprite/Live2D 全 PASS（含合成拖拽 `dragMoved:true`）。
- ✅ 待用户复验"拖到右下角再拖回左上角"。

### 待办

- [ ] 用户复验拖动与视频/焦点场景
- [ ] 通过后同步 PROJECT.md 并标记本批条目"已同步"

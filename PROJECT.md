# PROJECT.md — dsh-pet 项目权威文档

> 本文件是项目唯一权威真相。架构、功能、设计决策、最新进展以本文件为准；
> 与 DEVLOG.md 冲突时以本文件为准。本文件只在用户明确批准后更新。

---

## 1. 项目定位

**dsh-pet**：DeepSeek Harness（DSH）Web 界面的桌宠插件，方向是演进为一个**独立、可扩展的桌面宠物运行时**。

- 支持两类宠物皮肤：
  - 像素图集宠物（Codex 兼容格式，1536×1872 图集，8 列 × 9 行，192×208/格）
  - Live2D 模型宠物（Cubism 4，`.moc3` 运行时渲染 + 免 Cubism Editor 的 motion 生产线）
- 仓库 fork 自 `YilunLi-999/dsh-pet-live2d` → `AlbertREtouch/dsh-pet-live2d`（public），Sapling 克隆于 `C:\MyCodeProject\live2D_pet`。
- **上游同步策略：不跟进上游**（用户决策，2026-08-14）。本项目按自己的方向演进。

## 2. 当前状态（2026-08-14）

- 插件形态可用：浏览器半注册 `shell.overlay`，服务端半注册 `/api/pets` 路由。
- 已确认的架构演进方向：把宠物从 DSH 插件形态解耦为**独立主体**，DSH 降级为状态源之一。
- 最新进展：**Phase 0 完成并通过 DSH 实机全量回归**（sprite + Live2D e2e 全 PASS；目录分层 / createPetServer / 双目标构建 / 安全修复已落地；详见 DEVLOG 2026-08-14 19:58 条目，待同步）。
- 关键测试基线：`test-host-logic.mjs` ✅、`smoke-client.mjs` ✅、`smoke-standalone.mjs` ✅、`test-pet-server.mjs` ✅、`e2e-sprite.mjs`（DSH 实机）✅、`e2e-live2d.mjs`（DSH 实机，用户提供模型）✅。

## 3. 核心设计决策（已确认，改动需用户重新批准）

1. **保留原核心实现不动**：Live2D 渲染器（`src/client/live2d/PetLive2D.js`）、Cubism Core 引导（`setup.js`，20 行必须原样保留）、motion 生产线（`scripts/`）、孵化器（`.dsh/skills/pet-hatch/`）。
2. **配置驱动优先**：心情状态不写死枚举。`PetState.activity` 是配置注册的字符串 key；内置五个 baseline（`idle`/`review`/`running`/`waiting`/`failed`），新状态通过配置映射到现有渲染动作（像素行 / Live2D 动作组 / 参数动画 / 气泡文案），不改内核代码。
3. **状态分两层**：状态源派生状态（`PetState`）与本地交互 one-shot（`InteractionState`，单击/双击/右键）分离；渲染时交互态优先，详情仍来自状态源。
4. **独立宠物 = 独立程序**：Electron 已确认。交付双击图标即开的安装包/便携版；`pet.html` 只作为壳内部页面与开发预览。
5. **宠物是纯交互器**：只连接/读取 harness 状态；即使宠物帮忙拉起了 DSH，宠物退出/重启/崩溃也**绝不关闭它**（`spawn detached + unref`）。DSH 启停归用户。
6. **皮肤与性格分离**：共享内核之上，皮肤 = 资产（sprite/live2d，运行时可切）；性格 = 行为预设配置（状态映射/交互/眨眼/空闲节奏/气泡文案，运行时可切，用户可新增 preset 文件）。
7. **单仓库分层，不拆 monorepo**：拆包等出现外部消费者再说。
8. **保留 React**：核心继续是 React 组件；standalone 目标把 React 打进 bundle。
9. **安全默认值**：独立 server 默认只绑 127.0.0.1；局域网暴露显式 opt-in；Phase 0 修掉坏 URI、echo 无上限、symlink/junction 逃逸三类问题。

## 4. 现状架构

插件包 **dual-face**：`dsh.bundle.patch` + `dsh.client`。

| 层 | 文件 | 作用 |
|---|---|---|
| 播放器（client plugin） | `src/client/index.js` → `lib/client.js` | DSH 胶水：注册 `shell.overlay`；接线会话/宠物目录/诊断 |
| 共享内核 | `src/core/` | `PetOverlay`（渲染+交互）、`PetStateBus`、性格预设；不感知 DSH |
| 状态源适配器 | `src/adapters/` | `dsh-state.js`（ctx.sessions → PetState）、`mock.js`（演示源） |
| 资产服务（host plugin） | `lib/index.js` | `createPetServer()` 工厂：DSH 注册或裸 `http.createServer`；扫描 `~/.dsh/pets/<id>/` |
| Live2D 渲染器 | `src/client/live2d/PetLive2D.js`（326 行） | PIXI 240×340 透明 canvas；`autoUpdate:false` + `beforeModelUpdate` 参数写入 |
| Cubism Core 引导 | `src/client/live2d/setup.js`（20 行） | 文本打包 + 间接 eval，**原样保留** |
| motion 生产线 | `scripts/` + `motions-specs/` | motion-gen / frame-strip / part-analysis / breath-analysis |
| 孵化器 | `.dsh/skills/pet-hatch/` | 图片 → Codex 兼容图集 + pet.json |
| 测试 | `scripts/smoke-client.mjs`、`scripts/e2e-live2d.mjs`、`scripts/test-host-logic.mjs` 等 | 冒烟 / e2e / host 逻辑 |

宠物根目录：`$DSH_PET_ROOT` > `$DSH_HOME/pets` > `~/.dsh/pets`。

## 5. 目标架构（宠物反客为主）

```
┌────────────────────────────────────────────────────────┐
│  Pet 主体（框架无关的共享内核）                          │
│  · PetRuntime：状态总线 + 渲染 + 驱动引擎（shared）      │
│  · 皮肤层：sprite / live2d 资产，运行时可切换            │
│  · 性格层：行为预设（映射/节奏/交互/文案），可切换        │
│  · PetHost：资产服务（createPetServer 工厂）             │
└────────────────────────┬───────────────────────────────┘
                         │ PetStateSource 适配器
        ┌────────────────┼────────────────┬───────────────┐
   DSH 适配器        Codex 适配器      本地 CLI 适配器   模拟/演示适配器
```

归一化状态接口（版本化）：

```ts
interface PetState {
  version: 1;
  source: string;
  activity: string;  // 配置注册的状态 key
  detail?: { toolName?: string; message?: string; since?: number };
}
interface PetStateSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PetState | null;
  dispose(): void;
}
```

## 6. 路线图

### Phase 0：机械解耦（零行为变化，随时可回退）

> 状态：✅ 完成（1-9 全部落地；四项非 e2e 测试 + sprite/Live2D 两个 DSH 实机 e2e 全绿）。

1. 目录分层：core / adapters / entries，核心文件内容一行不动（注释级修正除外）。
2. `PetLive2D` 注射化：模型 URL、`probe` 回调改 props/注入。
3. 抽 `PetStateBus` + DSH 适配器（订阅逻辑 + `deriveState` 原样搬移）。
4. 皮肤/性格先落成数据结构，Phase 0 只内置 default 一份。
5. `src/client/index.js` 瘦身为胶水；清理死代码 `vx/vy` 和过时头部注释。
6. `lib/index.js` 抽出并导出 `createPetServer({ petsRoot, echoPath, log })`：`handleRequest(req,res)` + `register(webServer)` 两个入口。
7. 安全底线：`decodeURIComponent` 包 try/catch 回 400；echo body ≤ 64KB 且自动建父目录；资产路径 `realpath + path.relative` 校验；HEAD 不返回 body。
8. esbuild 双目标：DSH 目标 React external；standalone 目标打进 React。
9. 验证：现有测试全绿 + 新增 `test-pet-server.mjs`、`smoke-standalone.mjs`。

### Phase 1：独立宠物（双击图标即开）
- Electron 壳：主进程内挂 `createPetServer`（绑 127.0.0.1），渲染进程加载 standalone bundle，模拟状态源驱动。
- 皮肤运行时可切换（菜单/托盘）；与性格解耦。（2026-08-15 追加：托盘提供 **Live2D 参数试驾台** 开关，通用 cdi3 路径 + assetBase 注入。）
- electron-builder 打包安装包/便携版。
- 发布形态：`exports["./server"]`、`exports["./standalone"]`，`files` 补 server/standalone/壳入口。
- 里程碑：不装 DSH 也能双击打开活宠物。

### Phase 2：反客为主（宠物启动 DSH）
- **首批功能（已确认，2026-08-14）**：提醒 + 快捷批准——会话 `pending` 展开成气泡提醒（`attention` 节奏可配置）；批准/拒绝用气泡旁 **✓/✕ 按钮**；状态源增加可选 `perform(action)` 跨进程动作通道；单选提问渲染选项按钮，复杂提问引导回 DSH 界面。
- 先探测 DSH 是否已运行，已运行则复用，绝不双开；端口可配置（默认 3080）。
- 未运行时 `detached + unref` 拉起 `dsh web`；**宠物退出绝不关闭 DSH**。
- 嵌入模式：`?dsh-pet-embed=1` 且 `window.self !== window.top`；插件只报告状态不渲染；`postMessage` 双向 origin 白名单，拒绝 `*`；消息带 `version`。
- DSH 挂掉自动重连，宠物不受影响。
- 里程碑：宠物是主人，DSH 是按需连接的电源插座。

### Phase 3：多状态源 + 性格预设
- 状态源注册表配置化，优先级默认：DSH failed > 任一源 running > waiting > review > idle。
- 性格预设（preset 文件）可切换、可新增，内核不变。
  - **预设目录（2026-08-15 已确认设计）**：`~/.dsh/pet-personalities/<id>.json`（`DSH_PET_PERSONALITY_DIR` 可覆盖）；schema v1 与内置 `DEFAULT_PERSONALITY` 同构：`{version, id, displayName, interactions{click,contextMenu}, stateMapping, bubbles}`；未知字段透传、非法文件忽略并诊断。
  - 托盘"性格"菜单扫描预设目录 → radio 选择 → **实时热加载**，不改内核、不重启。
  - **快捷生成（2026-08-15 已确认，实施推后）**：托盘"性格 → 另存为新预设"，以当前内置/选中预设为模板生成合法 JSON 到上述目录；实施放 Phase 3b，与 preset 文件热加载一起做。
- Codex 适配器候选：`CODEX_HOME` 会话文件/进程状态。

## 7. 关键踩坑结论（不可回退的知识）

- pixi-live2d-display 内部更新发生在渲染阶段；参数写入必须挂 `beforeModelUpdate`（物理之后、网格计算之前），ticker 写入会被 save/load 三明治洗掉。
- 参数 readback 被 loadParameters 恢复为旧值属正常，视觉网格才是真值。
- Cubism Core UMD 当代码打包会覆写 bundle 导出；必须文本打包 + 间接 `(0, eval)` 全局求值。
- 修改 `cordis.patch.yml` 必须先写空列表 `[]` 等卸载再写新条目；写 package.json 不能用带 BOM 的 PowerShell `Set-Content`。
- Node ESM 缓存：改代码后同 specifier 仍返回旧模块，换 specifier 或重启 `dsh web`。

## 8. 许可

- 插件代码：MIT。
- Cubism Core：Live2D 专有许可（个人免费，商用需评估）。
- Live2D 模型素材：版权归原作者，仅授权范围内使用；独立分发前需重新审视（风险 R1）。

## 9. 风险与开放问题

| # | 风险 | 说明 | 处理 |
|---|---|---|---|
| R1 | Cubism Core 许可 | 独立分发桌面应用是新形态，商用需评估 | 商用前法务评估 |
| R2 | 双目标构建漂移 | 插件/独立两目标源码必须单一 | 两目标必测 |
| R3 | 状态协议版本化 | PetState 字段会演进 | version 字段 + optional + 未知字段透传 |
| R4 | 远程/跨进程状态 | postMessage 之外的通道 | iframe postMessage 优先，其余后议 |
| R5 | e2e 宿主耦合 | 现 e2e 依赖 DSH 页面 | Phase 1 补 standalone smoke |
| R6 | 壳自动化测试 | Electron 壳难无头测试 | 壳保持薄，逻辑在 web 层可测 |
| R7 | 独立服务暴露面 | 坏 URI/echo 无上限/链接逃逸/绑定地址 | Phase 0 修复；默认只绑 127.0.0.1 |
| R8 | npm 发布形态 | files 目前只含 lib/ + patch | Phase 1 发布前补 exports/files |

## 10. 版本控制约定

- 使用 Sapling（`sl`），不混用 git。
- 工作流：`sl`（smartlog）→ 修改 → `sl add` / `sl commit` → `sl pr submit --stack`。
- 推送到共享远端或 force push 前，先征得用户确认。
- 改动小而清晰的栈式提交。

## 11. 文档维护

- 本文件是唯一权威真相；发现过时只标记"待更新"，不直接改。
- DEVLOG.md 随时自由追加时间戳条目，条目状态：探索中 / 已确认 / 已废弃 / 待同步 / 已同步。
- 会话结束或里程碑时，把 DEVLOG 候选条目整理成清单交用户批准，批准后同步进本文件并标记"已同步"。

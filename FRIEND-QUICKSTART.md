# 朋友快速上手（DSH-Pet 自用分发）

拿到这个文件夹（zip 或 git clone）后，按下面做。**先跑起来，再按需改。**

## 前提

- 已经装了 DSH（`dsh` 命令可用）+ Node.js + pnpm（`dsh plugin` 会调用 pnpm）
- 本插件需要 DSH 的 **web** profile（`dsh web` 能正常启动）

## 一、安装（两种方式任选）

### 方式 A：正式安装（推荐，省心）

```bash
# 1. 在仓库目录里装依赖（只为了以后改代码时能重新构建；不改代码可跳过）
npm install

# 2. 安装为 web profile 的插件（把 <路径> 换成这个文件夹的绝对路径）
dsh plugin --profile web add <路径>

# 3. 重启 dsh web
```

### 方式 B：免重启 live 安装（想边改边试时更爽）

```powershell
# 1. 把仓库链接进 DSH 的插件解析目录（junction，路径换成实际的）
New-Item -ItemType Junction -Path "$env:DSH_HOME\profiles\node_modules\dsh-pet" -Target "<仓库绝对路径>"

# 2. 编辑 $DSH_HOME/profiles/web/cordis.patch.yml，插入（保留文件里已有的其他条目）：
#   - insert:
#       - id: dsh-pet
#         name: 'dsh-pet'
#         inject: [webServer]
```

> ⚠️ live 方式的坑：以后要改这个 patch 时，**先写回 `[]` 等条目卸载（约 3 秒），再写新内容**——直接替换会因路由重复注册被回滚。package.json 不要用 PowerShell 的 `Set-Content -Encoding UTF8` 写（会加 BOM 导致浏览器半失效）。

## 二、放入宠物资产（插件之外的独立内容）

```powershell
# 像素宠物或 Live2D 宠物目录，整个拷到：
$env:DSH_HOME\pets\<宠物名>\
```

- **安可（Live2D）**：目录需含 `pet.json`（`kind: "live2d"`）+ 模型文件 + `motions/`。
  ⚠️ 许可：模型素材与 Cubism Core 仅限个人/授权范围使用，别公开发布。
- **像素宠物**：可用仓库里的 `pet-hatch` skill 自己孵化（把 `.dsh/skills/pet-hatch/` 复制到 `~/.dsh/skills/pet-hatch/`，然后对 DSH 说"把这张图做成桌宠"）。

## 三、改起来（按需）

| 想改什么 | 改哪里 | 生效方式 |
|---|---|---|
| 宠物行为/交互/触发 | `src/client/index.js`、`src/client/live2d/PetLive2D.js` | `npm run build:client` → 硬刷新页面（Ctrl+F5） |
| 动作幅度/速度 | `motions-specs/*.json` | `node scripts/motion-gen.mjs motions-specs/<名字>.json --apply` → 刷新 |
| 新增动作 | 新建 spec（格式抄现有的） | 同上 |
| 服务端接口/目录约定 | `lib/index.js` | 重启 dsh web（方式 A）/ 走方式 B 的 patch 舞步 |
| 像素宠物生成 | `.dsh/skills/pet-hatch/` | 见 README |

构建命令：`npm run build:client`（产物提交在 `lib/client.js`，朋友之间共享改完的仓库即可）。

## 四、排错

- 装完没反应：重启后看 `http://127.0.0.1:3080/api/pets` 是否有响应；页面 boot 图是否含 `dsh-pet`；`/plugins/dsh-pet/client.js` 是否 200。
- 页面有报错但看不到宠物：`~/.dsh/pets-echo.log` 是插件自带的诊断通道，把最后几行发出来。
- 参数没效果：打开 `?dsh-pet-debug=1` 试驾台，先确认哪些参数在这个模型上有视觉绑定（不同模型差别很大）。
- 更完整的踩坑记录见 `README.md`。

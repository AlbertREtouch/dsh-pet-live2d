---
name: pet-hatch
description: 从一张图片孵化 DSH 桌宠——生成 Codex 兼容的 spritesheet 图集（1536x1872，8x9 格，192x208/格）与 pet.json，安装到 ~/.dsh/pets/<name>/，供 DSH Web 界面 (dsh-pet 插件) 的 shell.overlay 浮层宠物使用。
whenToUse: 用户说"孵化宠物"、"做个桌宠"、"hatch a pet"、"生成宠物"、给出图片并要求做宠物时使用；也用于批量把图片转成宠物。
---

# pet-hatch — 从图片孵化 DSH 桌宠

把一个参考图片变成 DSH Web 界面里会动的桌宠。产物与 OpenAI Codex `hatch-pet` skill 完全同构：

- `pet.json` — `{ id, displayName, description, spritesheetPath }`
- `spritesheet.webp`（无 sharp 时输出 `spritesheet.png`）— **1536x1872** 图集，**8 列 x 9 行**，每格 **192x208**，透明背景

9 行对应 9 种动画状态（Codex 契约，行号→状态→帧数）：

| 行 | 状态 | 帧数 | 触发（dsh-pet 播放器） |
|---|---|---|---|
| 0 | idle | 6 | 空闲 |
| 1 | running-right | 8 | 备用 |
| 2 | running-left | 8 | 备用 |
| 3 | waving | 4 | 单击宠物 |
| 4 | jumping | 5 | 双击宠物 |
| 5 | failed | 8 | 会话出错 |
| 6 | waiting | 6 | 等待用户 |
| 7 | running | 6 | 工具调用中 |
| 8 | review | 6 | 思考/输出中 |

## 步骤

本 skill 自带构建脚本 `build-atlas.mjs`（资源基目录下）。运行它即可，无需手写任何图像逻辑。

### 1. 确定输入

- **PNG 源图**：纯 Node 路径，零依赖，任何环境都能跑。
- **JPEG/WebP/GIF 源图**：需要脚本旁边能解析到 `sharp`（`npm i sharp` 后即可）。
- 背景最好接近纯色（脚本用 18% 容差的 chroma-key 抠图）；PNG 带透明通道可直接跳过抠图。
- 造型建议：头大身小的 chibi 比例、粗轮廓、扁平色块、无渐变/阴影/文字（像素风最佳）。

### 2. 运行构建

```bash
node "<skill 资源基目录>/build-atlas.mjs" \
  --source <输入图片路径> \
  --name <kebab-case id，如 blobcat> \
  --display-name "<显示名>" \
  --description "<一句话介绍>" \
  [--out <输出目录，默认 ~/.dsh/pets/<name>>] \
  [--chroma auto|#RRGGBB|none，默认 auto] \
  [--format webp|png，默认 webp]
```

脚本会：抠图 → 裁剪到精灵包围盒 → 等比适配进 192x208 格（最近邻采样，保持像素硬边）→ 用微变换（1-2px 位移、±3° 旋转、轻微压扁）程序化生成 9 行动画 → 拼成 1536x1872 图集 → 写 pet.json。

### 3. 验证产物

```bash
node -e "const m=require(process.env.HOME+'/.dsh/pets/<name>/pet.json'); console.log(m)"
# 或直接检查目录：
# ~/.dsh/pets/<name>/pet.json + spritesheet.webp|.png
```

图集必须是 1536x1872（可用 sharp/图片查看器确认）。

### 4. 让宠物出现

dsh-pet 播放器每 30 秒轮询 `/api/pets`，刷新 DSH Web 页面（F5）立即生效。宠物默认选 `dsh-kitten`，没有则选列表第一个；右键宠物可循环切换。

## 常见问题

- **输出太大/太小**：192x208 格内精灵会居中；如果原图留白多，先手动裁掉大部分背景。
- **抠图误伤身体**：主体颜色接近背景色时，用 `--chroma none`（透明 PNG）或指定 `--chroma #RRGGBB` 并换掉与主体相近的颜色。
- **想要不同动画**：编辑 `build-atlas.mjs` 里的 `ROWS` 表（每行一个变换规格列表），变换类型：`base`、`shift:x:y`、`rotate:deg`、`squash:sy`、`flip`。
- **interlaced PNG 报错**：重新保存为无交错（non-interlaced）PNG，或安装 sharp。
- **宠物目录不生效**：确认 `~/.dsh/pets/<name>/` 下两个文件齐全，id 为 kebab-case 且不含空格。

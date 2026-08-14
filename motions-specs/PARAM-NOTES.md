# 安可参数校准字典（试驾台实测，2026-08-13 用户反馈）

## ✅ 有效参数（有视觉响应）

| 参数 | 观感 |
|---|---|
| ParamAngleX / Y / Z | 头部旋转（三个轴都有效） |
| ParamEyeLOpen / ParamEyeROpen | 左右眼开闭 |
| ParamBreath | 呼吸 |
| ParamHairFront | 摇动前发（物理也驱动它，手动覆盖会被物理洗掉——动作曲线不要写它） |

## ❌ 无效参数（参数存在但网格无可见绑定）

ParamEyeBallX/Y、ParamEyeLSmile/R、ParamBrowLY/RY/LX/RX/LAngle/RAngle/LForm/RForm、
ParamMouthForm、ParamMouthOpenY、ParamCheek、ParamBodyAngleX/Y/Z、ParamHairSide、ParamHairBack。

## 据此已做的调整

- shake：去掉眉毛曲线（无效），保留摇头（AngleX）
- shy：去掉微笑/脸红曲线（无效），保留闭眼（EyeLOpen/R）+ 低头（AngleX/Y）
- idle-var：去掉抬眉/微笑，保留歪头（AngleZ）
- 飞行倾斜：BodyAngleX/Y（无效）→ 飞行方向改用头部朝向（AngleX 朝飞行方向、AngleY 俯仰）
- 视线跟随：去掉眼珠（EyeBall 无效），保留头部角度（有效）
- drowse / nod：全部参数均有效，不动

## 动作手感反馈（待用户）

- [ ] nod 点头：幅度/速度
- [ ] shake 摇头：幅度/速度
- [ ] shy 害羞：闭眼-低头组合
- [ ] drowse 打盹：入睡曲线/呼吸
- [ ] idle-var 待机变奏：歪头
- [ ] fly 飞行：滑翔距离/回位速度/头部朝向

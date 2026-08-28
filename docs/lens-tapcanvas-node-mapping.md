# TapCanvas 与 Lens 项目节点/实体映射初步分析

> 状态：初步分析（结论已对齐，逐字段映射与对接方案待细化）
> 日期：2026-08-27

## 1. 结论速览（映射总表）

| Lens（短剧生成，关系型表） | TapCanvas（AI 画布） | 匹配度 |
|---|---|---|
| `drama`（剧） | `project`（项目） | ✅ |
| `lens_scene`（**真正的"集"**） | `chapter`（章节） | ✅ |
| `novel_episode`（这一集剧本的**纯文本**） | `novelDoc`（原文）+ `scriptDoc`/`storyboardScript`（台本） | ✅ |
| `lens_storyboard`（分镜/shot） | `shot`（镜头） | ✅ |
| `lens_role`（角色） | `MaterialAsset kind='character'` + 角色卡 roleCards + 锚点 `kind='character'` | ✅ 高 |
| `lens_asset_image type=1`（场景 location） | `MaterialAsset kind='scene'` + 锚点 `kind='scene'` | ✅ |
| `lens_asset_image type=2`（道具） | `MaterialAsset kind='prop'` + 锚点 `kind='prop'` | ✅ |
| `lens_asset_image type=3`（站位参考） | 无直接对应（可归入 scene/prop/context） | ⚠️ 缺失 |
| `VisualStyleEnum`（视觉风格） | `MaterialAsset kind='style'`（styleBible） | ✅ |

## 2. 先厘清两边的"节点"概念（不对等，是差异根源）

TapCanvas（React Flow 画布项目）里"节点"分四层，容易混淆：

| 层 | 具体 | 说明 |
|---|---|---|
| 画布物理节点 `TaskNodeKind` | `text` / `image` / `imageEdit` / `video` / `storyboard` | 真正渲染在画布上的节点 |
| 逻辑节点 `canvasNodeSpecs.kind` | `text`、`novelDoc`、`scriptDoc`、`storyboardScript`、`cameraRef`、`image`、`imageEdit`、`video`、`storyboard` | AI 画布能力清单里的逻辑种类 |
| 语义锚点 `anchorBindings.kind` | `character` / `scene` / `prop` / `shot` / `story` / `asset` / `context` / `authority_base_frame` | **不是节点**，是绑定在 image/storyboard 节点上的"资产引用"字段 |
| 资产库 `MaterialAsset.kind` | `character` / `scene` / `prop` / `style` | "角色/场景/道具"的真实实体仓库 |

Lens（短剧生成项目）是关系型数据模型（表），没有"画布节点"概念。

## 3. 角色 / 场景 / 道具

| 维度 | Lens 实体 | TapCanvas 对应 |
|---|---|---|
| 角色 | `lens_role`（roleName、img近身、frontImg全身、threeImg三视图、otherNames、roleType主身份/换装、parentId） | `MaterialAsset kind='character'` + 角色卡 roleCards（`referenceView: three_view/role_card`）+ 锚点 `kind='character'` |
| 场景(location) | `lens_asset_image type=1`（场景代表图，parentId 子场景 / variantName 变体） | `MaterialAsset kind='scene'` + 锚点 `kind='scene'` |
| 道具 | `lens_asset_image type=2` | `MaterialAsset kind='prop'` + 锚点 `kind='prop'` |
| 站位参考 | `lens_asset_image type=3` | 无直接对应 |
| 视觉风格 | `VisualStyleEnum` | `MaterialAsset kind='style'`（styleBible） |

**⚠️ 关键歧义（必须记住）**：Lens 的 `lens_scene` 表**是"集"，不是"场景(location)"**。`LensScene.java` 注释虽写"场次表或集数表"，但字段与挂载关系表明它承担"集"的职责。真正的"场景(环境)"是 `lens_asset_image type=1`。TapCanvas 的 `scene` 锚点指"场景(环境)"，**不要**把 `lens_scene` 映射到 `scene` 锚点，否则语义错位。

## 4. "当前这一集剧本"与"集"的归属

- **真正的"集" = `lens_scene`**：含 `episodeNum`(集数)、`episodeName`(集名称)、`storyboardList`(挂分镜)、`characters`、`completionStatus`、`shots`(镜头描述)。分镜通过 `sceneId` 挂在它下面。
- **`novel_episode` 只是这一集剧本的纯文本**：只有 `content`(本集原文) + `scriptContent`(台本) + `wordCount`，没有分镜、没有角色、没有业务关系。它与 `lens_scene` 靠 `dramaId + episodeNumber/episodeNum` 做 1:1 软关联。
- TapCanvas 没有名为"集/episode"的节点，但有等价物：
  - `novelDoc`（小说文档）= 章节原文 ≈ `novel_episode.content`
  - `scriptDoc`（剧本文档）= 结构化剧本 ≈ `novel_episode.scriptContent`
  - `storyboardScript`（分镜脚本）= 镜头级文本分解
  - `chapter`（章节，见 `ProjectChapterWorkbenchPage`）≈ `lens_scene`（集）

## 5. 分镜节点差异

| | Lens 分镜 | TapCanvas `storyboard` | TapCanvas `storyboardScript` |
|---|---|---|---|
| 本质 | `lens_storyboard`，**逐镜头行**：脚本+分镜图+构图+角色+台词+状态机+视频状态 | **图片网格节点**（2x2/3x3/5x5，storyboardEditorCells） | **镜头级文本分解**（Shot 列表/镜头语言/时长） |
| 图 | 每镜头一张 `selectedImageUrl`（分镜图） | 多张图排网格、可合成总览图 | 无图，纯文本 |
| 台词/配音 | `line`/`lineAudio`/`audioId` | 无 | 无 |
| 场景构图 | `sceneGraph`（scene/prop/position） | 无 | 无 |

结论：

1. Lens 的分镜是"一行一个镜头"（脚本、图、台词、构图合并在一行），**不是网格**。TapCanvas 的 `storyboard` 是"把多张镜头图排成网格"，两者模型不兼容 —— **Lens 不该用 TapCanvas 的 `storyboard` 网格节点**。
2. **正确映射**：Lens 的一个 `lens_storyboard`（shot）→ TapCanvas 的 `storyboardScript`（承载 scriptContent/shots 文本）+ `image` 节点（承载 selectedImageUrl 分镜图）。即"**脚本节点 + 单图节点**"组合。
3. TapCanvas 在 `tool-schemas.ts` 里写死该规则："**若当前还没有镜头图，只应使用 storyboardScript/text 承载逐镜头文本，不应误用 storyboard 图片网格节点**"。
4. Lens 分镜里 TapCanvas 需要单独补的：台词/配音 → audio/subtitle 能力；机位 → `cameraRef` 节点 + `imageCameraControl`。

## 6. 层级结构对齐

```
Lens:      drama(剧)
             └─ lens_scene(集)          ← 真正的集，挂分镜
                  ├─ novel_episode(剧本文本: content + scriptContent)
                  └─ lens_storyboard(分镜/shot)

TapCanvas: project(项目)
             └─ chapter(章节)            ← 对应"集"
                  ├─ novelDoc(原文) / scriptDoc·storyboardScript(台本)
                  └─ shot(镜头)
```

三层对三层：剧→集→分镜；集下挂"剧本正文(文本)"，分镜下挂"分镜脚本+分镜图"。

> 说明：Lens 的 `lens_scene` 虽是"场次"表，但每集只有 1 个场次（`getOrCreateScene` 硬编码 `sceneNum = episodeNum + "-01"`，查询 `limit 1`），场次层实际退化、可忽略。旧导入路径 `LensDramsLogic.processEpisodeScenes` 仍保留 `for(Scene)` 循环、理论支持一集多场次，但当前主流程已退化为单场次。

## 7. 待细化（后续工作）

- Lens 表字段 ↔ TapCanvas 锚点/节点字段的逐字段映射表。
- "集→章节、分镜→storyboardScript+image" 的具体对接/同步方案。
- 站位参考（type=3）在 TapCanvas 侧的落点设计。

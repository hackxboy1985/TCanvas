# Lens 数据 → TapCanvas 画布 对接设计（自由无限画布，后端全走 Lens）

> 状态：编排持久化 + 任务执行均走 Lens；tapCanvas 只保留前端画布（React Flow UI）
> 日期：2026-08-27
> 前置阅读：[TapCanvas 与 Lens 项目节点/实体映射初步分析](./lens-tapcanvas-node-mapping.md)

## 0. 定调

- **画布**：tapCanvas 的 React Flow **自由无限画布**，保留自由拖拽、任意连线、子图执行能力。
- **功能等价 Lens**：画布功能**等同于 Lens**，只是以画布形式展开。支持**新建节点**（新建角色/新建场景/新建道具/新建分镜），也支持加载已有资产；每个节点的操作按钮对应 Lens 的同名功能。
- **两类节点**：
  1. **Lens 业务节点**：角色/场景/道具/分镜/剧本/台本，绑定 Lens 实体（`entityId`），数据权威在 Lens。
  2. **自由任务节点**：生图（非角色/道具/场景）、生音频、生视频、文本等，**与 Lens 无关、独立新建**，复用 tapCanvas 原生任务节点，任务执行走 lens 引擎（`/api/userTask/submit`，v2，见 §10）。
- **数据范围**：每个画布项目 = 一部剧，进入画布展示**一集**；顶部选集切换，加载对应集数据。
- **编排持久化**：存 Lens 的 `lens_canvas_flow` 表（对齐 tapCanvas flow 数据格式），见 §2。
- **业务数据**：角色/场景/道具/分镜/剧本/视频结果，权威源在 **Lens**，画布**直连 Lens 接口**读写。
- **后端约束**：Lens 只增不改（新增接口，或现有接口加字段）。

## 1. 总体架构（后端全走 Lens，tapCanvas 只留前端画布）

```
画布前端（tapCanvas React Flow，自由无限画布）
   │
   └── Lens 后端（业务数据 + 编排持久化 + 任务执行，JWT=Admin-Token cookie）
        拉一集：角色/场景/道具/剧本/台本/分镜 → 投影成节点
        编排：nodes/edges/viewport 存 lens_canvas_flow（新增表+接口，对齐 tapCanvas flow 格式）
        写回：生成新图/编辑图片/选资产加载/分镜选图 → Lens 写接口
        自由任务节点执行：生图/生视频/生音频 → /api/userTask/submit（v2）
```

| 后端 | 职责 | 数据 |
|---|---|---|
| Lens 后端 | 业务数据权威源 + 编排持久化 + 任务引擎（含自由任务节点） | lens_* 业务表 + lens_canvas_flow（编排）+ task_queue（任务） |

> Lens 业务节点（角色/场景/道具/分镜）的生成走 Lens 现有接口：**生图统一走 `/api/application/runTask`（appId 区分），分镜生视频走 `/api/storyboardTask/submit`**；自由任务节点走 `/api/userTask/submit`（v2，见 §10）。**tapCanvas 后端（hono-api）完全不需要**，画布前端直连 lens 后端。

## 2. 编排归属（flow 存 Lens，按剧+集定位）

编排状态不再存 tapCanvas 后端，而是存 Lens 的 `lens_canvas_flow` 表，直接用 **drama_id + episode_num** 定位，与业务数据同后端：

| 编排维度 | 定位方式 | 说明 |
|---|---|---|
| 画布项目 = 一部剧 | `drama_id` | flow 记录关联剧 |
| 画布展示一集 | `episode_num` | flow 记录关联集，选集切换 = 读该 (drama_id, episode_num) 的 flow |
| 业务实体节点 | 节点 `entityId` 回指 | 角色→lens_role.id、场景/道具→lens_asset_image.id、分镜→lens_storyboard.id |

> 编排存 Lens 后，**不再需要 tapCanvas Project/Chapter 与 Lens 的映射键**（之前的待确认项消除）。业务数据权威与编排持久化都在 Lens，权限/审计/多租户统一。
>
> 约定键 `lens_drama:{dramaId}` 已确认（备选）：当前单后端架构下暂不需要，若将来再接入 tapCanvas 后端时作为 project id 约定。

## 3. 数据流（编排持久化到 Lens + 选集切换恢复）

1. 进入画布（project=剧）→ 顶部选集 → 调 Lens `GET /api/canvas/{dramaId}/episode/{episodeNum}/flow` 读该集编排。
   - **已有 flow**：直接恢复（节点位置/连线/展开收起状态都保留）。
   - **首次进入**：调现有接口（`listByEpisode` + `assetsByEpisode` + `scriptContent`）拉数据，投影成初始节点，再 `POST /api/canvas/{dramaId}/episode/{episodeNum}/flow` 落编排。
2. 投影/同步节点：角色/场景/道具 → `image` 节点（带 anchorBindings）；剧本/台本 → `text` 节点（默认隐藏）；分镜 → 脚本 text + 分镜图 image。
3. 用户自由拖拽、任意连线、建子图、展开/收起任务结果 → **编排状态实时存 Lens `lens_canvas_flow`**（位置/连线/展开收起都持久化）。
4. **加节点**分两种：
   - **新建**（等同 Lens 新建功能）：新建角色/场景/道具/分镜 → 调 Lens 新建接口创建实体 → 投影成节点（`entityId` 回填新实体 id）。
   - **加载已有**：从 Lens 资产列表（`lensRole/list` + `lensImage/listHistory`）选一个已有资产 → 投影成节点（`entityId=lens id`）。
5. 生成新图/编辑/删除/分镜选图/资产关联 → 调 Lens 对应写接口，结果回填画布节点。

> 编排状态（拖拽位置、连线、展开/收起）**必须记住**，由 Lens `lens_canvas_flow` 持久化，选集切换不丢。

## 4. 接口设计（Lens 只增不改）

### 4.1 接口设计（只新增 flow 读写，其余复用现有接口）

**路径前缀**：新增接口挂 `/api/canvas` 前缀，由新 `LensCanvasController` 承载（`@RequestMapping("/api/canvas")`）。

**唯一新增接口（flow 读写）**：

```
GET  /api/canvas/{dramaId}/episode/{episodeNum}/flow       → 读编排
POST /api/canvas/{dramaId}/episode/{episodeNum}/flow       → 保存编排
```

**复用现有接口（画布业务数据零新增）**：

| 画布数据 | 现有接口 |
|---|---|
| 集列表（选集下拉） | `POST /api/episode/getAllEpisode` |
| 分镜列表 | `GET /api/storyboard/listByEpisode` |
| 资产（带 refId=分镜ID） | `POST /api/storyboard/assetsByEpisode` |
| 剧本（content + scriptContent） | `GET /api/episode/scriptContent` |
| 全剧资产-角色（主动加资产） | `POST /api/lensRole/list` |
| 全剧资产-场景/道具（主动加资产） | `POST /api/lensImage/listHistory` |

> 资产加载分两种（**主动加全剧资产 = 用户主动触发，非系统默认全加载**）：
> - **默认（选集后）**：只加载当前集已关联的资产（`assetsByEpisode` 返回带 refId 的资产）。
> - **主动加资产**：用户手动触发，从全剧资产（`lensRole/list` + `lensImage/listHistory`）里选，加到画布并关联到分镜 → 调 `saveRelations` 关联。

**② 编排持久化接口（对齐 tapCanvas flow 持久化格式）**

> **统一路径前缀**：所有画布新增接口统一挂 `/api/canvas` 前缀，RESTful 风格（同一资源 GET 读 / POST 写）。

```
GET  /api/canvas/{dramaId}/episode/{episodeNum}/flow      → 读该集编排（nodes/edges/viewport）
POST /api/canvas/{dramaId}/episode/{episodeNum}/flow      → 保存编排（upsert）
```

入参/出参的 `data` 结构对齐 tapCanvas 的 `sanitizeFlowDataForPersistence` 产物：

```json
{ "dramaId": 1, "episodeNum": 1, "name": "第1集", "data": { "nodes": [...], "edges": [...], "viewport": { "x":0,"y":0,"zoom":1 } } }
```

对应新增表：

```sql
-- lens_canvas_flow（编排持久化，只增不改）
id           bigint 主键
drama_id     bigint   剧ID
episode_num  int      集数（选集定位）
name         varchar  名称
data         text     JSON: { nodes, edges, viewport }
version      int      版本号（自增）
create_time  datetime
update_time  datetime
del          tinyint  删除标志
```

> 版本历史如需保留，可再加 `lens_canvas_flow_version` 表（对齐 tapCanvas 的 createFlowVersion）；否则只存当前版本 + version 自增即可。

### 4.2 复用现有接口（画布操作 ↔ Lens 功能，不改）

| 画布节点操作 | 等同 Lens 功能 | Lens 现有接口 |
|---|---|---|
| 新建角色节点 | 新增角色 | `POST /api/lensRole`（@RequestBody LensRole，返回 id） |
| 新建场景节点 | 新增场景资产 | `POST /api/lensImage/upload`（type=1） |
| 新建道具节点 | 新增道具资产 | `POST /api/lensImage/upload`（type=2） |
| 新建分镜节点 | 新增分镜 | `POST /api/storyboard/insert` / `POST /api/storyboard` |
| 编辑角色 | 修改角色 | `PUT /api/lensRole` |
| 编辑场景/道具 | 修改资产 | `PUT /api/lensImage` |
| 编辑分镜（脚本/图/台词） | 修改分镜 | `POST /api/storyboard/edit` |
| 删除角色 | 删除角色 | `DELETE /api/lensRole/{ids}` |
| 删除场景/道具 | 删除资产 | `POST /api/lensImage/remove` |
| 删除分镜 | 删除分镜 | `POST /api/storyboard/delete` |
| 生成角色图（近身/全身/三视图） | 角色生图 | `POST /api/application/runTask`（appId=角色生图应用） |
| 生成场景图 | 场景生图 | `POST /api/application/runTask`（appId=场景生图应用） |
| 生成道具图 | 道具生图 | `POST /api/application/runTask`（appId=道具生图应用） |
| 分镜生视频 | 分镜生视频 | `POST /api/storyboardTask/submit` |
| 选择已有资产加载到节点 | 资产关联 | `POST /api/storyboard/saveRelations`（assetId+assetCategory），保存后**调 `assetsByEpisode` 刷新**该集资产关联（lens 分镜板只 saveRelations 不刷新，画布为了节点关联即时一致，保存后主动刷新） |
| 分镜选图 | 分镜选图 | `POST /api/storyboard/edit`（selectedImageUrl） |

> 生图（角色/场景/道具/自由生图）统一走 `POST /api/application/runTask`（appId 区分生图类型）；分镜生视频走 `POST /api/storyboardTask/submit`——**提交接口不同，参考 lens 前端实际调用**。

> 「新建节点」和「加载已有资产」的区别：新建 = 调 Lens 创建接口生成新实体再投影；加载 = 从已有资产列表选，只建立关联/投影，不新建。

### 4.3 任务结果节点数据来源（三态展示：成功 / 生成中 / 失败）

| 主节点 | 任务结果节点数据（Lens 接口） |
|---|---|
| 角色 | `task_queue`（按 assetId=roleId 查任务，含 taskStatus）+ `lens_application_task`（resMsg 错误信息）+ `POST /api/image/list`（成功结果图） |
| 场景 | `task_queue`（assetType=1）+ `lens_application_task` + `POST /api/lensImage/listHistory`（type=1，多版本） |
| 道具 | `task_queue`（assetType=2）+ `lens_application_task` + `POST /api/lensImage/listHistory`（type=2） |
| 分镜 | 分镜候选图（lens_image）+ 视频结果 `lens_storyboard_task`（status + results + errorMsg） |

> **任务结果节点展示完整任务列表（不隐藏失败），三态区分**：

| 状态 | 判定（taskStatus / status） | 节点展示 |
|---|---|---|
| 成功 | `SUCCESS` | 结果图 `imageUrl` |
| 生成中 | `RUNNING` / `QUEUED` / `CREATE` | 进度占位（loading + progress） |
| 失败 | `FAILED` / `ERROR` | 失败标记 + 错误原因 `errorMsg` / `resMsg` |

> 核心：**生成中的任务展示进度，失败的任务展示失败原因**（用户需要看到"为什么失败"这个结果），而不是只加载成功图、隐藏失败。

## 5. 节点模型与「任务结果」展开按钮

### 5.1 节点分类

| 类别 | 节点 | 数据权威 | 新建方式 |
|---|---|---|---|
| Lens 业务节点 | 角色 / 场景 / 道具 / 分镜 / 剧本 / 台本 | Lens（`entityId` 回指） | 调 Lens 新建接口，或加载已有资产 |
| 自由任务节点 | 生图(非角色/道具/场景) / 生音频 / 生视频 / 文本 | lens 引擎（`/api/userTask/submit`，v2） | 画布原生新建，与 Lens 无关 |

**资产加载（角色/场景/道具）两种方式**：
- **默认（选集后，系统自动）**：只加载当前集分镜已关联的资产，投影成节点。
- **主动加资产（用户手动触发，非系统默认全加载）**：用户从全剧资产里选（如本集没有的角色）加到画布，可连线到某分镜；或直接在分镜节点上「添加资产（角色/场景/道具）」→ 调 `saveRelations` 关联。

### 5.2 「任务结果」展开按钮（Lens 业务节点）

- 角色/场景/道具/分镜节点各带「展示任务结果」按钮：收起只显示主节点（现有图），展开后主节点 → 连线 → 多个任务结果节点（三态展示：成功图 / 生成中进度 / 失败原因）。
- 展开/收起状态**持久化**（随 flow 保存，选集切换不丢）。
- 视频结果**按分镜展示**：分镜节点展开后挂 video 结果节点（`videoResults=[{url}]`，状态映射 SUCCESS→success / RUNNING→running / FAILED→failed）。
- 剧本节点、台本节点默认隐藏。

### 5.3 自由任务节点（与 Lens 无关）

- 复用 tapCanvas 原生 `TaskNodeKind`（text/image/video/audio 等），支持生图（非角色/道具/场景）、生音频、生视频等。
- 独立新建，不绑定 Lens 实体；任务执行走 **lens 引擎**（`/api/userTask/submit`，v2），结果回填画布节点。

## 6. 鉴权（单后端）

| 链路 | 鉴权 |
|---|---|
| 画布 → Lens | Lens JWT（`Admin-Token` cookie → `Authorization: Bearer`）；同域名直接读 cookie |

- 嵌入形态：画布构建产物部署到 Lens 同域名 `/canvas/` 路径，Lens 页面新页面跳转打开（无 iframe）→ 免 CORS、cookie 共享。

## 7. 待确认

- （暂无，编排版本历史已决定：先只存当前版本 + version 自增，持久版本历史放入独立待分析）

## 8. 附录：tapCanvas 独有能力清单（lens 无，供选择）

> 原则：lens 现有功能（角色/场景/道具/分镜/剧本/生图/生视频/音色/BGM/定妆）大多可直接对齐 tapCanvas；下表只列 **tapCanvas 有、lens 没有** 的额外能力，供决策是否引入。

### A. 画布编排（随画布引入，lens 零开发）

| tapCanvas 能力 | lens 现状 | 建议 |
|---|---|---|
| 自由无限画布 + 拖拽 + 任意连线 | 无画布 | 直接用 tapCanvas |
| 子图 subflow | 无 | 直接用 |
| 分组 groupNode | 无 | 直接用 |
| 自动布局 reflowLayout | 无 | 直接用 |
| 节点级执行（单节点/批量/串并行） | 无（只有 task_queue 任务队列） | 直接用 lens 任务引擎（task_queue） |
| 画布版本历史 | 无 | 直接用，或 Lens 加版本表 |

### B. 自由生成节点（lens 已有对应：视频v2工具栏）

> lens 的「视频v2工具栏」（`panels/SidePanelVideoV2.vue`）已提供与剧、资产**无绑定**的自由生图/生视频能力（含"无剧"过滤、@引用参考图、图片/视频模型选择）。tapCanvas 的 B 类自由生成节点可对齐该工具栏。

| tapCanvas 能力 | lens 现状 | 建议 |
|---|---|---|
| 自由生图 image（非角色/道具/场景） | 有（视频v2 图片模式） | 对齐视频v2，落为 image 节点 |
| 图片编辑 imageEdit（自由编辑任意图） | 部分（`lensImage/edit`） | 对齐 |
| 自由图生/文生视频 video | 有（视频v2 视频模式，无剧） | 对齐视频v2，落为 video 节点 |
| 合成视频 composeVideo | 部分（`exportMergedVideo` 成片） | 对齐 |

### C. AI 视觉/理解（已确认：要实现）

| tapCanvas 能力 | lens 现状 | 决策 |
|---|---|---|
| 视觉理解 vision（通用图理解） | 部分（仅分镜智能抽帧） | **要实现**（tapCanvas vision） |
| 图生提示词 image_to_prompt | 无 | **要实现** |
| 提示词精炼 prompt_refine | 部分（promptCombo） | **要实现** |
| AI 对话驱动画布编排（chat→canvas plan→自动建节点连线） | 无（chat 是纯文本对话） | **要实现**（tapCanvas agents chat 驱动画布） |

### D. 节点级精细能力

| tapCanvas 能力 | lens 现状 | 建议 |
|---|---|---|
| 反推提示词 reversePrompt | 无 | 待确认 |
| 采样数量 sampleCount | 无 | 待确认 |
| 节点级模型选择 modelSelect | 无（只有全局模型配置） | 待确认 |
| 角色提及 @角色名 characterMentions | **有**（分镜编辑 `storyboard-task/index.vue` 的 @ 引用资产） | 已对齐 |

### E. 文档/流程节点

| tapCanvas 能力 | lens 现状 | 建议 |
|---|---|---|
| 工作流输入/输出 workflowInput/Output | 无（固定流程） | 待确认（如需自由工作流） |

### F. 独立待分析项（后续再分析）

| tapCanvas 能力 | 说明 |
|---|---|
| 字幕 subtitle | 单独分析：与 lens 台词 line + 配音的关系 |
| 机位参考 cameraRef（3D 机位/镜头参数） | 单独分析：与 lens ShotScriptTemplate 的关系 |
| 自由生音频 audio | 单独分析：与 lens BGM / 角色配音的关系 |
| 图像裂变 imageFission | 单独分析：一张图裂变成 2x2 网格多候选 |
| 马赛克/拼图 mosaic | 单独分析：多张参考图拼成带标记的拼图板 |
| 光照 rig（imageLightingRig） | 单独分析：主光/补光方向与强度控制 |
| 编排版本历史（`lens_canvas_flow_version`） | 单独分析：当前已决定先只存当前版本 + version 自增；画布已有 Ctrl+Z 撤销/重做，持久版本回滚后续按需再加 |
| 执行引擎 | **已分析（见 §10）：自由任务节点走 lens 引擎**（`/api/userTask/submit`，v2），tapCanvas 后端执行引擎不需要 |
| 镜头切换（快速定位分镜） | 单独分析：节点太多时快速定位到指定分镜（**不是 tapCanvas 章节工作台现有的 shot 切换**，是画布内定位能力），后续再设计 |

> 结论：**B 类（自由生成节点）lens 已有对应（视频v2 工具栏），对齐即可**；**C 类（vision / 图生提示词 / 提示词精炼 / AI 对话驱动画布）已确认要实现**；D 类 characterMentions 已有；**F 类（subtitle / cameraRef / 自由音频 / 图像裂变 / 马赛克 / 光照 rig）单列待分析**；其余（反推提示词/采样/节点模型选择/工作流IO）标注「待确认」，后续逐个分析处理。

### 8.1 AI 对话驱动画布（要实现）

复用 tapCanvas agents chat 能力，实现「chat → canvas plan → 自动建节点/连线」：

- 画布内置 AI 对话入口，用户自然语言指令（如"加角色 A""生成一张雨天场景图""把角色 A 连到分镜 3"）。
- agents chat 理解意图 → 生成 canvas plan → 通过 `flow patch` 协议（`createNodes`/`createEdges`/`patchNodeData`）自动落节点/连线。
- 结合 Lens 数据：chat 可引用 Lens 资产（角色/场景/道具），自动建带 `entityId` 的节点；编排结果存 `lens_canvas_flow`。
- 涉及语义理解/意图路由由 agents-cli 承担（遵守 tapCanvas AGENTS.md 约束），本地只做结构性校验。

## 9. subflow 分析（角色子造型 / 场景子场景）

### 9.1 subflow 是什么（画布里的形态）

tapCanvas 的 subflow = **一个节点内嵌一个子画布**：

- 节点 `kind: 'subflow'`，`data.subflow = { nodes, edges }` 直接存一个子图。
- 主画布上只显示一个「子工作流节点」；点开（双击）弹出一个**全屏弹层**（88% 宽高），里面是独立的 React Flow 画布，可自由拖拽/连线/编辑子节点。
- 保存后子图写回节点 `data.subflow`，关闭回到主画布（`subflow/Editor.tsx`）。
- 另一种形态 `subflowRef`：节点引用 flow 库里另一个已保存的 flow（复用，`registry.ts`）。

即：**主画布 = 一层；子图 = 节点的第二层画布**，天然表达"主节点 → 一组子节点"的层级。

### 9.2 能否对应角色子造型 / 场景子场景

Lens 数据：

- 角色换装：`lens_role.roleType=1`（换装）+ `parentId` 指向主角色 + `cloneName`（如"红色衣服版/战斗装"）。
- 场景子场景：`lens_asset_image.parentId` 指向主场景 + `variantName`（如"夜晚版/雨天版"）。

**结论：语义匹配，可以使用。**

| 层级 | Lens 实体 | subflow 映射 |
|---|---|---|
| 主节点 | 主角色（roleType=0）/ 主场景（parentId 为空） | subflow 节点（label=主角色名/主场景名） |
| 子节点 | 换装角色（roleType=1，parentId=主角色）/ 子场景（parentId=主场景） | 子图里的 `image` 节点（`entityId` 指向换装 lens_role.id / 子场景 lens_asset_image.id） |

- 数据权威仍在 Lens（换装/子场景从 Lens 拉取）；子图里的节点位置/连线随主 flow 存 `lens_canvas_flow`。
- 换装/子场景可各自独立生成/编辑/连线（符合"功能等同 Lens"）。

### 9.3 subflow vs 「任务结果」展开（两种展开方式，互补不冲突）

| | subflow（子图） | 任务结果展开（平铺连线） |
|---|---|---|
| 用途 | 组织**子实体**（换装/子场景） | 展示**历史生成图**（结果） |
| 形态 | 点开全屏弹层，进子画布 | 主画布上直接展开多个结果节点 |
| 数据 | 换装 lens_role / 子场景 lens_asset_image | 历史图 lens_image / 多版本 |
| 是否可编辑 | 可独立编辑/生成/连线 | 只读展示 |

**建议**：换装/子场景用 **subflow**（子实体，需独立操作）；历史生成图用 **任务结果展开**（只读结果）。两者分层使用，不冲突。

## 10. 执行引擎分析（自由任务节点走哪套）

### 10.1 结论

**自由任务节点（生图/生视频/生音频）走 lens 引擎（`/api/userTask/submit`，v2），tapCanvas 后端执行引擎不需要。**

### 10.2 事实依据

1. **lens 有 v1/v2 两套任务接口**：
   - **v1**：`/api/application/runTask` + `/api/task/list`（`lens_application_task` 表）—— 视频v2 工具栏、角色/场景/道具生图用。
   - **v2**：`/api/userTask/submit` + `/api/userTask/list`（`lens_user_task` 表）—— **自由节点用**（`LensUserTaskController` 注释明确"v1 对应 /api/application/runTask，两者互不影响"）。
2. **tapCanvas 生音频能力弱**：无独立生音频 vendor/tts，`audio` 只是 agents-bridge 的结果字段（audioUrl/audioResults）。
3. **lens 生音频能力强**：BGM（`/api/bgm`）、音色（mock_audio）、角色配音（`batchGenerateAudio`）。

### 10.3 两套引擎对比

| 维度 | tapCanvas 引擎 | lens 引擎 |
|---|---|---|
| 生图 | 强（gemini/banana/grsai） | 强（RhApi/SD588/SDIna/Gemini） |
| 生视频 | 强（veo/kling/yunwu） | 强（VIDU/Seedance/Rh） |
| 生音频 | 弱（无独立 vendor） | 强（BGM/音色/配音） |
| 自由生图/生视频 | 需新建 | 已有（v2 `userTask`） |
| 任务引擎 | 双后端（lens + tapCanvas） | 单一（lens task_queue） |
| 积分/回调/审计/渠道 | 两套 | 统一 |

### 10.4 建议与落地

**自由任务节点走 lens 引擎（`/api/userTask/submit`，v2）**：

- 自由生图/生视频提交 → `POST /api/userTask/submit`（v2，与角色/场景/道具生图的 v1 `runTask` 区分）。
- 结果回填画布节点 → `POST /api/userTask/list` 轮询，或 lens 任务完成回调。
- 自由生音频 → lens 音频能力（BGM/音色/配音）。

**关键收益：架构简化**——既然自由任务节点也走 lens 引擎，**tapCanvas 后端（hono-api）可以完全不用**。画布前端直接对接 lens 后端（业务数据 + 编排 `lens_canvas_flow` + 任务引擎），单一后端。

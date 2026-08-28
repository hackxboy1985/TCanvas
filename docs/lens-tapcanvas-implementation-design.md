# Lens × TapCanvas 画布对接 —— 开发设计方案

> 状态：可供开发落地。已确认项可直接实现，F 类待分析项标注「待分析」。
> 日期：2026-08-27
> 关联文档：[映射初步分析](./lens-tapcanvas-node-mapping.md)｜[对接设计（决策过程）](./lens-tapcanvas-integration-design.md)

## 0. 一句话目标

把 tapCanvas 的 React Flow **自由无限画布**接入 Lens，作为 Lens 短剧创作的**画布化操作界面**：以剧→集为维度，展示/编辑角色、场景、道具、分镜、剧本、台本，并支持自由生成节点（生图/生视频等）与 AI 对话驱动编排。

## 1. 总体架构

```
Lens 前端（Vue/RuoYi）─ 新页面跳转（同域名跨应用，无 iframe）→ tapCanvas 画布（React Flow，自由无限画布）
   └─ tapCanvas 画布（React Flow，自由无限画布）
        │
        ├─ 业务数据 + 编排持久化 → Lens 后端（/api/canvas/*，JWT=Admin-Token cookie）
        └─ 自由任务节点执行 → Lens 任务引擎（/api/userTask/submit，v2）
```

| 后端 | 职责 | 表 |
|---|---|---|
| Lens | 业务数据权威源 + 编排持久化 + 任务引擎（含自由任务节点） | lens_* 业务表 + `lens_canvas_flow`（新增）+ task_queue |

> **执行引擎已分析**（见 integration-design §10）：自由任务节点走 **lens 引擎**（`/api/userTask/submit`，v2），**tapCanvas 后端（hono-api）完全不需要**，画布前端直连 lens 后端。

关键约束：**Lens 后端只增不改**（新增接口/表/字段，不修改现有字段）。

## 2. 数据模型（新增表）

```sql
-- lens_canvas_flow 画布编排持久化表（一集一条，unique drama_id + episode_num）
CREATE TABLE IF NOT EXISTS `lens_canvas_flow` (
    `id`          BIGINT AUTO_INCREMENT PRIMARY KEY,
    `drama_id`    BIGINT NOT NULL COMMENT '剧ID',
    `episode_num` INT NOT NULL DEFAULT 1 COMMENT '集数（选集定位）',
    `name`        VARCHAR(255) DEFAULT NULL COMMENT '编排名称',
    `data`        LONGTEXT COMMENT '编排数据JSON：{nodes, edges, viewport}',
    `version`     INT NOT NULL DEFAULT 0 COMMENT '乐观锁版本号（每次保存+1，用于多人并发冲突检测）',
    `create_by`   VARCHAR(64) DEFAULT NULL COMMENT '创建人',
    `update_by`   VARCHAR(64) DEFAULT NULL COMMENT '最后修改人',
    `del_flag`    TINYINT NOT NULL DEFAULT 0 COMMENT '删除标志 0=正常 1=删除',
    `create_time` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    `update_time` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    UNIQUE KEY `uk_drama_episode` (`drama_id`, `episode_num`),
    KEY `idx_drama_id` (`drama_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='画布编排持久化表';
```

- **data 字段**：存 React Flow 的 `{ nodes, edges, viewport }`，结构对齐 tapCanvas 的 `sanitizeFlowDataForPersistence`。
- **version = 乐观锁版本号**，每次保存 +1，用于**多人并发冲突检测**（团队共享项目，多人可能同时编辑同一集）；**不是版本历史**。
- **create_by / update_by**：创建人 / 最后修改人（团队协作追踪"谁最后改的"）。
- **版本历史（回滚快照）是另一回事**，见 F-7 待分析，当前不实现。
- **SQL 追加**（不新建迁移文件）：追加到已有文件 `zsapps-admin/src/main/resources/sql/novel_split_init.sql` 末尾（建表语句已追加）。

**乐观锁机制（完整说明）**：

1. **冲突检测逻辑**：前端 `getFlow` 读到 `version`（如 3），保存时原样带回 `version=3`；后端 update SQL 用 `WHERE id = #{id} AND version = #{version}` 匹配——匹配则成功（`version + 1`），不匹配（他人已改，version 已变 4）则影响行数 = 0。
2. **冲突处理策略**：影响行数 = 0 时，Controller 返回 `AjaxResult.error("画布编排保存失败，可能已被他人修改，请刷新后重试")`（RuoYi 默认 code=500）；前端收到后提示用户「已被他人修改」，重新调 `getFlow` 拉最新编排覆盖本地，再让用户重做编辑。
3. **实现方式**：**手写 SQL `WHERE version = #{version}`**（mapper 用注解 `@Update`，非 MyBatis Plus `BaseMapper`，故**不用 `@Version` 注解**）。

## 3. 后端接口（只新增 flow 读写，其余复用现有接口）

**调用层级（遵守规范）**：`LensCanvasController → ILensCanvasFlowService → LensCanvasFlowMapper`。
flow 读写是**单表 CRUD**，Controller 直接调同名 Service（符合"简单 CRUD 直接调 Service，组合逻辑才调 Logic"规范），**无需 Logic 层**（此前设计的聚合接口已删除，改为复用现有接口）。

**baseModules 目录结构（按表聚合）**：

```
baseModules/lenscanvasflow/
├── domain/LensCanvasFlow.java
├── mapper/LensCanvasFlowMapper.java
├── service/ILensCanvasFlowService.java
└── service/impl/LensCanvasFlowServiceImpl.java
```

已实现的代码骨架：上述 4 个文件 + `controller/lens/LensCanvasController.java`（flow 读写）。

> **⚠️ 需删除的多余代码**（为已删除的聚合接口准备的 VO，方案改为复用现有接口后不再需要）：
> - `logic/lens/canvas/vo/LensCanvasAssetVo.java`
> - `logic/lens/canvas/vo/LensCanvasStoryboardVo.java`
> - `logic/lens/canvas/vo/LensCanvasEpisodeDetailVo.java`
>
> 资产/分镜数据直接复用现有 VO（`LensAssetEnrichedVo`、`LensStoryboard` 等），上述 3 个 VO 删除。

### 3.1 唯一新增接口（LensCanvasController，前缀 `/api/canvas`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/canvas/{dramaId}/episode/{episodeNum}/flow` | 读编排 |
| POST | `/api/canvas/{dramaId}/episode/{episodeNum}/flow` | 保存编排（upsert，乐观锁） |

flow 读写契约：

```json
// GET /api/canvas/123/episode/1/flow
{ "code": 200, "data": { "id": "1", "dramaId": "123", "episodeNum": 1, "name": "第1集", "data": "{...}", "version": 3, "updateBy": "xxx" } }

// POST /api/canvas/123/episode/1/flow
{ "name": "第1集", "data": { "nodes": [...], "edges": [...], "viewport": { "x":0,"y":0,"zoom":1 } }, "version": 3 }
```

- `version`：乐观锁版本号。保存时按 `version` 匹配，不匹配返回 `{ "code": 500, "msg": "画布编排保存失败，可能已被他人修改，请刷新后重试" }`（前端收到后重新 `getFlow` 拉最新编排覆盖本地）。

### 3.2 复用现有接口清单（画布数据全部走现有接口，不新增聚合接口）

| 画布数据 | 现有接口 | 返回 |
|---|---|---|
| 集列表（选集下拉） | `POST /api/episode/getAllEpisode?dramaId=` | 集列表 |
| 分镜列表 | `GET /api/storyboard/listByEpisode?dramaId=&episodeNum=` | `LensStoryboard` 列表（selectedImageUrl 即最终图/视频 URL） |
| 资产（带 refId=分镜ID） | `POST /api/storyboard/assetsByEpisode` | `LensAssetEnrichedVo` 列表（每行 refId 关联分镜） |
| 剧本（content + scriptContent） | `GET /api/episode/scriptContent?dramaId=&episodeNum=` | 原文 + 台本 |
| 全剧资产-角色（主动加资产） | `POST /api/lensRole/list` | 角色列表 |
| 全剧资产-场景/道具（主动加资产） | `POST /api/lensImage/listHistory?type=1/2` | 场景/道具列表 |
| 剧的风格配置（角色/场景生图、分镜生视频风格） | `POST /api/sysApi/baseConfig/list`（`{pkg: dramaId, type: 'style_config'}`） | 剧风格配置 |
| 生图模型 | `GET /api/model/image` | 生图模型列表 |
| 图生图模型 | `GET /api/model/image2image` | 图生图模型列表 |
| 视频模型 | `GET /api/model/video` | 视频模型列表 |
| 分镜视频模型 | `GET /api/model/shot_video` | 分镜视频模型列表 |
| 角色/场景/道具生图任务（任务结果展开） | `POST /api/task/list` | `lens_application_task` 列表（taskStatus/fileUrl/resMsg） |
| 分镜生视频任务（任务结果展开） | `POST /api/storyboardTask/list` | `lens_storyboard_task` 列表（status/results/errorMsg） |

### 3.3 字段补充（唯一后端改动，只增不改）

**`LensAssetEnrichedVo` 加 `description` 字段**（assetsByEpisode 返回的资产富查询 VO 缺 prompt）：

- 角色节点/场景节点/道具节点需要 prompt（描述/提示词，用于展示 + 后续生成）。
- 现有 `LensAssetEnrichedVo` 无 prompt 字段；而 `LensAssetRefVo` 已有 `description`（`CASE WHEN role.prompt ELSE img.prompt`）。
- **补法**：`LensAssetEnrichedVo` 加 `private String description;`，`selectEnrichedByRefIds` SQL 补 `CASE WHEN r.asset_category = 1 THEN role.prompt ELSE img.prompt END AS description`（只增不改）。
- 视频结果无缺口：分镜生成视频后，`selectedImageUrl` 回填为最终视频 URL，画布直接用。

**完整 SQL 示例**：

- **文件**：`zsapps-admin/src/main/resources/mapper/api/LensAssetRelationMapper.xml`（注意是 `LensAssetRelationMapper`，不是 StoryboardMapper）
- **标签**：`<select id="selectEnrichedByRefIds">`（assetsByEpisode 实际调用的查询）
- **表别名对应**：`r` = `lens_asset_relation`（资产关系表）、`role` = `lens_role`（角色表）、`parent_role` = `lens_role`（父角色，换装角色的主身份名）、`img` = `lens_asset_image`（场景/道具/站位资产表）

```xml
<select id="selectEnrichedByRefIds" resultType="com.zsapps.api.baseModules.lensassetsync.vo.LensAssetEnrichedVo">
    SELECT r.ref_id AS refId, r.asset_category AS assetCategory,
           r.asset_id AS assetId,
           role.id AS roleId,
           CASE WHEN role.role_type = 1 THEN CONCAT(parent_role.role_name, '（', role.clone_name, '）') ELSE role.role_name END AS characterName,
           role.clone_name AS cloneName,
           role.img AS roleImg,
           role.front_img AS frontImg,
           role.three_img AS threeImg,
           img.name AS imgName,
           img.url AS imgUrl,
           img.state AS imgState,
           img.has_human AS hasHuman,
           CASE WHEN r.asset_category = 1 THEN role.prompt ELSE img.prompt END AS description  <!-- 新增字段 -->
    FROM lens_asset_relation r
    LEFT JOIN lens_role role ON r.asset_category = 1 AND role.id = r.asset_id
    LEFT JOIN lens_role parent_role ON role.role_type = 1 AND role.parent_id = parent_role.id
    LEFT JOIN lens_asset_image img ON r.asset_category IN (2, 3, 4) AND img.id = r.asset_id
    WHERE r.ref_type = #{refType} AND r.ref_id IN
    <foreach collection="refIds" item="id" open="(" separator="," close=")">
        #{id}
    </foreach>
    AND r.del = 0
      AND (img.state IS NULL OR img.state != 2)
    ORDER BY r.ref_id, r.asset_category, r.id
</select>
```

### 3.4 前端组装（分镜 + 资产分开查，无冗余）

画布选集后加载现有接口，前端组装：

1. `listByEpisode` → 分镜列表 → 投影成分镜节点。
2. `assetsByEpisode` → 资产列表（带 `refId`）→ 按 `refId` 分组挂到对应分镜；或去重 `assetId` 得到"当前集资产"投影成资产节点。
3. `scriptContent` → 剧本/台本 → 文本节点（默认隐藏）。
4. `baseConfig/list`（style_config）→ 剧风格配置（角色/场景生图、分镜生视频风格）。
5. `model/image`、`model/image2image`、`model/video`、`model/shot_video` → 模型列表（角色节点/场景节点/分镜节点生图生视频用）。

> 分镜和资产**分开查、不冗余**，前端按 `refId` 灵活分组/去重。lens 后端只新增 flow 读写 + 一个 description 字段，其余零开发。

## 4. 前端改造（tapCanvas）

### 4.1 新增 lensApi 适配层

文件：`apps/web/src/api/lens.ts`

- 请求封装：读 cookie `Admin-Token`，加 `Authorization: Bearer`，解包 RuoYi `AjaxResult{code,msg,data}`。
- 类型化函数（复用现有接口）：`listEpisodes`（getAllEpisode）/ `listStoryboards`（listByEpisode）/ `getEpisodeAssets`（assetsByEpisode）/ `getScriptContent` / `listRoles` / `listAssets`（lensImage/listHistory）/ `getFlow` / `saveFlow`。

```ts
async function lensFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const token = getLensToken() // js-cookie 读 Admin-Token
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` } })
  const body = await r.json()
  if (body.code !== 200) throw new Error(body.msg || 'lens 接口失败')
  return body.data ?? body
}
```

**Token 读取方式说明（重要，避免误解）**：

- lens 后端**从 `Authorization` header 读 token**，不是从 cookie 自动读。证据：`TokenService.getToken(request)` 用 `request.getHeader(header)`，`header` 由 `application.yml` 的 `token.header: Authorization` 注入；`TOKEN_PREFIX = "Bearer "`。
- token 存 cookie（`Admin-Token`）只是**前端的存储选择**（`auth.js` 用 `Cookies.get/set`），后端不读 cookie。
- 因此**手动读 cookie 再加到 `Authorization` header 是必要的**（不是多余的），与 lens 前端 `request.js` 的 `Authorization: Bearer ${getToken()}` 完全一致。
- 画布直连同样方式：`js-cookie` 读 `Admin-Token` → 放 `Authorization: Bearer`，无安全隐患。

### 4.2 画布接入点

| 组件 | 改造 |
|---|---|
| 顶部选集下拉 | 调 `listEpisodes`（getAllEpisode）渲染集列表；切换集 → **先自动保存当前集编排（saveFlow）** → 清空画布 → 加载新集 |
| 初始加载 | `listStoryboards` + `getEpisodeAssets` + `getScriptContent` 组装投影成节点 + `getFlow`（有则恢复编排，无则默认布局） |
| 保存 | 画布 nodes/edges 变更 → `saveFlow`（debounce 3s） |
| 主动加资产 | `listRoles` + `listAssets`（lensImage/listHistory）弹资产选择 → 选后建节点/关联 |

**切集自动保存（避免未保存编辑丢失）**：

切换集数前，**自动调用 `saveFlow` 保存当前集的编排**（含未触发 debounce 的编辑），保存成功后再清空画布、加载新集。流程：

1. 用户在选集下拉选新集 → 触发切集。
2. **切集前自动保存**：把当前集的 nodes/edges/viewport 立即 `saveFlow`（不等 debounce）。
3. 保存成功后清空画布 → 加载新集（`listByEpisode` + `assetsByEpisode` + `scriptContent` + `getFlow`）。

> 自动保存是无感的后台操作，用户无需手动保存，切集不丢编辑；乐观锁冲突时提示刷新（同 §6.1）。

### 4.3 节点投影规则（业务数据 → 画布节点）

| Lens 实体 | 画布节点 | data 关键字段 |
|---|---|---|
| 角色 | `image` | `kind:'image'`, `roleId`, `roleName`, `referenceView:'three_view'`, `imageUrl=三视图(threeImg)`, `anchorBindings:[{kind:'character', entityId, label, imageUrl}]`（**只展示三视图，全身图/近身图不处理**） |
| 场景 | `image` | `kind:'image'`, `imageUrl`, `anchorBindings:[{kind:'scene', ...}]` |
| 道具 | `image` | `kind:'image'`, `imageUrl`, `anchorBindings:[{kind:'prop', ...}]` |
| 剧本原文 | `text` | `kind:'text'`, `prompt=content`（默认隐藏） |
| 台本 | `text` | `kind:'text'`, `prompt=scriptContent`（默认隐藏） |
| 分镜 | `text`(storyboardScript) + `image`(分镜图) | 脚本 text + `imageUrl=selectedImageUrl` |

- 节点带 `entityId`（lens 实体 id）+ `sourceProjectId`（dramaId），保证幂等去重、可追溯。

**节点数据存储模式（明确：引用模式，三类数据分开存）**：

| 数据类型 | 存储位置 | 说明 |
|---|---|---|
| 业务属性（prompt、imageUrl 等） | Lens 业务表（lens_role、lens_asset_image 等） | 权威数据源 |
| 编排属性（节点位置、连线关系） | `lens_canvas_flow.data`（nodes/edges/viewport） | 画布特有数据 |
| 节点身份标识 | `node.data.entityId` + `sourceProjectId` | 关联 Lens 业务实体 |

- **业务属性**：从 Lens 业务表实时查询填充（投影到节点展示），编辑通过「保存/提交」按钮调 lens update 接口写回，不存 flow.data。
- **编排属性**：节点位置/连线/展开收起存 `lens_canvas_flow.data`，画布重新打开时恢复。
- **节点身份标识**：`entityId` + `sourceProjectId` 关联 lens 实体，保证幂等去重、可追溯。

> 权威始终在 lens 业务表，flow.data 只存画布编排；节点展示字段是投影快照，重新加载时覆盖。

**设计原则**：

1. **Lens 业务表 = Single Source of Truth**（唯一数据源）。
2. **flow.data 只存画布特有的编排信息**（位置、连线、展开状态、viewport）。
3. **节点的业务属性（角色 prompt、场景 URL）不重复存储在 flow.data 中**。

### 4.4 画布入口设计（两个入口）

**入口一：分镜板 Tv 按钮**

- 位置：`views/lens/creation/scene.vue` 顶部工具栏「刷新」按钮（L22-25）右侧。
- 点击跳转画布（新页面打开，直接跳画布 React 应用），带当前集 `query.episodeNum`：
  ```js
  window.open(`/canvas/?dramaId=${this.$route.params.dramaId}&episode=${this.query.episodeNum}`)
  ```

**入口二：项目列表卡片左右分区**

- 位置：`views/lens/creation/index.vue` 项目卡片 `proj-card`（L54）的 hover 遮罩。
- 现状：整卡 `@click="openProject(item)"`，hover 显示「进入项目」。
- 改造：去掉整卡 click，hover 遮罩拆左右两半，**中线分隔**——左半「进入项目」、右半「进入画布」。
- **操作按钮（编辑/权限/删除等 `proj-card-actions`）继续悬停卡片顶部，不参与左右分区**。

**进入画布的集数（参考分镜板）**

分镜板 `scene.vue` 用 localStorage 持久化当前集数（`getEpisodeStorageKey` → `lens_episode_${dramaId}`）。进入画布读同一 key：

```js
openCanvas(item) {
  const dramaId = item.id;
  const episode = localStorage.getItem(`lens_episode_${dramaId}`) || 1; // 没进过分镜板默认第1集
  window.open(`/canvas/?dramaId=${dramaId}&episode=${episode}`);
}
```

**画布部署（新页面跳转，无 iframe）**

- 画布 React 应用独立构建（Vite `base: /canvas/`），部署到 Lens 同域名 `/canvas/` 静态路径。
- Lens 页面点击「Tv / 进入画布」→ `window.open('/canvas/?dramaId=xxx&episode=yyy')` 跳转到画布 React 应用。
- 同域名 → cookie 共享 `Admin-Token`，画布直接调 Lens 后端接口，免 CORS。
- **不新增 Vue 路由、不用 iframe**。

**部署需改 3 处（照搬 lens 前端模式：构建产物进 Spring Boot 静态目录、打进 jar）**

1. 画布 `apps/web/vite.config.ts` 加 `base: '/canvas/'`（当前只有 outDir，base 默认 `/`，必须改）。
2. 画布构建产物 `dist/` 内容复制到 `zsapps-admin/src/main/resources/templates/canvas/`（与 lens 前端 `templates/ndist/` 同模式，`application.yml` 的 `static-locations` 已含 `classpath:/templates/`）。
3. `SecurityConfig` permitAll 列表加 `/canvas/**`（只增不改，与 `/ndist/**`、`/kdist/**` 并列）。

> 打包后 Spring Boot 托管 `/canvas/` 静态资源，与 lens 前端同域名、同 jar。

**① 构建自动化（不手动复制）**

画布 `apps/web/package.json` 加脚本，一键构建 + 复制：

```json
"build:lens": "vite build --mode production --base=/canvas/ && node ./scripts/sync-to-lens.mjs"
```

`apps/web/scripts/sync-to-lens.mjs`（把 dist 复制到 lens 后端的 templates/canvas/）：

```js
import { cpSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
// apps/web → lens/zsapps-admin（相对 4 层）
const dest = resolve(__dirname, '../../../../zsapps-admin/src/main/resources/templates/canvas')
rmSync(dest, { recursive: true, force: true })
cpSync(resolve(__dirname, '../dist'), dest, { recursive: true })
console.log('画布产物已同步到 templates/canvas/')
```

**② Nginx 说明**

lens 当前**无 Nginx**（`docker/` 只有 jenkins-slave、lens-frontend-builder、nodejs-build），是 **Spring Boot 直接托管静态资源**（`static-locations: classpath:/static/,classpath:/templates/`）。所以 `/canvas/**` 由 Spring Boot 直接服务，**不需要额外 Nginx 配置**。若将来引入 Nginx，才需把 `/canvas/` 转发到后端。

**③ 开发环境调试（画布 dev 直连 lens 后端）**

画布 `pnpm dev:web` 跑在 5173，lens 后端跑在 9096。开发时画布 `apps/web/vite.config.ts` 的 `server.proxy` 改为指向 lens 后端（当前默认指向 tapCanvas 后端 `http://api:8788`）：

```js
server: {
  proxy: {
    '/api': {
      target: 'http://localhost:9096',   // lens 后端
      changeOrigin: true,
      // 注意：lens 接口就是 /api/xxx，不要 rewrite（tapCanvas 后端才需要去掉 /api 前缀）
    },
  },
},
```

开发环境 token：**cookie 按 host（域名）隔离、不按端口**，`localhost:9096`（lens 后端）和 `localhost:5173`（画布 dev）都是 `localhost`，所以 `Admin-Token` cookie **同域共享，画布 dev 能直接读到**，无需手动复制。唯一注意：若画布 dev 用 `127.0.0.1`、lens 用 `localhost`，两者 host 不同才读不到（保持统一用 `localhost` 即可）。生产环境同域名（同 jar）同样直接共享。

### 4.5 前端改造范围（本期 vs II 期）

**本期保留（不改，II 期处理）**：
- 画布核心功能（拖拽、连线、节点编辑）
- AI 对话侧边栏、节点右键菜单、工具栏
- Project 创建/删除/重命名 UI
- **Canvas 创建/删除 UI**
- 左侧 Project 列表侧边栏

**本期改造（画布接入 lens 的最小改动）**：
1. `base: '/canvas/'`（构建配置）
2. 画布入口读 URL query 参数（`dramaId` + `episode`）→ 直接渲染 Canvas + 顶部选集下拉
3. 顶部选集下拉（代替 Project/Canvas 两级导航，调 `listEpisodes`）

**路由改造方案**：

- tapCanvas 原生路由是 `App.tsx` 里**手写正则匹配**（非 React Router 配置式），集中在 `App.tsx` 一个文件：`/projects`（项目列表）、`/projects/:id/chapters/:id`（章节工作台）、默认 `RootEntryPage`。
- 改为：画布入口 URL `/canvas/?dramaId=xxx&episode=yyy`（query 参数，非路径参数）。
- 改造点集中在 `App.tsx` 路由判断处：加「读 query 参数 dramaId/episode → 渲染 Canvas」入口；**不删除** Project/Chapter 列表页（保留 II 期），画布入口只是绕过它们。

> 结论：路由改造是"App.tsx 加一个入口 + base 改 /canvas/ + 顶部下拉"，不是"大量路由改造"。

## 5. 节点模型

### 5.1 两类节点

| 类别 | 节点 | 数据权威 | 执行 |
|---|---|---|---|
| Lens 业务节点 | 角色/场景/道具/分镜/剧本/台本 | Lens | 生图走 `/api/application/runTask`，分镜生视频走 `/api/storyboardTask/submit` |
| 自由任务节点 | 生图(非角色/道具/场景)/生视频/生音频/文本 | lens 引擎（`/api/userTask/submit`，v2） | 画布原生新建，与 Lens 无关 |

**自由任务节点持久化方案（数据分离）**：

自由任务节点没有对应的 lens 业务表，数据分两处存：

| 数据 | 存储位置 | 说明 |
|---|---|---|
| 节点位置、连线、prompt/model（任务参数） | `flow.data`（node.data） | 画布编排 + 自由节点任务参数 |
| `taskId`（关联） | `flow.data`（`node.data.taskId`） | **关键关联**：`lens_user_task` 表无 dramaId/episodeNum，只能靠 taskId 关联 |
| 任务状态（status/progress/resultUrl） | `lens_user_task` 表（`status`/`results`/`errorMsg`） | 任务状态和结果，**不存 flow.data** |

**任务提交流程**：

1. 用户创建自由任务节点，填参数（prompt/model）。
2. 调 `/api/userTask/submit` 提交任务，返回 `taskId`。
3. 写入 flow.data：`node.data.taskId = taskId`（关键关联）。
4. 轮询任务状态（5s），更新节点 UI（**不写回 flow.data**）。

**画布重新打开时**：从 flow.data 提取所有节点的 `taskId` → 查询任务状态（`/api/userTask/list` 按 id 过滤）→ 更新节点 status/resultUrl（不写回 flow.data）。

> 核心：flow.data 只存 `taskId` 关联，任务状态（status/result）存 `lens_user_task` 表，查询时填充到节点 UI——避免"每次保存 flow 都要更新任务状态"导致的频繁变化，也与「引用模式」一致（动态状态不存编排）。

### 5.2 「任务结果」展开按钮（业务节点）

- 角色/场景/道具/分镜节点带「展示任务结果」按钮。
- 展开后主节点 → 连线 → 多个结果节点，**三态展示**：成功图 / 生成中进度 / 失败原因（不隐藏失败）。
- 节点 `status` 字段：`success`(SUCCESS，带 imageUrl) / `running`(RUNNING/QUEUED/CREATE，带 progress) / `failed`(FAILED/ERROR，带 errorMsg/resMsg)。
- 展开/收起状态随 flow 持久化。

**任务结果数据来源（两类任务，接口和表都不同，必须区分）**：

| 节点 | 任务类型 | 查询接口 | 表 |
|---|---|---|---|
| 角色/场景/道具 | 生图任务 | `POST /api/task/list` | `lens_application_task` |
| 分镜 | 生视频任务 | `POST /api/storyboardTask/list` | `lens_storyboard_task` |

> 角色/场景/道具生图查 `/api/task/list`，分镜生视频查 `/api/storyboardTask/list`——**不是同一个接口、不是同一张表**，画布展开对应节点时按各自接口查。

**实时更新机制（轮询，对齐 lens 现有 scene.vue 的 `_agentPollTimer`）**：

1. **方式**：**轮询**（非 SSE/WebSocket——lens 的任务状态查询现有就是轮询，SSE 仅用于 chat 对话链路）。
2. **频率**：**5 秒**（对齐 `scene.vue` 的 `setInterval(pollAgentTasks, 5000)`）。
3. **策略**（避免频繁查库）：
   - 全局一个定时器，**只在「任务结果」展开时轮询，收起即停**。
   - 只轮询 `RUNNING`/`QUEUED` 的未完成任务，全部到终态（`SUCCESS`/`FAILED`/`ERROR`）后自动 `clearInterval`。
   - 按节点类型走对应接口：角色/场景/道具展开查 `/api/task/list`，分镜展开查 `/api/storyboardTask/list`。
   - Redis 缓存：复用 lens 现有 task 查询缓存，画布侧不再额外加缓存。

```ts
// 画布侧轮询示例（5 秒轮询 + 完成后停止；按节点类型选接口）
const pollTaskStatus = (nodeKind: 'asset' | 'storyboard') => {
  const timer = setInterval(async () => {
    const pending = runningNodes.filter(n => n.status === 'running');
    if (pending.length === 0) { clearInterval(timer); return; }
    // 角色/场景/道具生图 → /api/task/list；分镜生视频 → /api/storyboardTask/list
    const url = nodeKind === 'storyboard' ? '/api/storyboardTask/list' : '/api/task/list';
    const status = await lensFetch(url, { method: 'POST', body: { dramaId, episodeNum } });
    updateNodesStatus(status);
  }, 5000);
};
```

**性能策略（懒加载 + 单独展开，避免一次查大量任务状态）**：

1. **任务结果懒加载**：**展开时才查询，不展开不查询**。初始加载只拉分镜列表 + 资产列表（`listByEpisode` + `assetsByEpisode`），**不查询任何任务结果**。
2. **单独展开**：每个角色/场景/道具/分镜节点**独立点击才展开**，**不存在「展开所有节点」的功能**——因此同一时刻最多只查 1 个节点的任务结果，不会出现几十个候选图同时查状态的情况。
3. 收起时：清除该节点的任务结果节点 + 停止该节点的轮询。

> 这样即便一集 50+ 分镜、每分镜多资产，初始加载也只查 2 个列表接口；任务状态查询是"按需、单点、懒加载"，不会放大。

### 5.3 subflow（换装/子场景）

- 换装角色（`lens_role.roleType=1`, parentId）→ 主角色节点的 subflow 子图。
- 子场景（`lens_asset_image.parentId`）→ 主场景节点的 subflow 子图。
- 主节点 = subflow 节点；子节点 = 子图内 image 节点（entityId 指向换装/子场景 id）。

### 5.4 关键节点新增功能（与 lens 对齐）

**关键节点**：角色、场景、道具、分镜。与现有画布不同——现有画布是「分镜图生视频」，本画布是「参考图 + 提示词生视频」；相同点是都有**分镜号可切换**（对应 lens 的「切换镜头」）。

| 节点 | 新增功能 | 对应 lens 接口 | 说明 |
|---|---|---|---|
| 角色 | 「新增角色」按钮，**输入角色名**（+可选描述） | `POST /api/lensRole`（add） | 创建后返回新角色 id → 投影成角色节点 |
| 场景 | 新增场景 | `POST /api/lensImage/upload`（type=1） | 投影成场景节点 |
| 道具 | 新增道具 | `POST /api/lensImage/upload`（type=2） | 投影成道具节点 |
| 分镜 | **分镜节点上点击「插入」按钮** | `POST /api/storyboard/insert`（带 `type` + `order`） | 在当前分镜节点前/后插入新分镜，后续分镜号顺延——与 lens 插入逻辑对齐；插入后刷新 `listByEpisode` 重新投影 |

**提交任务接口（点击节点弹出编辑框，提交生图/生视频任务，接口不同必须区分）**：

| 节点 | 编辑框 | 提交任务接口 | 说明 |
|---|---|---|---|
| 角色 | 角色编辑框 | `POST /api/application/runTask` | appId=角色生图应用 |
| 场景 | 场景编辑框 | `POST /api/application/runTask` | appId=场景生图应用 |
| 道具 | 道具编辑框 | `POST /api/application/runTask` | appId=道具生图应用 |
| 分镜 | 分镜编辑框 | `POST /api/storyboardTask/submit` | 分镜生视频 |

> 参考 lens 前端实际调用：角色/场景/道具生图统一走 `/api/application/runTask`（`RoleManagerPage`、`AssetEditDrawer`、`SceneVariantEditDrawer` 都用 `runTask`，appId 区分生图类型）；分镜生视频走 `/api/storyboardTask/submit`（`storyboard-task/index.vue` 的 `submitTask`）。**两者不是同一个接口**，画布提交时按节点类型区分。

**分镜插入的顺延逻辑（在分镜节点上点击插入，说清楚）**：

用户在**某个分镜节点 N** 上点击「插入」按钮，弹选择「前插 / 后插」：

1. **前插（type=before）**：新分镜插到 N 的位置（`editOrder = order`），原分镜 N 及之后的分镜号 `+1` 顺延。
2. **后插（type=after）**：新分镜插到 N+1 的位置（`editOrder = order + 1`），原分镜 N+1 及之后的分镜号 `+1` 顺延。

后端逻辑（对应 `insertLensStoryboard` + `insertTempStoryboard`）：

```java
int editOrder = "before".equalsIgnoreCase(type) ? order : order + 1;
lensStoryboardMapper.updateOrder(dramaId, episodeNum, editOrder);  // 把 >= editOrder 的分镜号 +1 顺延
lensStoryboard.setStoryboardOrder(editOrder);                       // 新分镜落在 editOrder
```

- `updateOrder` 按 `episode` 作用域（一集内）重排分镜号，`order` 是当前分镜节点的 `storyboardOrder`。
- 前端插入成功后**重新拉 `listByEpisode`**，按新分镜号更新节点（见下方「节点 ID 与连线保持」）。

**分镜插入的节点 ID 与连线保持策略**：

1. **节点 ID 用实体 ID，不用分镜号**：`node.id = 'storyboard-${entityId}'`（稳定不变），`node.data.order = storyboardOrder`（仅用于排序和显示）。插入导致分镜号顺延时，节点 ID 不变，只更新 `node.data.order`。
2. **插入后增量更新（不整清空重建）**：
   - 调 `insert` 插入新分镜 → 重拉 `listByEpisode`。
   - 按 `entityId` 匹配现有节点 → 更新 `node.data.order`（顺延后的新号），**不删除节点**。
   - 为新插入的分镜创建新节点。
   - **保留所有连线（edges 不变）**。
3. **连线语义**：画布连线表示「工作流依赖」，**不是分镜顺序**；分镜顺序由 `storyboardOrder` 决定，与连线无关。插入分镜后连线保持不变（依赖关系没变）。
4. **可选布局**：新节点插入后，后续节点位置可自动下移（reflowLayout），保持视觉顺序与分镜号一致。

### 5.5 节点点击后的编辑框（复用画布现有 NodeInspector）

**所有画布节点点击后，复用画布现有编辑框 `NodeInspector`**（tapCanvas 原生节点检查器，按 `kind` 渲染表单），不新做、不复用 lens 编辑框。

| 节点 | 编辑框（画布 NodeInspector 按 kind 渲染） | 说明 |
|---|---|---|
| 自由任务节点 | 文生图/图生图/合成视频等表单 | tapCanvas 原生，无需改 |
| 角色 | image 节点表单 + **角色名/描述字段 + 生图按钮** | 在 NodeInspector 表单里加 lens 字段 |
| 场景/道具 | image 节点表单 + 名称/提示词 + 生图按钮 | 同上 |
| 分镜 | 脚本/台词/说话人字段 + 生视频按钮 + **插入按钮** | 同上 |
| 换装/子场景（subflow 子图内） | **imageEdit（图生图）表单** | 复用画布现有图生图编辑框，基于主图生成变体 |

> 编辑框载体复用画布 `NodeInspector`，按节点 `kind` 渲染对应表单；lens 特有的字段/操作（角色名、分镜插入、生图/生视频按钮）作为表单扩展加进去，提交时调 lens 接口（见 §5.4 提交任务接口）。**画布是画布的编辑框，不是复用 lens 的编辑框**。

**编辑框的「保存」与「提交任务」两个按钮（写回 Lens 的时机）**：

编辑框底部并列两个按钮：

| 按钮 | 行为 | 说明 |
|---|---|---|
| **保存**（仅保存） | 把编辑的字段写回 Lens（调 update 接口），**不提交生图/生视频任务** | 例：改角色 prompt → `PUT /api/lensRole` 写回 `lens_role.prompt` |
| **提交任务**（保存并提交） | 先写回 Lens（同上），**再提交生图/生视频任务** | 例：改 prompt 后 `runTask` 生图 |

写回 Lens 的 update 接口（按节点类型）：

| 节点 | 保存接口 |
|---|---|
| 角色 | `PUT /api/lensRole`（prompt/roleName 等） |
| 场景/道具 | `PUT /api/lensImage`（prompt/name 等） |
| 分镜 | `POST /api/storyboard/edit`（scriptContent/shots/line 等） |

> **flow.data 只存纯编排数据**（节点位置/连线/展开收起），**不存业务字段**（prompt/角色名/脚本等）。业务字段的修改一律通过「保存/提交任务」写回 lens 表，避免 flow.data 与 lens 表数据不一致。节点上的业务字段展示从 lens 数据投影而来，编辑保存后刷新该节点的投影字段。

**数据变更同步策略**：

画布节点是 lens 数据的"投影"，业务数据变更（角色图更新、分镜编辑、资产关联变化）**不做实时推送/轮询**，采用**返回画布时重新拉一遍**：

- 每次进入/返回画布（页面加载、选集切换）→ 重新拉 `listByEpisode` + `assetsByEpisode` + `scriptContent` → 重新投影节点。
- 再读 `getFlow` 恢复编排（节点位置/连线/展开收起）。
- 唯一例外：**任务结果**（生图/生视频任务状态）是展开时才轮询（见 §5.2），不随"重新拉一遍"覆盖进行中的任务节点。

> 即：业务数据是"进入时快照"，任务状态是"展开时实时"。两者分离，避免频繁拉业务数据。

## 6. 鉴权与权限校验

| 链路 | 方式 |
|---|---|
| 画布 → Lens | `Admin-Token` cookie → `Authorization: Bearer`（同域名自动带） |

- 部署：tapCanvas 画布构建产物放到 Lens 同域名 `/canvas/` 路径，Lens 页面新页面跳转打开（免 CORS、cookie 共享）。

**flow 读写权限校验（读/写分离）**：

| 操作 | 权限 | 说明 |
|---|---|---|
| flow **读**（GET） | `@CheckDrama("#dramaId")` | 有该剧访问权即可读编排 |
| flow **写**（POST） | `@CheckDrama` + `canEditConfig` 等价校验 | 仅 **admin / 剧创建者 / 企业祖先** 可写 |

写权限的 `canEditConfig` 等价逻辑（对齐 `ApiBaseConfigController.canEditConfig`）：

```java
private boolean canEditConfig(Long dramaId) {
    LoginUser loginUser = SecurityUtils.getLoginUser();
    if (loginUser.getUser().isAdmin()) return true;                              // 1. admin 放行
    LensDrama drama = lensDramaService.selectLensDramaById(dramaId);
    if (drama != null && loginUser.getUserId().equals(drama.getUserId())) return true; // 2. 剧创建者放行
    if (Integer.valueOf(2).equals(loginUser.getUser().getAccountType()) && drama != null) {
        return hierarchyPermissionService.isAncestorOf(loginUser.getUserId(), drama.getUserId()); // 3. 企业账号须是祖先
    }
    return false;                                                               // 4. 其他一律拒绝
}
```

> 遵守 CLAUDE.md 权限规则：写操作必须加 `canEditConfig()` 或等价校验，前端 `canEdit` 仅 UI 禁用，不作为安全边界；`canModifySubDrama` 是死代码不要依赖。

### 6.1 错误处理与降级

**① 画布加载失败（接口超时 / 数据损坏）**

- 接口超时或返回非 200 → 捕获后提示「画布加载失败」，提供「重试」和「返回分镜板」两个选项。
- flow `data` JSON 解析失败（数据损坏）→ 提示「编排数据损坏」，提供「重置编排」（清空 `lens_canvas_flow` 重新投影）和「返回分镜板」两个选项。

**② 保存失败（乐观锁冲突 / 网络中断）**

- 乐观锁冲突（返回 code=500 + "已被他人修改"）→ 提示「编排已被他人修改，请刷新后重试」，确认后重新 `getFlow` 拉最新编排覆盖本地。
- 网络中断（fetch 抛错）→ 提示「保存失败，请检查网络」，保留本地编辑，提供「重试保存」。

```ts
try {
  const flow = await lensFetch(`/api/canvas/${dramaId}/episode/${episodeNum}/flow`);
  loadFlow(flow.data);
} catch (error) {
  if (String(error?.message || '').includes('已被他人修改')) {
    showDialog('编排已被他人修改，请刷新后重试', { onConfirm: () => location.reload() });
  } else {
    showDialog('画布加载失败', { confirmText: '返回分镜板', onConfirm: () => window.location.href = `/project/detail/${dramaName}/${dramaId}` });
  }
}
```

**③ 画布白屏 / 崩溃回退**

- 用 React Error Boundary 包住画布根组件，渲染崩溃时显示错误页 + 「返回分镜板」按钮。
- 返回分镜板 URL：`/project/detail/{dramaName}/{dramaId}`（即 lens 的分镜板路由，`tabsPanel` 的 `scene` tab）。

> 原则：任何错误都不静默吞掉，显式提示用户并给回退入口（重试 / 重置 / 返回分镜板），符合 tapCanvas「显式失败、零隐式回退」约束。

## 7. 分阶段实施计划

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **P0** | Lens 后端：`lens_canvas_flow` 表 + `LensCanvasController`（flow 读写）+ `LensAssetEnrichedVo` 加 description 字段 | 无 |
| **P1** | 前端：`lensApi` 适配层 + 画布接入（选集/初始加载/保存/主动加资产） | P0 |
| **P2** | 节点模型：业务节点投影 + 「任务结果展开」按钮 + subflow（换装/子场景） | P1 |
| **P3** | 写操作接入：新建/编辑/删除/生成（复用 Lens 现有接口） | P2 |
| **P4** | C 类：vision / image_to_prompt / prompt_refine / AI 对话驱动画布 | P1（可与 P2/P3 并行） |
| **P5** | F 类待分析项逐个落地（见 §9） | 各单项分析后 |

### 7.1 P2 节点模型深化实施清单（A-F，按步骤实施）

> 状态：⬜ 待做 / ✅ 已完成。实施顺序：A → E → B → D → C → F。

**部署落地（✅ 已完成，2026-08-28）**：画布以静态产物方式部署到 lens 同域名 `/canvas/` 路径，验证后即可从 lens 前端两个入口（scene.vue「画布」按钮 / index.vue 卡片右半）跳转。落地要点：

1. `apps/web/vite.config.ts` 设 `base: '/canvas/'`，产物内资源路径全部为 `/canvas/assets/...`。
2. `apps/web/scripts/sync-to-lens.mjs`（`build:lens` 脚本）把 dist 复制到 `zsapps-admin/src/main/resources/templates/canvas/`（源码 + target/classes 同步生效）。
3. **lens 后端 `ResourcesConfig`**（重要新增）：`templates/` 不是 Spring Boot 默认静态目录，必须显式映射——`registry.addResourceHandler("/canvas/**").addResourceLocations("classpath:/templates/canvas/")`，并加 `/canvas`、`/canvas/` 两个 ViewController 转发到 `/canvas/index.html` 兜底（SPA 内部用查询参数路由，无需 history fallback）。
4. lens `SecurityConfig`：`/canvas/**` 已加入 permitAll（GET），`/canvas/index.html` 加入 HEAD 放行。
5. 入口 URL：`/canvas/?dramaId={dramaId}&episode={episodeNum}`（同 host 共享 Admin-Token cookie，画布 lensApi 直接读 cookie 调 `/api/**`）。

**A. 节点投影细化**

| # | 工作项 | 状态 | 说明 |
|---|---|---|---|
| A.1 | 角色节点展示 | ✅ 已完成 | **只展示三视图（threeImg），全身图/近身图不处理**（代码已改） |
| A.2 | 分镜节点设计 | ✅ 已完成 | **分镜是单个节点**（非脚本+图两个节点）；节点 16:9（384×216，媒体按实际比例自适应宽度）；顶部栏=分镜号+时间段+时长秒数；点击浮出独立编辑面板（上游参考+提示词编辑模式/JSON+生视频模型+画幅/分辨率/积分+生成+保存到分镜板）；引用连线（资产→分镜）默认生成 |
| A.3 | 剧本/台本节点 | ⬜ 待做 | 默认隐藏 + 可展开（顶部切换按钮） |

**A.2 分镜节点详细设计（参考生视频，复制现有分镜节点组件改造）**：

- **定位**：画布分镜节点是「参考图 + 提示词生视频」的节点；tapCanvas 现有 storyboard 分镜节点是「分镜图生视频」，**保留不动**。新节点复制现有节点组件出来后修改。
- **单个节点**：所有展示都在一个分镜节点内（不是脚本/图拆两个节点）。

节点内容（从上到下）：

1. **顶部栏**：分镜号（storyboardOrder）+ `timeOfDay`（时间，展示在分镜号后）。`atmosphere`（氛围）**不展示**。
2. **中间区域**：
   - `selectedImageUrl` 为 null/''（未生成结果）→ 展示 `scriptContent`（分镜脚本）。
   - 有结果 → 展示分镜图/视频，**默认不展示脚本**；点击节点后弹编辑框展示脚本等。
   - `shots`（镜头描述）**不展示**。
3. **状态圆点（对齐 lens 分镜板 SceneShotCard L55-66）**：
   - `videoStatus=1/4`（生成中/智能分析中）→ 淡黄呼吸圆点（generating）。
   - `videoStatus=2`（成功）→ 绿色圆点，叠加 `analyzeState=1` 浅蓝呼吸光圈、`lineArtStatus=1` 浅黄呼吸光圈、失败时红色静态圈。
   - `videoStatus=3`（失败）→ 红色圆点。
4. **底部引用行（最下一排，可开关）**：从左至右展示该分镜引用的**场景、道具、角色、站位参考**（数据来自 `assetsByEpisode` 按 refId 关联，含 assetCategory=4 站位）。
   - 角色引用：角色图上叠加**说话者图标**（`speakerName` 匹配的角色显示说话图标；点击切换：绿色点亮=说话者，置灰=非说话者，类似微信语音图标）。
5. **画布最顶部开关**：打开显示底部参考引用行，关闭不展示。

**B. 「任务结果」展开按钮**

| # | 工作项 | 状态 | 说明 |
|---|---|---|---|
| B.1 | 展开按钮 | ⬜ 待做 | 角色/场景/道具/分镜节点各带「展示任务结果」按钮 |
| B.2 | 三态结果节点 | ⬜ 待做 | 展开后主节点 → 连线 → 多个结果节点（成功图/生成中进度/失败原因） |
| B.3 | 轮询 + 懒加载 | ⬜ 待做 | 5s 轮询（只轮询未完成，终态后停止）；展开才查、单独展开（无展开所有） |
| B.4 | 数据源区分 | ⬜ 待做 | 生图任务 `/api/task/list`；分镜生视频 `/api/storyboardTask/list` |

**C. subflow（换装/子场景）**

| # | 工作项 | 状态 | 说明 |
|---|---|---|---|
| C.1 | 换装子图 | ⬜ 待做 | 主角色节点 → subflow 子图（换装节点，entityId 指向换装 lens_role.id） |
| C.2 | 子场景子图 | ⬜ 待做 | 主场景节点 → subflow 子图（子场景节点，entityId 指向子场景） |
| C.3 | 子图数据加载 | ⬜ 待做 | 换装/子场景列表从 lens 接口拉（lensRole/list 按 parentId、lensImage/listHistory 按 parentId） |

**D. 节点编辑框扩展（复用画布 NodeInspector）**

| # | 工作项 | 状态 | 说明 |
|---|---|---|---|
| D.1 | 角色编辑框 | ⬜ 待做 | 角色名/描述字段 + 生图按钮（`/api/application/runTask`） |
| D.2 | 场景/道具编辑框 | ⬜ 待做 | 名称/提示词 + 生图按钮（runTask） |
| D.3 | 分镜编辑框 | ⬜ 待做 | 脚本/台词/说话人/时间/氛围 + 生视频按钮（`/api/storyboardTask/submit`）+ 插入按钮 |
| D.4 | 换装/子场景编辑框 | ⬜ 待做 | 图生图（imageEdit）表单，基于主图生成变体 |
| D.5 | 保存/提交两按钮 | ⬜ 待做 | 「保存」= 写回 lens update（`PUT /api/lensRole`、`PUT /api/lensImage`、`/api/storyboard/edit`）；「提交任务」= 写回 + 提交 |

**E. 节点新增/插入**

| # | 工作项 | 状态 | 说明 |
|---|---|---|---|
| E.1 | 新增角色 | ⬜ 待做 | 输入角色名 → `POST /api/lensRole` → 投影节点 |
| E.2 | 新增场景/道具 | ⬜ 待做 | `POST /api/lensImage/upload`（type=1/2）→ 投影节点 |
| E.3 | 分镜插入 | ⬜ 待做 | 分镜节点「插入」（前插/后插）→ `POST /api/storyboard/insert`（type+order）→ 增量更新（节点 ID 保持 entityId、order 更新、连线保持） |

**F. 数据同步完善**

| # | 工作项 | 状态 | 说明 |
|---|---|---|---|
| F.1 | 资产关联 | ⬜ 待做 | 选资产加载到分镜 → `saveRelations` → 主动刷新 `assetsByEpisode` |
| F.2 | 返回画布重拉 | ⬜ 待做 | 页面加载/选集切换重拉数据（P1 已有基础，验证覆盖） |

## 8. 决策汇总

**已决定：**
- 自由无限画布 + 复用 tapCanvas flow 引擎（编排存 Lens `lens_canvas_flow`）
- 只存当前版本 + version 自增（Ctrl+Z 已覆盖日常撤销）
- 约定键 `lens_drama:{dramaId}`（如需 tapCanvas project 概念）
- 默认加载当前集资产 + 主动加全剧资产（用户触发）
- 任务结果三态展示：成功图 / 生成中进度 / 失败原因（不隐藏失败）
- 换装/子场景用 subflow，历史图用任务结果展开
- C 类要实现（vision/image_to_prompt/prompt_refine/AI 对话驱动画布）
- 接口前缀统一 `/api/canvas`
- 功能等同 Lens（可新建/编辑/删除/生成）
- 执行引擎走 lens（生图 `/api/application/runTask`、分镜生视频 `/api/storyboardTask/submit`、自由节点 `/api/userTask/submit`，tapCanvas 后端不需要）
- 复用现有接口（listByEpisode/assetsByEpisode/scriptContent 等），只新增 flow 读写
- 风格配置 + 模型列表走现有接口（baseConfig/list + model/image、image2image、video、shot_video）
- 分镜视频 URL 用 selectedImageUrl（无缺口）；LensAssetEnrichedVo 补 description 字段（唯一字段补充）
- **引用模式**：业务属性存 lens 表（Single Source of Truth）、编排属性存 flow.data、节点身份存 entityId；业务属性不重复存 flow
- **数据变更同步**：返回画布时重新拉一遍（业务数据快照 + 任务状态实时，两者分离）
- **切集自动保存**：切集前自动 saveFlow 当前集编排（不等 debounce），避免未保存编辑丢失
- **任务结果**：轮询 5s、懒加载（展开才查）+ 单独展开（无展开所有）
- **分镜插入**：node.id 用 `storyboard-${entityId}`（不用分镜号）、order 只作排序；插入后增量更新（保留节点/更新 order/新增节点/保留连线）；连线 = 工作流依赖，非分镜顺序
- **编辑框**：复用画布 NodeInspector（不新做、不复用 lens 编辑框）；底部「保存」（写回 lens）+「提交任务」（写回 lens + 提交）两按钮
- **自由任务节点持久化**：flow.data 存 prompt/model/taskId，任务状态（status/result）存 lens_user_task 表，查询时填充不写回
- **权限校验**：flow 读 @CheckDrama；flow 写 @CheckDrama + canEditConfig（admin/创建者/企业祖先）
- **资产关联**：saveRelations 后主动刷新 assetsByEpisode（画布比 lens 分镜板多一步刷新）
- **前端改造范围**：本期只做 base=/canvas/ + 入口读 query 参数 + 顶部选集下拉；Project/Canvas 管理 UI 保留 II 期
- **错误处理**：加载失败/乐观锁冲突/白屏崩溃均有提示 + 回退入口（重试/返回分镜板）

**待分析（F 类 7 项）：**
1. 字幕 subtitle
2. 机位参考 cameraRef
3. 自由生音频 audio
4. 图像裂变 imageFission
5. 马赛克/拼图 mosaic
6. 光照 rig
7. 编排版本历史

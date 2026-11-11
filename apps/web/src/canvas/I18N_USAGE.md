# Canvas 国际化（i18n）使用与状态

> 更新：2026-11-10（画布全量 i18n 恢复推进）。源码词表在 `src/canvas/i18n/`，构建产物由 lens 后端 `/canvas/` 托管。

## 1. 语言来源与优先级

画布加载时按以下顺序确定语言（只支持 `zh` / `en`）：

1. URL 参数 `?lang=` / `?locale=`（lens 主应用打开画布时传入，值可为 `en`、`en-US`、`zh`、`zh-CN`；兼容 hash 路由）
2. lens 主应用语言偏好 `localStorage['lens_locale']`（`zh-CN` / `en-US`，同源共享）
3. 画布自身历史选择 `localStorage['tapcanvas-language']`（画布右上角语言切换会写入）
4. 浏览器语言 `navigator.language`

lens 入口（`RuoYi-Vue3/src/utils/canvasEntry.js`）已按当前页面语言拼接 `?lang=`，因此主应用切英文后打开画布即为英文。直接访问 `/canvas/`（无参数）时按上面 2→4 回退。

**手动切换**：
- Lens 画布（`/canvas/?dramaId=...`，LensCanvasApp 顶栏）：右上角 **🌐 语言按钮**（`lens-canvas-lang-toggle`），点击在 zh/en 间切换，并同步更新 URL `lang` 参数（刷新/重开保持）。
- 通用画布（非 dramaId 模式，App.tsx 顶栏）：右上角语言图标 `app-language-toggle`，行为相同。
- 因为画布 i18n 在加载时确定（非响应式），模块级常量文案在切换后需要刷新页面才能全部更新。

## 2. 词表结构

- `src/canvas/i18n/index.ts`：i18n 运行时（`$` / `$t` / `useI18n` / `getCurrentLanguage` / `setLanguage` / `initLanguage`）+ 内置基础词表 `builtinEnTranslations`（历史通用词汇）。
- `src/canvas/i18n/locales/*.ts`：分批英文词表（按模块拆分，便于并行维护），由 `index.ts` 统一 spread 合并：
  ```
  appShell  — App 壳层/登录/账户/资产小面板
  canvasCore — 画布核心（Canvas/components/utils/edges）
  nodes      — 画布节点（canvas/nodes/**）
  projects   — 项目页（projects/**）
  uiPanels1  — 核心 UI 面板（资产/模板/账户/Tapshow/执行/历史/参数/模型）
  uiPanels2  — chat / nanoComic / Agent 面板
  stats      — 统计与系统管理（ui/stats/**）
  misc       — runner/api/ai/inspector/storyboard/flows/config
  ```

## 3. 使用方式

```tsx
import { $, $t } from '../canvas/i18n' // 相对路径按文件位置

// JSX 文本
<span>{$('我的项目')}</span>

// 属性
<Button title={$('运行')}>{$('运行')}</Button>

// 变量插值（key 里用 {{x}}，源码写中文原文）
$t('共 {{count}} 个节点', { count: nodes.length })
```

- key 一律使用**中文原文逐字**（含 `{{占位符}}`），英文 value 由各 locale 文件提供。
- 英文词表未命中时原样回退中文，不会报错；新增文案时**必须同时补英文词条**才算完成。
- 语言在加载时确定（非响应式）：渲染期调用的 `$` 在刷新后生效；模块级常量里的 `$` 同样需要刷新页面。若后续需要“不刷新即时切换”，需把相关常量改为渲染期函数/订阅语言事件。

## 4. 新增翻译流程

1. 在源码里把中文包成 `$()` / `$t()`；
2. 先查 `src/canvas/i18n/index.ts` 的 `builtinEnTranslations` 是否已有该 key（有则复用）；
3. 没有则在对应批次文件（`locales/<batch>.ts`）补 `: 'English'`，占位符与 key 保持一致；
4. 不要修改 `i18n/index.ts` 的合并结构；新增批次才在 `index.ts` 注册 import + spread。

## 5. 不译清单（强制）

注释；console/日志；LLM / system prompt 正文与 prompt 模板；接口字段名；业务枚举提交值（展示 label 可译）；用户数据与持久化数据值；mock 数据内部字段；用于语义判断/匹配的字符串（如 `includes('已存在连接')`、`startsWith('镜头')` 类逻辑，须保持语言无关）。

## 6. 当前覆盖状态（2026-11-10）

| 批次 | 词表 | 新增词条（约） | 覆盖文件 |
|---|---|---|---|
| A appShell | appShell.ts | 314 | App.tsx、auth、FloatingNav/HomePage/Recharge/账户/资产小面板、tour 等 23 文件 |
| B projects | projects.ts | 1138 | projects/** 14 文件（含 ProjectChapterWorkbenchPage） |
| C canvasCore | canvasCore.ts | 335 | canvas/**（不含 nodes）26 文件 |
| D nodes | nodes.ts | 606 | canvas/nodes/** 36 文件（TaskNode/LensShotNode 等） |
| E1 uiPanels1 | uiPanels1.ts | 499 | 核心 UI 面板 16 文件 |
| E2 uiPanels2 | uiPanels2.ts | 564 | chat/nanoComic/Agent 面板 23 文件 |
| F stats | stats.ts | 720 | ui/stats/** + StatsUserManagement 27 文件 |
| G misc | misc.ts | 208 | runner/api/ai/inspector/storyboard/flows/config 19 文件 |

合计约 **4,300+ 条英文词条 / 6,000+ 处调用点**，覆盖画布主要可见 UI；`tsc --noEmit` 无新增错误、`vite build` 通过。
剩余中文仅为约定不译项：prompt 正文、日志、业务枚举/数据值、注释，以及少量长尾内部文案。

## 7. 验证方式

```bash
cd tapcanvas/apps/web
./node_modules/.bin/tsc --noEmit -p tsconfig.json   # 基线 55 个历史错误，不应新增
ALLOW_LOCALHOST_IN_PROD_BUILD=1 ./node_modules/.bin/vite build --mode production
```

构建产物同步到 lens 后端（在 lens 仓库根执行）：`bash ./dev-canvas.sh`（或手动 `cp -R dist/. zsapps-admin/src/main/resources/templates/canvas/` 后 `mvn -pl zsapps-admin compile`），然后强刷 `/canvas/`。

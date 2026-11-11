# Canvas 国际化（English）

画布已支持中/英文双语。完整使用说明、语言优先级、词表结构与覆盖状态见 [I18N_USAGE.md](./I18N_USAGE.md)。

快速上手：

```tsx
import { $, $t } from '@/canvas/i18n' // 实际使用相对路径

<button>{$('保存')}</button>                    // 中文环境: 保存 / 英文: Save
<p>{$t('共 {{count}} 个节点', { count: 5 })}</p>
```

- 语言来源：`?lang=`（lens 打开画布时传入）> `lens_locale`（主应用偏好）> `tapcanvas-language`（画布自身）> 浏览器语言。
- 新增文案先查 `src/canvas/i18n/index.ts` 内置词表，没有则加到 `src/canvas/i18n/locales/<batch>.ts`。
- 未翻译 key 自动回退中文；不译 prompt 正文、日志、业务枚举值等（详见 I18N_USAGE.md）。

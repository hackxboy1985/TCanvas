/**
 * lens 画布内置 AI 能力（前端「能力」菜单）。
 *
 * <p>能力清单由 lens 后端 `GET /api/canvas/agent/skills` 提供（12 个 tapcanvas skills 拷贝，
 * 见 zsapps-admin/src/main/resources/canvas-agent/skills/）；前端只展示 name/description，
 * 对话请求只传 key，服务端按白名单读取正文注入 systemPrompt。</p>
 */
export type LensAgentSkill = {
  /** 能力 key（tapcanvas-* skill 目录名） */
  key: string
  /** 中文展示名 */
  name: string
  /** 能力说明 */
  description: string
}

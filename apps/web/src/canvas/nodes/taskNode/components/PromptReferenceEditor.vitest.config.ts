import { defineConfig } from 'vitest/config'
/** 专用组件测试，不加载应用入口或生产配置。 */
export default defineConfig({ test: { environment: 'jsdom', globals: true, include: ['src/canvas/nodes/taskNode/components/PromptReferenceEditor.test.tsx'] } })

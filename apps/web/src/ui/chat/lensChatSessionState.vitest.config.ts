import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['src/ui/chat/lensChatSessionState.test.ts'], pool: 'forks', poolOptions: { forks: { singleFork: true } } } })

import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'jsdom', include: ['src/ui/chat/ChatMentionComposer.test.tsx'], pool: 'forks', poolOptions: { forks: { singleFork: true } } } })

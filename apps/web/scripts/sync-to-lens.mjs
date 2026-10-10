/**
 * 画布构建产物同步到 lens 后端的资源目录
 *
 * 用法：node ./scripts/sync-to-lens.mjs（或直接跑 pnpm build:lens，会先构建再同步）
 *
 * 把 apps/web/dist 复制到 zsapps-admin/src/main/resources/templates/canvas/，
 * 由 Spring Boot 以 /canvas/ 路径托管（与 lens 前端 templates/ndist、tdist 同模式）。
 *
 * ⚠️ 同步后必须重新编译后端（mvn compile / 重启）才会生效：
 *   src/main/resources 是 Maven 的资源输入目录，运行时的 classpath 指向的是
 *   target/classes，由 Maven 在编译阶段从 src 复制过去。
 *   只跑本脚本不重编后端时，页面仍会加载 target/classes 里的旧产物
 *   （表现为「前端明明改了却没生效」）。
 */
import { cpSync, rmSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
// apps/web/dist → lens/zsapps-admin/src/main/resources/templates/canvas（相对 4 层）
const src = resolve(scriptDir, '../dist')
const dest = resolve(scriptDir, '../../../../zsapps-admin/src/main/resources/templates/canvas')

if (!existsSync(src)) {
  console.error('[sync-to-lens] dist 目录不存在，请先执行 vite build')
  process.exit(1)
}

rmSync(dest, { recursive: true, force: true })
cpSync(src, dest, { recursive: true })
console.log(`[sync-to-lens] 画布产物已同步到 templates/canvas/（${dest}）`)
console.log('[sync-to-lens] 提示：需重新编译后端（mvn compile）后 /canvas/ 才会加载到新产物')

/**
 * 画布构建产物同步到 lens 后端静态目录
 *
 * 用法：node ./scripts/sync-to-lens.mjs
 * 把 apps/web/dist 复制到 zsapps-admin/src/main/resources/templates/canvas/，
 * 打包后 Spring Boot 以 /canvas/ 路径托管画布（与 lens 前端 templates/ndist 同模式）。
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

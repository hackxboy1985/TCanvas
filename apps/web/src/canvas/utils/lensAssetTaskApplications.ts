import { getImageModels, getImage2ImageModels, type LensModelOption } from '../../api/lens'

/**
 * 应用列表缓存有效期（毫秒）。
 *
 * <p>该列表来自模型管理配置，一次会话内极少变化；任务面板/抽屉每打开一次、
 * 甚至每 5 秒轮询都会用到它，不缓存会导致同一份数据被反复拉取。
 */
const LENS_AST_ASSET_APPLICATIONS_TTL_MS = 5 * 60 * 1000

/** 已完成的会话级缓存（列表 + 过期时刻） */
let cachedApplications: { models: LensModelOption[]; expiresAt: number } | null = null

/** 进行中的请求：同 key 并发调用共享同一个 Promise，避免一屏多个节点同时挂载时打 N 次接口 */
let inflightApplications: Promise<LensModelOption[]> | null = null

/** 与资产编辑页同源：合并已启用的文生图、图生图应用并去重，不写死应用ID。 */
export async function loadLensAssetTaskApplicationIds(): Promise<string[]> {
  const models = await loadLensAssetTaskApplications()
  const ids = models.filter((model) => model.enabled === true).map((model) => String(model.value))
  if (!ids.length) throw new Error('当前未配置可用生图应用，无法筛选资产任务')
  return ids
}

/**
 * 加载查询筛选与展示所需的应用列表（合并文生图 + 图生图并去重）。
 *
 * <p>**会话级缓存**：结果缓存 {@link LENS_AST_ASSET_APPLICATIONS_TTL_MS}，
 * 期间再次调用直接复用，不再请求接口；并发调用共享同一个在途请求。
 * 任务面板会按 5 秒轮询，组件也会反复挂载，不缓存会持续重复拉取同一份配置。
 *
 * <p>失败不写缓存（异常直接抛给调用方），保证下次调用能真实重试。
 *
 * @param forceRefresh 是否跳过缓存强制重新拉取（模型管理改配置后需要即时生效时用）
 * @returns 应用列表（停用项保留，便于历史任务显示名称而不是内部模型）
 */
export async function loadLensAssetTaskApplications(forceRefresh = false): Promise<LensModelOption[]> {
  if (!forceRefresh && cachedApplications && cachedApplications.expiresAt > Date.now()) {
    return cachedApplications.models
  }
  if (inflightApplications) return inflightApplications

  const request = (async (): Promise<LensModelOption[]> => {
    const groups = await Promise.all([getImageModels(), getImage2ImageModels()])
    const models = [...new Map(groups.flat().map((model) => [String(model.value), model])).values()]
    // 成功才写缓存，失败保持空缓存以便重试
    cachedApplications = { models, expiresAt: Date.now() + LENS_AST_ASSET_APPLICATIONS_TTL_MS }
    return models
  })()

  inflightApplications = request
  try {
    return await request
  } finally {
    // 无论成功失败都移除在途登记，避免失败后后续调用永远复用同一个 reject 的 Promise
    inflightApplications = null
  }
}

/**
 * 作废应用列表缓存（模型管理/应用启停配置变更后调用，保证下次读到最新配置）。
 */
export function invalidateLensAssetTaskApplicationsCache(): void {
  cachedApplications = null
}

/** 仅按原始应用ID解析显示名，不拿内部模型名冒充应用名。 */
export function resolveLensTaskApplicationName(originAppId: string | number | undefined, models: readonly LensModelOption[]): string {
  const id = originAppId === undefined ? '' : String(originAppId).trim()
  if (!id) return '应用ID缺失'
  const name = models.find((model) => String(model.value) === id)?.label?.trim()
  return name || '未匹配应用（' + id + '）'
}

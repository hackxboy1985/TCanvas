import { getImageModels, getImage2ImageModels } from '../../api/lens'

/** 与资产编辑页同源：合并已启用的文生图、图生图应用并去重，不写死应用ID。 */
export async function loadLensAssetTaskApplicationIds(): Promise<string[]> {
  const groups = await Promise.all([getImageModels(), getImage2ImageModels()])
  const ids = [...new Set(groups.flat().filter((model) => model.enabled === true).map((model) => String(model.value)))]
  if (!ids.length) throw new Error('当前未配置可用生图应用，无法筛选资产任务')
  return ids
}

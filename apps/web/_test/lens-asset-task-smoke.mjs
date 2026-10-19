import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'

// 在真实 9096 页面加载产物，所有业务请求用测试夹具拦截，禁止读写真实画布或触发生图。
const origin = 'http://127.0.0.1:9096'
const assets = [
  { assetCategory: 1, assetId: '3913', roleId: '3913', characterName: '测试角色' },
  { assetCategory: 1, assetId: '3914', roleId: '3914', characterName: '测试子造型', parentId: '3913', cloneName: '冬装' },
  { assetCategory: 2, assetId: '501', imgName: '测试场景' },
  { assetCategory: 2, assetId: '502', imgName: '测试子场景', parentId: '501', variantName: '夜晚' },
  { assetCategory: 3, assetId: '601', imgName: '测试道具' },
]
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } })
  const calls = []
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/public/')) return route.continue()
    let data = []
    if (url.pathname === '/api/episode/getAllEpisode') data = [1]
    else if (url.pathname === '/api/storyboard/assetsByEpisode') data = assets
    else if (url.pathname === '/api/episode/novelContent') data = ''
    else if (url.pathname === '/api/episode/scriptContent') data = { scriptContent: '' }
    else if (url.pathname.endsWith('/flow')) data = { id: '900', version: 0 }
    else if (url.pathname === '/api/getInfo') data = { roles: [], permissions: [] }
    else if (url.pathname === '/api/system/user/canViewParams') data = false
    else if (url.pathname === '/api/model/image' || url.pathname === '/api/model/image2image') data = [{ value: '47', label: '测试生图应用', enabled: true, enable: true }]
    else if (url.pathname === '/api/task/list') {
      const body = route.request().postDataJSON()
      calls.push(body)
      return route.fulfill({ json: { code: 200, rows: [{ id: '1', taskStatus: 'SUCCESS', prompt: '测试资产任务记录', originAppId: 47, createUserName: '测试提交用户', channel: '测试渠道', createTime: '2026-10-19 16:00:00', reqPar: JSON.stringify([{ ratio: '16:9', resolution: '2K', quality: 'high' }]), model: 'internal-model', moduleName: '内部模型名' }], total: 1 } })
    } else if (url.pathname === '/api/storyboardTask/list') throw new Error('资产入口错误调用了分镜任务接口')
    return route.fulfill({ json: { code: 200, data } })
  })
  const response = await page.goto(origin + '/canvas/?dramaId=720&episode=1', { waitUntil: 'domcontentloaded' })
  assert.equal(response.status(), 200)
  await page.getByRole('button', { name: '任务记录', exact: true }).first().waitFor({ timeout: 30000 })
  assert.equal(await page.getByRole('button', { name: '任务记录', exact: true }).count(), 5)
  for (const [nodeId, assetId, assetType] of [['role-3913', '3913', '0'], ['role-3914', '3914', '0'], ['scene-501', '501', '1'], ['scene-502', '502', '1'], ['prop-601', '601', '2']]) {
    const node = page.locator('.react-flow__node[data-id="' + nodeId + '"]')
    await node.getByRole('button', { name: '任务记录', exact: true }).click({ force: true })
    await page.getByText('测试资产任务记录', { exact: true }).waitFor()
    await page.locator('.lens-asset-task-panel__model').filter({ hasText: '测试生图应用' }).waitFor()
    const meta = page.locator('.lens-asset-task-panel__meta').first()
    assert.match(await meta.innerText(), /测试提交用户/)
    assert.match(await meta.innerText(), /测试渠道/)
    const details = page.locator('.lens-asset-task-panel__details').first()
    assert.match(await details.innerText(), /16:9.*分辨率 2K.*质量 high/)
    assert.equal(await details.evaluate((element) => getComputedStyle(element).whiteSpace), 'nowrap')
    const tops = await meta.locator(':scope > *').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2))
    assert.ok(Math.max(...tops) - Math.min(...tops) < 2, '第一行所有字段保持同一行')
    assert.equal(await page.getByText('internal-model', { exact: true }).count(), 0)
    assert.equal(await page.getByText('内部模型名', { exact: true }).count(), 0)
    assert.deepEqual(calls.at(-1), { dramaId: '720', assetId, assetType, pageNum: 1, pageSize: 20, keyword: '', taskStatus: '', taskStatusNot: 'FAILED', episodeNum: '', applicationIds: ['47'] })
    await page.getByRole('button', { name: '关闭任务列表', exact: true }).click()
  }
  const role = page.locator('.react-flow__node[data-id="role-3913"]')
  await role.locator('.task-node-header-compact-title').click({ force: true })
  await page.getByRole('button', { name: '任务结果', exact: true }).waitFor()
  await page.getByRole('button', { name: '任务结果', exact: true }).click()
  await page.getByText('测试资产任务记录', { exact: true }).waitFor()
  assert.equal(calls.at(-1).assetId, '3913')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', assetKinds: 5, entrypoints: 2, requests: calls.length, businessRequestsIntercepted: true, pageErrors: errors }, null, 2))
} finally {
  await browser.close()
}

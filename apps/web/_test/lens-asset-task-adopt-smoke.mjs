import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'

// 服务离线时仅通过浏览器路由加载已同步的静态产物，不启动或替换任何服务。
const offlineAssets = process.argv.includes('--offline-assets')
const staticRoot = resolve('../../../zsapps-admin/target/classes/templates/canvas')

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
  const adoptions = []
  let assetLoads = 0
  const image = 'https://example.test/original.png'
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === 'https://example.test') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#5865d9"/></svg>' })
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/public/')) {
      if (!offlineAssets) return route.continue()
      const relative = url.pathname.startsWith('/canvas/assets/') ? url.pathname.slice('/canvas/'.length) : 'index.html'
      const path = resolve(staticRoot, relative)
      assert.ok(path.startsWith(staticRoot + '/'))
      const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }
      return route.fulfill({ body: await readFile(path), contentType: types[extname(path)] || 'application/octet-stream' })
    }
    if (route.request().method() === 'PUT' && ['/api/lensRole', '/api/lensImage'].includes(url.pathname)) {
      assert.equal(url.searchParams.get('as'), 'lens')
      const body = route.request().postDataJSON()
      adoptions.push({ path: url.pathname, body })
      const asset = assets.find((item) => item.assetId === body.id)
      if (url.pathname === '/api/lensRole') asset.threeImg = body.threeImg
      else asset.imgUrl = body.url
      return route.fulfill({ json: { code: 200, msg: '已关联图片' } })
    }
    let data = []
    if (url.pathname === '/api/episode/getAllEpisode') data = [1]
    else if (url.pathname === '/api/storyboard/assetsByEpisode') { assetLoads += 1; data = assets }
    else if (url.pathname === '/api/episode/novelContent') data = ''
    else if (url.pathname === '/api/episode/scriptContent') data = { scriptContent: '' }
    else if (url.pathname.endsWith('/flow')) data = { id: '900', version: 0 }
    else if (url.pathname === '/api/getInfo') data = { roles: [], permissions: [] }
    else if (url.pathname === '/api/system/user/canViewParams') data = true
    else if (url.pathname === '/api/model/image' || url.pathname === '/api/model/image2image') data = [{ value: '47', label: '测试生图应用', enabled: true, enable: true }]
    else if (url.pathname === '/api/task/list') {
      const body = route.request().postDataJSON()
      calls.push(body)
      return route.fulfill({ json: { code: 200, rows: [{ id: '1', taskStatus: 'SUCCESS', prompt: '测试资产任务记录', moduleName: '测试模型', fileUrl: image, reqPar: '{}'  }], total: 1 } })
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
    assert.deepEqual(calls.at(-1), { dramaId: '720', assetId, assetType, pageNum: 1, pageSize: 20, keyword: '', taskStatus: '', taskStatusNot: 'FAILED', episodeNum: '', applicationIds: ['47'] })
    assert.equal(await page.locator('.mantine-Drawer-overlay').count(), 0)
    const panel = page.getByRole('complementary', { name: '资产任务列表' })
    assert.equal(await panel.count(), 1)
    assert.equal(await panel.locator('.lens-asset-task-panel__actions').innerText(), ['采纳结果', '复制提示词', '查看参数'].join(String.fromCharCode(10)))
    await panel.getByRole('button', { name: '采纳结果', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '采纳结果', exact: true })
    await dialog.waitFor()
    assert.equal(await dialog.getByRole('img', { name: '待采纳图片' }).getAttribute('src'), image)
    await dialog.getByRole('button', { name: '确认采纳' }).click()
    await dialog.waitFor({ state: 'hidden' })
    const last = adoptions.at(-1)
    assert.equal(last.path, assetType === '0' ? '/api/lensRole' : '/api/lensImage')
    assert.deepEqual(last.body, assetType === '0'
      ? { id: assetId, dramaId: '720', threeImg: image, modifySource: 'task_associate' }
      : { id: assetId, joinId: '720', url: image, modifySource: 'task_associate' })
    // 验证采纳后当前节点立即展示原图，且没有重新请求整集资产。
    await node.locator('img').filter({ visible: true }).first().waitFor()
    await page.waitForFunction(({ nodeId, image }) => {
      const node = document.querySelector('.react-flow__node[data-id="' + nodeId + '"]')
      return node && [...node.querySelectorAll('img')].some((img) => img.src.startsWith(image))
    }, { nodeId, image })
    assert.equal(assetLoads, 1)
    await page.screenshot({ path: '/tmp/lens-asset-adopt-' + assetId + '.png' })
    await page.getByRole('button', { name: '关闭任务列表' }).click()
    assert.equal(await panel.count(), 0)
  }
  assert.equal(adoptions.length, 5)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', mode: offlineAssets ? 'offline' : 'live-9096', assets: 5, adoptions, businessRequestsIntercepted: true, pageErrors: errors }, null, 2))
} finally {
  await browser.close()
}

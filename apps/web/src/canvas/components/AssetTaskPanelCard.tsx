import React from 'react'
import { Badge, Button, Group, Modal, Text } from '@mantine/core'
import { LensAssetTaskStatus, type LensTaskRecord, type LensAssetTaskAdoptionTarget } from '../../api/lens'
import { useUIStore } from '../../ui/uiStore'
import { toast } from '../../ui/toast'
import { IconCopy, IconEye } from '@tabler/icons-react'
import { AssetTaskAdoptButton } from './AssetTaskAdoptButton'
import { toOssResponsiveUrl } from '../utils/ossResponsive'

/** 参考图缩略图显示宽度（px），与 CSS .lens-asset-task-panel__reference 的 36px 一致 */
const REFERENCE_THUMB_DISPLAY_WIDTH = 36
/** 结果图缩略图显示宽度（px）：任务面板结果区为两列网格，单格上限约 164px */
const RESULT_THUMB_DISPLAY_WIDTH = 164

const STATUS_LABELS: Record<string, string> = {
  [LensAssetTaskStatus.Created]: '创建', CREATED: '创建', [LensAssetTaskStatus.Queued]: '排队',
  [LensAssetTaskStatus.Running]: '生成中', SYNCING: '同步中', [LensAssetTaskStatus.Success]: '成功',
  [LensAssetTaskStatus.Failed]: '失败', ERROR: '失败', SYNC_FAILED: '同步失败', CANCEL: '已取消',
}
type Media = { url: string; type: 'image' | 'video'; thumbnail?: string }

/** 解析后端的 JSON 字段；不完整的结构显式反馈，避免整张任务卡片崩溃。 */
function parseJson(raw: string | undefined): unknown {
  return raw?.trim() ? JSON.parse(raw) : null
}
/**
 * 把任务参数格式化成缩进良好的 JSON 文本，便于人工读参数。
 *
 * <p>{@code reqPar} 是后端 {@code components} 的 JSON 字符串，紧凑格式一行到底无法阅读。
 * 解析失败时原样返回 —— 参数面板只做展示，不能让一条脏数据导致弹窗空白或组件崩溃。
 *
 * @param raw 原始参数字符串，可为空
 * @returns 缩进 2 空格的 JSON 文本；无法解析时返回原文；为空时返回空串
 */
function prettyJson(raw: string | undefined): string {
  const text = raw?.trim() ? raw : ''
  if (!text) return ''
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    // 非 JSON（如纯文本参数）原样展示，不制造假的结构
    return text
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
/** 只允许媒体地址协议，禁止任务记录中的地址作为脚本链接执行。 */
function safeMediaUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const url = new URL(value.trim(), window.location.origin)
    return ['http:', 'https:', 'blob:'].includes(url.protocol) || value.startsWith('data:image/') ? url.href : ''
  } catch {
    // 非法地址不能导致整个任务列表无法关闭或阻断其他任务展示。
    return ''
  }
}

/** 资产任务卡片复用原接口关联结果，不改变原固定抽屉或视频采纳链路。 */
/**
 * 资产任务卡片复用原接口关联结果，不改变原固定抽屉或视频采纳链路。
 *
 * @param derivedLabel 衍生节点任务的来源标签（角度修改/打光调整/自定义编辑）；为空表示原资产任务
 */
export function AssetTaskPanelCard({ record, canViewParams, target, applicationName, derivedLabel }: {
  record: LensTaskRecord; applicationName: string; canViewParams: boolean; target?: LensAssetTaskAdoptionTarget; derivedLabel?: string
}) {
  const [paramsOpened, setParamsOpened] = React.useState(false)
  const status = record.taskStatus || record.status || ''
  const rawParams = record.reqPar ?? record.taskParams
  const details = React.useMemo(() => {
    const media: Media[] = []
    const references: string[] = []
    let ratio = ''
    const parameters: string[] = []
    const errors: string[] = []
    try {
      const results = parseJson(record.results)
      if (Array.isArray(results)) for (const result of results) {
        const url = safeMediaUrl(isRecord(result) ? result.url : result)
        if (url) media.push({ url, type: isRecord(result) && result.type === 'video' ? 'video' : 'image',
          thumbnail: isRecord(result) ? safeMediaUrl(result.thumbnail) : undefined })
      }
    } catch { errors.push('结果数据格式异常') }
    if (!media.length) for (const value of record.fileUrl?.split(',') || []) {
      const url = safeMediaUrl(value)
      if (url) media.push({ url, type: 'image' })
    }
    try {
      const params = parseJson(rawParams)
      const component: unknown = Array.isArray(params) ? params[0] : params
      if (isRecord(component)) {
        ratio = typeof component.ratio === 'string' ? component.ratio : typeof component.aspectRatio === 'string' ? component.aspectRatio : ''
        // 只展示接口中实际存在的生成参数，不补默认值。
        for (const [key, label] of [['resolution', '分辨率'], ['quality', '质量'], ['width', '宽'], ['height', '高']] as const) {
          const value = component[key]
          if ((typeof value === 'string' && value.trim()) || typeof value === 'number') parameters.push(label + ' ' + value)
        }
        const refs: unknown = component.images ?? component.refImages ?? record.referenceImages
        const parsed: unknown = typeof refs === 'string' ? JSON.parse(refs) : refs
        if (Array.isArray(parsed)) for (const reference of parsed) {
          const url = safeMediaUrl(isRecord(reference) ? reference.url : reference)
          if (url) references.push(url)
        }
      }
    } catch { errors.push('任务参数格式异常') }
    return { media, references, ratio, parameters, errors }
  }, [record.results, record.fileUrl, record.referenceImages, rawParams])
  const failed = [LensAssetTaskStatus.Failed, 'ERROR', 'SYNC_FAILED'].includes(status)
  const pending = ['CREATE', 'CREATED', 'QUEUED', 'RUNNING', 'SYNCING'].includes(status)
  const copyPrompt = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(record.prompt || ''); toast('提示词已复制', 'success') }
    catch { toast('复制失败，请手动选择文本复制', 'error') }
  }
  const submitter = record.createUserName || record.submitter || record.userName
  const detailText = [record.createTime, record.id ? '#' + record.id : '', details.ratio, ...details.parameters].filter(Boolean).join(' · ')
  return (
    <article className="lens-asset-task-panel__card">
      <Group className="lens-asset-task-panel__meta" gap={6} wrap="nowrap">
        {/* 衍生节点任务：标明来自该节点的哪类图片编辑，便于和原资产任务区分 */}
        {derivedLabel && <span className="lens-task-derived-tag">{derivedLabel}</span>}
        <Text className="lens-asset-task-panel__model" size="xs" fw={600} title={applicationName}>{applicationName}</Text>
        <Badge className="lens-asset-task-panel__badge" size="xs" variant="light" color={failed ? 'red' : status === LensAssetTaskStatus.Success ? 'green' : 'blue'}>{STATUS_LABELS[status] || status || '未知状态'}</Badge>
        {submitter && <Text className="lens-asset-task-panel__submitter" size="xs" title={submitter}>{submitter}</Text>}
        {record.channel && <Text className="lens-asset-task-panel__channel" size="xs" title={record.channel}>{record.channel}</Text>}
      </Group>
      <Text className="lens-asset-task-panel__details" size="xs" title={detailText}>{detailText}</Text>
      {/* 参考图：点击打开站内大图预览，与结果图一致（原先只是裸缩略图，点不开） */}
      {!!details.references.length && <div className="lens-asset-task-panel__references">{details.references.map((url, index) => (
        <button className="lens-asset-task-panel__reference-btn" type="button" key={url + index}
          aria-label={'预览参考图 ' + (index + 1)}
          onClick={() => useUIStore.getState().openPreview({ url, kind: 'image', name: '参考图 ' + (index + 1) })}>
          {/* 列表用小图走 OSS 缩略图，避免直接拉 2k 原图；点开预览仍用原图 */}
          <img className="lens-asset-task-panel__reference" src={toOssResponsiveUrl(url, REFERENCE_THUMB_DISPLAY_WIDTH)} alt={'参考图 ' + (index + 1)} loading="lazy" />
        </button>
      ))}</div>}
      {!!record.prompt && <Text className="lens-asset-task-panel__prompt" size="xs" title={record.prompt}>{record.prompt}</Text>}
      <div className="lens-asset-task-panel__results">{details.media.map((media, index) => <button className="lens-asset-task-panel__preview" type="button" key={media.url + index}
        aria-label={'预览结果 ' + (index + 1)} onClick={() => useUIStore.getState().openPreview({ url: media.url, kind: media.type, name: applicationName })}>
        {media.type === 'image' ? <img className="lens-asset-task-panel__image" src={media.thumbnail || toOssResponsiveUrl(media.url, RESULT_THUMB_DISPLAY_WIDTH)} alt={'生成结果 ' + (index + 1)} loading="lazy" /> : <video className="lens-asset-task-panel__image" src={media.url} preload="metadata" />}
      </button>)}</div>
      {!details.media.length && <Text className="lens-asset-task-panel__result-status" size="xs" c={failed ? 'red' : undefined}>{record.resMsg || record.errorMsg || (pending ? '生成中，请稍候…' : '暂无结果')}</Text>}
      {details.errors.map((error) => <Text className="lens-asset-task-panel__error" key={error} size="xs" c="red">{error}</Text>)}
      <Group className="lens-asset-task-panel__actions" gap={6}>
        {target && <AssetTaskAdoptButton target={target} images={details.media.filter((media) => media.type === 'image' && /^https?:/.test(media.url)).map((media) => media.url)} />}
        {!!record.prompt && <Button className="lens-asset-task-panel__copy" size="compact-xs" variant="outline" color="gray" leftSection={<IconCopy className="lens-asset-task-panel__copy-icon" size={13} />} onClick={() => { void copyPrompt() }}>复制提示词</Button>}
        {canViewParams && rawParams && <Button className="lens-asset-task-panel__params" size="compact-xs" variant="light" color="gray" leftSection={<IconEye className="lens-asset-task-panel__params-icon" size={13} />} onClick={() => setParamsOpened(true)}>查看参数</Button>}
      </Group>
      <Modal className="lens-asset-task-panel__params-modal" opened={paramsOpened} onClose={() => setParamsOpened(false)} title="任务参数" centered>
        <Text className="lens-asset-task-panel__params-content" component="pre" size="xs">{prettyJson(rawParams)}</Text>
      </Modal>
    </article>
  )
}

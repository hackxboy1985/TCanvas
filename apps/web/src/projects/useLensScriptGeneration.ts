/**
 * Lens 画布「生台本 / 拆分镜」生成逻辑。
 *
 * <p>与 Lens 分镜板（RuoYi-Vue3 的 creation 页面）保持同一套接口与监测口径：</p>
 * <ul>
 *   <li>生台本：POST /api/episode/submitScriptGen → 轮询 GET /api/episode/scriptStatus（5 秒/次），
 *       直到 hasScript=true（成功）或任务结束仍无台本（失败）。不传 splitType，
 *       因此不会像分镜板「台本+拆分镜」场景那样自动触发拆分镜。</li>
 *   <li>拆分镜：POST /api/storyboard/splitShotTask（saveMode=auto，后端拆分完成直接写 lens 分镜表）
 *       → 轮询 GET /api/storyboard/getEpisodeTaskStatus（5 秒/次），
 *       直到 status=SUCCESS（成功）或 FAILED（失败）。</li>
 * </ul>
 *
 * <p>两者成功后都回调 {@link UseLensScriptGenerationOptions.onRefresh}，
 * 由 LensCanvasApp 重新拉取 lens 业务数据并重建画布投影节点（台本节点内容、分镜节点）。</p>
 *
 * <p>另外负责剧本/台本正文保存：画布 flow 不保存正文，编辑后必须回写 lens 业务表
 * （剧本 → novel_episode.content，台本 → novel_episode.script_content）。</p>
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getEpisodeTaskStatus,
  getScriptContent,
  getScriptStatus,
  listStoryboards,
  saveNovelContent,
  saveScriptContent,
  submitScriptGen,
  submitSplitShotTask,
  type LensEpisodeTaskStatus,
} from '../api/lens'
import { confirmCanvasAction, confirmCanvasActionWithChoice } from '../canvas/components/CanvasConfirmDialog'
import type { LensScriptGenerationActions, LensScriptTextKind } from '../canvas/CanvasRenderContext'
import { useUIStore } from '../ui/uiStore'
import { toast } from '../ui/toast'

import { $, $t } from '../canvas/i18n'
/** 轮询间隔（毫秒）：与分镜板 scene.vue / EpisodeContent.vue 的 5000ms 一致 */
const POLL_INTERVAL_MS = 5000
/** 单次任务最多轮询次数：120 次 ≈ 10 分钟，与 EpisodeContent._pollScriptGenResult 一致 */
const MAX_POLL_ATTEMPTS = 120
/** 拆分镜兜底时长（秒）：剧配置未给出 maxVideoDuration 时与分镜板/后端默认值一致 */
const DEFAULT_SPLIT_VALUE_SECONDS = 15
/** 后端「该集没有任务」的业务错误文案片段：属正常态，不是失败 */
const NO_TASK_ERROR_MARK = '未找到该集'

export interface UseLensScriptGenerationOptions {
  dramaId: string
  episodeNum: number
  /** 任务成功后的画布刷新（重新投影台本/分镜节点） */
  onRefresh: () => Promise<void>
  /** 当前集投影是否已加载完成：加载后再恢复未完成任务监控，避免重复请求 */
  ready: boolean
}

/** 等待指定毫秒（轮询间隔用） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * 从接口错误里提取可读原因。
 *
 * <p>lensFetch 的错误形如「lens 接口失败：HTTP 500 code=500 msg=xxx url=...」，
 * 直接展示整串对用户没有意义，这里截取 msg 段。</p>
 */
function errorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || '')
  const matched = /msg=([^]*?)(?:\s+url=|$)/.exec(raw)
  const message = matched?.[1]?.trim()
  return message || raw || fallback
}

/** 是否为「该集没有任务」的正常态错误 */
function isNoTaskError(error: unknown): boolean {
  return errorMessage(error, '').includes(NO_TASK_ERROR_MARK)
}

/**
 * 画布「生台本 / 拆分镜」hook。
 *
 * <p>职责：任务提交、结果轮询、覆盖确认、失败提示、页面刷新后的任务恢复监控；
 * 业务数据落库全部由 lens 后端完成（与分镜板一致），画布只做触发与刷新。</p>
 */
export function useLensScriptGeneration(options: UseLensScriptGenerationOptions): LensScriptGenerationActions {
  const { dramaId, episodeNum, onRefresh, ready } = options
  const [scriptRunning, setScriptRunning] = useState(false)
  const [splitRunning, setSplitRunning] = useState(false)
  const [saveRunning, setSaveRunning] = useState(false)
  const [scriptGenEnabled, setScriptGenEnabled] = useState<boolean | null>(null)
  const [hasScript, setHasScript] = useState(false)
  /** 轮询令牌：切集/卸载/新任务提交时递增，旧轮询循环读到不一致即退出 */
  const pollTokenRef = useRef(0)
  /** 已恢复过任务监控的集标识，避免同一集重复恢复 */
  const resumedKeyRef = useRef('')
  /**
   * 同步动作锁：按钮 loading 状态要等下一次渲染才生效，连续点击的间隔内会被判成
   * 「未在运行」而重复提交（台本/拆分镜都会扣积分）。这里用 ref 同步加锁，保证一次只提交一个任务。
   */
  const actionBusyRef = useRef(false)

  /** 任务成功后的画布刷新 + 成功提示；刷新失败也要如实告知，不能假装成功 */
  const refreshAfterDone = useCallback(async (successText: string): Promise<void> => {
    try {
      await onRefresh()
      toast(successText, 'success')
    } catch (error) {
      toast($t('任务已完成，但画布刷新失败：{{value}}', { value: errorMessage(error, $('未知错误')) }), 'error')
    }
  }, [onRefresh])

  /**
   * 轮询台本生成结果（与分镜板一致：以 scriptStatus.hasScript 判定完成）。
   *
   * @param token 轮询令牌，令牌失效（切集/新任务）时立即停止
   */
  const pollScriptGen = useCallback(async (token: number): Promise<void> => {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      await delay(POLL_INTERVAL_MS)
      if (pollTokenRef.current !== token) return
      const status = await getScriptStatus(dramaId, episodeNum)
      if (pollTokenRef.current !== token) return
      setScriptGenEnabled(status.enableScriptGen)
      setHasScript(status.hasScript)
      if (status.hasScript) {
        await refreshAfterDone($('台本生成完成，画布已刷新'))
        return
      }
      if (!status.hasRunningTask) {
        throw new Error($('任务已结束但未生成台本，请到分镜板查看任务详情'))
      }
    }
    throw new Error($('轮询超时（超过 10 分钟），请稍后到分镜板查看结果'))
  }, [dramaId, episodeNum, refreshAfterDone])

  /**
   * 轮询拆分镜结果（与分镜板一致：以 getEpisodeTaskStatus 的 status 判定）。
   *
   * <p>saveMode=auto 时后端拆分完成会自动 commitShot 写库；若返回 PENDING + shots，
   * 说明分镜尚未入库，必须显式报错让用户去分镜板确认，不能当作成功刷新画布。</p>
   *
   * @param token 轮询令牌，令牌失效（切集/新任务）时立即停止
   */
  const pollSplitShots = useCallback(async (token: number): Promise<void> => {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      await delay(POLL_INTERVAL_MS)
      if (pollTokenRef.current !== token) return
      const task = await getEpisodeTaskStatus(dramaId, episodeNum)
      if (pollTokenRef.current !== token) return
      if (task.status === 'SUCCESS') {
        // 该集最新任务是台本任务（可能刚完成）而不是拆分镜：继续等待拆分镜任务落库
        if (task.taskCategory === 'scriptGen') continue
        const pendingShots = task.confirmStatus === 'PENDING' && Array.isArray(task.shots) && task.shots.length > 0
        if (pendingShots) {
          throw new Error($('拆分镜完成但分镜未写入业务表（任务待确认），请到分镜板预览确认'))
        }
        await refreshAfterDone($('拆分镜完成，画布已刷新'))
        return
      }
      if (task.status === 'FAILED') {
        throw new Error(task.message || $('拆分镜任务失败，后端未返回原因'))
      }
      // QUEUED / RUNNING：继续轮询
    }
    throw new Error($('轮询超时（超过 10 分钟），请稍后到分镜板查看结果'))
  }, [dramaId, episodeNum, refreshAfterDone])

  /** 生台本：提交任务并轮询到台本生成完成 */
  const generateScript = useCallback((): void => {
    if (scriptRunning || splitRunning || actionBusyRef.current) return
    actionBusyRef.current = true
    const token = pollTokenRef.current + 1
    pollTokenRef.current = token
    void (async () => {
      try {
        const status = await getScriptStatus(dramaId, episodeNum)
        if (pollTokenRef.current !== token) return
        setScriptGenEnabled(status.enableScriptGen)
        setHasScript(status.hasScript)
        if (!status.enableScriptGen) {
          toast($('当前剧未开启台本功能，请先在剧配置里开启「台本功能」'), 'warning')
          return
        }
        if (status.hasRunningTask) {
          toast($('本集台本任务正在执行中，请等待完成后再操作'), 'warning')
          return
        }
        // 先校验剧本原文再谈覆盖：原文为空时没有任何可生成的内容，不该先弹「覆盖台本」确认
        const script = await getScriptContent(dramaId, episodeNum)
        if (pollTokenRef.current !== token) return
        const content = String(script.content || '').trim()
        if (!content) {
          toast($('本集剧本原文为空，无法生成台本'), 'warning')
          return
        }
        if (status.hasScript) {
          const confirmed = await confirmCanvasAction({
            title: $('覆盖台本'),
            message: $('本集已有台本，重新生成会覆盖现有台本内容（不影响已生成分镜）。是否继续？'),
            confirmText: $('覆盖生成'),
            danger: true,
          })
          if (!confirmed) return
          if (pollTokenRef.current !== token) return
        }
        setScriptRunning(true)
        const result = await submitScriptGen({ dramaId, episodeNum, content })
        if (!result?.taskQueueId) throw new Error($('后端未返回 taskQueueId'))
        toast($('台本生成任务已提交，完成后会自动刷新画布'))
        await pollScriptGen(token)
      } catch (error) {
        if (pollTokenRef.current !== token) return
        toast($t('生台本失败：{{value}}', { value: errorMessage(error, $('未知错误')) }), 'error')
      } finally {
        actionBusyRef.current = false
        if (pollTokenRef.current === token) setScriptRunning(false)
      }
    })()
  }, [dramaId, episodeNum, pollScriptGen, scriptRunning, splitRunning])

  /** 拆分镜：提交任务并轮询到分镜写入 lens 业务表 */
  const splitShots = useCallback((): void => {
    if (scriptRunning || splitRunning || actionBusyRef.current) return
    actionBusyRef.current = true
    const token = pollTokenRef.current + 1
    pollTokenRef.current = token
    void (async () => {
      try {
        // 覆盖确认必须以 lens 业务表为准：画布节点可能被用户删过，count(nodes) 会漏报，
        // 而 commitShotByEpisode 是「整集全量替换」，漏报就会在无提示下覆盖已选图分镜。
        // 同时先校验本集正文（后端取数口径：台本优先、否则剧本原文）：正文为空时直接提示，
        // 不应先弹「覆盖分镜」确认（空台本点拆分镜却被问是否覆盖，会让人误以为有内容可拆）。
        const [script, storyboards] = await Promise.all([
          getScriptContent(dramaId, episodeNum),
          listStoryboards(dramaId, episodeNum),
        ])
        if (pollTokenRef.current !== token) return
        const scriptContent = String(script.scriptContent || '').trim()
        const novelContent = String(script.content || '').trim()
        if (!scriptContent && !novelContent) {
          toast($('本集剧本原文与台本均为空，无法拆分镜'), 'warning')
          return
        }
        // 台本与剧本原文都有内容时，必须先让用户选择用哪一份拆分，不能固定台本优先
        let source: 'script' | 'novel' = scriptContent ? 'script' : 'novel'
        if (scriptContent && novelContent) {
          const picked = await confirmCanvasActionWithChoice({
            title: $('选择拆分镜内容来源'),
            message: $('本集同时有台本和剧本原文，请选择用哪一份拆分镜。'),
            confirmText: $('下一步'),
            choices: {
              label: $('内容来源'),
              defaultValue: 'script',
              options: [
                { value: 'script', label: $('台本（默认）') },
                { value: 'novel', label: $('剧本原文') },
              ],
            },
          })
          if (!picked.confirmed) return
          source = picked.choice === 'novel' ? 'novel' : 'script'
          if (pollTokenRef.current !== token) return
        }
        const sourceLabel = source === 'script' ? $('台本') : $('剧本原文')
        if (storyboards.length > 0) {
          // 覆盖确认里提示实际来源，避免用户误以为拆的是另一份内容
          const confirmed = await confirmCanvasAction({
            title: $('覆盖分镜'),
            message: $t('本集已有 {{count}} 个分镜，拆分镜会重新生成并覆盖分镜表（同序号已选图会保留）。本次使用{{sourceLabel}}拆分。是否继续？', { count: storyboards.length, sourceLabel: sourceLabel }),
            confirmText: $('覆盖并拆分镜'),
            danger: true,
          })
          if (!confirmed) return
          if (pollTokenRef.current !== token) return
        }
        // 不再上传正文：后端按 source 从业务表取数，前端只传身份、来源与拆分参数
        // 每段时长取剧配置（与分镜板 maxVideoDuration 同源），未配置时用后端默认 15 秒
        const configuredDuration = Number(useUIStore.getState().lensProjectConfig?.maxVideoDuration)
        const splitValue = Number.isFinite(configuredDuration) && configuredDuration >= 1
          ? Math.trunc(configuredDuration)
          : DEFAULT_SPLIT_VALUE_SECONDS
        setSplitRunning(true)
        const result = await submitSplitShotTask({
          dramaId,
          episodeNum,
          splitType: 'BY_DURATION',
          splitValue,
          saveMode: 'auto',
          linkSubScene: true,
          source,
        })
        if (!result?.taskQueueId) throw new Error($('后端未返回 taskQueueId'))
        toast($t('拆分镜任务已提交（{{sourceLabel}}，每段 {{splitValue}} 秒，自动保存），完成后会自动刷新画布', { sourceLabel: sourceLabel, splitValue: splitValue }))
        await pollSplitShots(token)
      } catch (error) {
        if (pollTokenRef.current !== token) return
        toast($t('拆分镜失败：{{value}}', { value: errorMessage(error, $('未知错误')) }), 'error')
      } finally {
        actionBusyRef.current = false
        if (pollTokenRef.current === token) setSplitRunning(false)
      }
    })()
  }, [dramaId, episodeNum, pollSplitShots, scriptRunning, splitRunning])

  /**
   * 保存剧本/台本正文到 lens 业务表。
   *
   * <p>画布 flow 不保存正文：剧本节点编辑写 novel_episode.content，台本节点编辑写
   * novel_episode.script_content。保存成功后无需重投影（当前节点内容就是刚保存的内容），
   * 但要同步 hasScript，避免台本被清空后按钮文案/覆盖确认仍按「已有台本」判断。</p>
   *
   * @param kind    剧本=原文，台本=script_content
   * @param content 当前文本（纯文本）
   */
  const saveScriptText = useCallback((kind: LensScriptTextKind, content: string): void => {
    if (saveRunning || scriptRunning || splitRunning || actionBusyRef.current) return
    actionBusyRef.current = true
    setSaveRunning(true)
    void (async () => {
      try {
        const text = String(content == null ? '' : content)
        if (kind === '台本') {
          await saveScriptContent({ dramaId, episodeNum, scriptContent: text })
          setHasScript(text.trim().length > 0)
          toast($('台本已保存到业务表'), 'success')
        } else {
          await saveNovelContent({ dramaId, episodeNum, content: text })
          toast($('剧本原文已保存到业务表'), 'success')
        }
      } catch (error) {
        toast($t('保存失败：{{value}}', { value: errorMessage(error, $('未知错误')) }), 'error')
      } finally {
        actionBusyRef.current = false
        setSaveRunning(false)
      }
    })()
  }, [dramaId, episodeNum, saveRunning, scriptRunning, splitRunning])

  // 切集/卸载：作废上一集轮询，清空按钮状态，避免把旧集进度显示到新集
  useEffect(() => {
    pollTokenRef.current += 1
    resumedKeyRef.current = ''
    setScriptRunning(false)
    setSplitRunning(false)
    setSaveRunning(false)
    setHasScript(false)
    setScriptGenEnabled(null)
  }, [dramaId, episodeNum])

  /**
   * 画布加载完成后恢复任务监控。
   *
   * <p>刷新页面会丢失前端轮询状态，但后端任务仍在跑；不恢复的话用户只能干等且画布不会自动更新。
   * 这里探测一次本集是否有执行中的台本/拆分镜任务，有则接管轮询。
   * 探测失败只记日志、不阻塞画布使用（点击按钮时还会再查一次，交给人再做判断）。</p>
   */
  useEffect(() => {
    if (!ready || !dramaId) return
    const key = `${dramaId}:${episodeNum}`
    if (resumedKeyRef.current === key) return
    resumedKeyRef.current = key
    const token = pollTokenRef.current
    void (async () => {
      try {
        const status = await getScriptStatus(dramaId, episodeNum)
        if (pollTokenRef.current !== token) return
        setScriptGenEnabled(status.enableScriptGen)
        setHasScript(status.hasScript)
        if (status.hasRunningTask) {
          setScriptRunning(true)
          toast($('检测到本集台本生成任务执行中，完成后会自动刷新画布'))
          try {
            await pollScriptGen(token)
          } catch (error) {
            if (pollTokenRef.current === token) toast($t('生台本失败：{{value}}', { value: errorMessage(error, $('未知错误')) }), 'error')
          } finally {
            if (pollTokenRef.current === token) setScriptRunning(false)
          }
          return
        }
        let task: LensEpisodeTaskStatus | null = null
        try {
          task = await getEpisodeTaskStatus(dramaId, episodeNum)
        } catch (error) {
          // 该集还没有任何任务：正常态，无需恢复
          if (!isNoTaskError(error)) throw error
        }
        if (pollTokenRef.current !== token) return
        if (!task || (task.status !== 'RUNNING' && task.status !== 'QUEUED')) return
        if (task.taskCategory === 'scriptGen') {
          setScriptRunning(true)
          toast($('检测到本集台本生成任务执行中，完成后会自动刷新画布'))
          try {
            await pollScriptGen(token)
          } catch (error) {
            if (pollTokenRef.current === token) toast($t('生台本失败：{{value}}', { value: errorMessage(error, $('未知错误')) }), 'error')
          } finally {
            if (pollTokenRef.current === token) setScriptRunning(false)
          }
          return
        }
        setSplitRunning(true)
        toast($('检测到本集拆分镜任务执行中，完成后会自动刷新画布'))
        try {
          await pollSplitShots(token)
        } catch (error) {
          if (pollTokenRef.current === token) toast($t('拆分镜失败：{{value}}', { value: errorMessage(error, $('未知错误')) }), 'error')
        } finally {
          if (pollTokenRef.current === token) setSplitRunning(false)
        }
      } catch (error) {
        console.warn('[lens] 恢复台本/拆分镜任务监控失败:', error)
      }
    })()
  }, [ready, dramaId, episodeNum, pollScriptGen, pollSplitShots])

  // 返回对象必须引用稳定：它经 CanvasRenderContext 透传进每个节点，
  // 每次渲染新建对象会让所有节点在画布拖动等高频渲染中跟着重渲染。
  return useMemo(
    () => ({ scriptRunning, splitRunning, saveRunning, scriptGenEnabled, hasScript, generateScript, splitShots, saveScriptText }),
    [scriptRunning, splitRunning, saveRunning, scriptGenEnabled, hasScript, generateScript, splitShots, saveScriptText],
  )
}

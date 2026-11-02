/**
 * Lens 画布「配置」弹窗（顶部工具栏「返回分镜板」左侧入口）。
 *
 * <p>数据与 lens 配置页（RuoYi-Vue3/src/views/lens/creation/config.vue）同源：
 * 基本设置存 localStorage（lens_config_<dramaId>）+ /api/sysApi/baseConfig/saveList（type=style_config），
 * 提示词组合/风格导演/模型走 lens 现有接口，保证两个入口读写一致。</p>
 *
 * <p>简化取舍（任务允许）：提示词组合的复杂管理弹窗（颜色/光影细化编辑）暂不做完整版，
 * 这里提供组合下拉 + 只读列表；风格导演只做下拉；管理入口提示到 lens 配置页。</p>
 */
import React from 'react'
import {
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  NumberInput,
  Radio,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
} from '@mantine/core'
import { IconBrush, IconMovie, IconPhoto, IconSettings, IconTool, IconKeyboard } from '@tabler/icons-react'
import './canvasConfigModal.css'
import {
  cancelAllQueuedTasks,
  getCanvasBasicSettings,
  getImage2ImageModels,
  getImageModels,
  getShotVideoModels,
  getStyleConfig,
  listCanvasPromptCombos,
  listCanvasStyleDirectors,
  saveCanvasBasicSettings,
  type LensCanvasStyleConfig,
  type LensModelOption,
  type LensPromptCombo,
  type LensStyleDirector,
} from '../api/lens'
import {
  readCanvasShortcutConfig,
  saveCanvasShortcutConfig,
  type CanvasShortcutConfig,
  type CanvasShortcutKey,
} from '../ui/chat/canvasShortcutConfig'
import { toast } from '../ui/toast'

/** 内置视觉风格选项（与 lens 配置页常见取值对齐；支持自定义覆盖） */
const STYLE_OPTIONS = [
  '真人电影',
  '2D动漫',
  '3D卡通',
  '国风水墨',
  '赛博朋克',
  '日系清新',
  '写实摄影',
  '美漫风格',
  '油画质感',
]

/** 屏幕比例选项 */
const RATIO_OPTIONS = ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9']

/** 生视频模式选项（取值与 lens 配置页一致：reference / reference_ultra） */
const VIDEO_MODE_OPTIONS = [
  { value: 'reference', label: '参考图（角色图 + 场景图）' },
  { value: 'reference_ultra', label: '参考图Ultra（智能衔接分镜）' },
]

/** 人物参考图类型选项 */
const REFERENCE_IMG_TYPE_OPTIONS = [
  { value: 'threeImg', label: '三视图' },
  { value: 'frontImg', label: '全身图' },
]

/** 快捷键下拉选项 */
const SHORTCUT_OPTIONS: Array<{ value: CanvasShortcutKey; label: string }> = [
  { value: 'enter', label: 'Enter 回车键' },
  { value: 'ctrl+enter', label: 'Ctrl/⌘ + Enter 回车键' },
]

/** 基本设置表单默认值（与 lens 配置页默认值一致） */
const DEFAULT_FORM: LensCanvasStyleConfig = {
  selectedStyle: '真人电影',
  screenRatio: '9:16',
  selectedImagePrompt: '',
  selectedVideoPrompt: '',
  selectedDirectorId: null,
  maxVideoDuration: 15,
  autoGenerateModel: '65',
  autoGenerateUseShot: 'prompt',
  autoGenerateVideoMode: 'reference',
  referenceImgType: 'threeImg',
  resolution: '720p',
  autoImageModel: '48',
  autoImage2ImageModel: '47',
  imageResolution: '2k',
  frontImgPromptPrefix: '生成人物全身图,全身自然直立,包含脚穿的鞋,背景纯白,超高清,8K,正面视角,平视,',
  threeViewPrompt: '根据图中人物形象,生成全身三视图以及一张特写(最左边占满三分之一的位置是整个头部(面部)特写，右边三分之二放正视图、侧视图、后视图，纯白背景)，保持人物发丝超清晰，发丝光泽，8K高清，细节拉满。 负面词：头发模糊、发丝结块。',
  threeViewDirectPrompt: '生成角色{roleName}的纯白背景三视图，画面左侧是角色的特写正面肖像照，画面右侧依次是角色正面、侧面、背面的全身照，',
  enableScriptGen: false,
  enableBackupChannel: true,
  backupRetryMax: 2,
  // 以下字段补齐 lens 配置页已知字段，避免加载失败时保存丢失这些配置
  lockStyle: false,
  lockPrompt: false,
  syncChannels: [],
}

interface Props {
  /** 是否打开 */
  opened: boolean
  /** 剧 ID（配置同源 key） */
  dramaId: string
  /** 关闭回调 */
  onClose: () => void
}

/** 模型下拉 data（过滤禁用项） */
function buildModelSelectData(models: LensModelOption[]): Array<{ value: string; label: string }> {
  return models
    .filter((model) => model.enabled !== false)
    .map((model) => ({ value: String(model.value), label: model.label || String(model.value) }))
}

/** 从模型列表取某模型的分辨率选项（未配置时给兜底） */
function resolveModelResolutions(models: LensModelOption[], modelValue: string | undefined, fallback: string[]): string[] {
  const model = models.find((item) => String(item.value) === String(modelValue))
  if (model && Array.isArray(model.resolutions) && model.resolutions.length > 0) return model.resolutions
  return fallback
}

/** 组合下拉 data */
function buildComboSelectData(combos: LensPromptCombo[]): Array<{ value: string; label: string }> {
  return combos.map((combo) => ({
    value: String(combo.id),
    // 系统内置/内置组合加标记，避免用户误以为是剧内自定义组合
    label: (combo.isSystem ? '[系统] ' : combo.isDefault ? '[内置] ' : '') + combo.name,
  }))
}

/**
 * 画布「配置」弹窗。
 *
 * @param props 组件属性
 * @returns 配置弹窗
 */
export function CanvasConfigModal({ opened, dramaId, onClose }: Props): JSX.Element {
  const [activeTab, setActiveTab] = React.useState<string | null>('basic')
  const [loading, setLoading] = React.useState(false)
  // 基本设置加载失败标记：失败时禁止保存，避免用默认值覆盖服务端真实配置
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [cancelingQueued, setCancelingQueued] = React.useState(false)
  const [cancelConfirmOpened, setCancelConfirmOpened] = React.useState(false)
  const [form, setForm] = React.useState<LensCanvasStyleConfig>({ ...DEFAULT_FORM })
  const [showCustomStyle, setShowCustomStyle] = React.useState(false)
  const [customStyle, setCustomStyle] = React.useState('')
  const [imageCombos, setImageCombos] = React.useState<LensPromptCombo[]>([])
  const [videoCombos, setVideoCombos] = React.useState<LensPromptCombo[]>([])
  const [directors, setDirectors] = React.useState<LensStyleDirector[]>([])
  const [imageModels, setImageModels] = React.useState<LensModelOption[]>([])
  const [image2imageModels, setImage2imageModels] = React.useState<LensModelOption[]>([])
  const [videoModels, setVideoModels] = React.useState<LensModelOption[]>([])
  const [shortcut, setShortcut] = React.useState<CanvasShortcutConfig>(() => readCanvasShortcutConfig())

  /**
   * 更新表单某一字段。
   *
   * @param key   字段名
   * @param value 字段值
   */
  const updateForm = React.useCallback(<K extends keyof LensCanvasStyleConfig>(key: K, value: LensCanvasStyleConfig[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  // 打开时加载：本地/服务端配置 + 组合 + 导演 + 模型（任一失败不阻塞其余项）
  React.useEffect(() => {
    if (!opened || !dramaId) return
    let alive = true
    setLoading(true)
    void (async () => {
      const results = await Promise.allSettled([
        getCanvasBasicSettings(dramaId),
        listCanvasPromptCombos(dramaId, 'image_prompt_combo'),
        listCanvasPromptCombos(dramaId, 'prompt_combo'),
        listCanvasStyleDirectors(),
        getImageModels(),
        getImage2ImageModels(),
        getShotVideoModels(),
      ])
      if (!alive) return
      const [settingsResult, imageCombosResult, videoCombosResult, directorsResult, imageModelsResult, image2imageModelsResult, videoModelsResult] = results
      if (settingsResult.status === 'fulfilled') {
        const result = settingsResult.value
        setForm({ ...DEFAULT_FORM, ...(result.settings || {}) })
        if (result.fromServer) {
          setLoadFailed(false)
        } else {
          // 服务端读取失败（即使有本地缓存回退）也禁止保存：无法确认服务端最新字段，保存可能丢字段
          console.warn('[canvas-config] 服务端基本设置读取失败，已回退本地缓存并禁止保存')
          toast('读取画布配置失败，已使用本地缓存（本次不可保存）', 'error')
          setLoadFailed(true)
        }
      } else {
        // 基本设置读不到时用默认值展示，但必须禁止保存（否则会用默认值覆盖服务端真实配置）
        console.warn('[canvas-config] 读取基本设置失败，使用默认值并禁止保存', settingsResult.reason)
        toast('读取画布配置失败，已使用默认值（本次不可保存）', 'error')
        setLoadFailed(true)
      }
      if (imageCombosResult.status === 'fulfilled') setImageCombos(imageCombosResult.value)
      if (videoCombosResult.status === 'fulfilled') setVideoCombos(videoCombosResult.value)
      if (directorsResult.status === 'fulfilled') setDirectors(directorsResult.value)
      if (imageModelsResult.status === 'fulfilled') setImageModels(imageModelsResult.value)
      if (image2imageModelsResult.status === 'fulfilled') setImage2imageModels(image2imageModelsResult.value)
      if (videoModelsResult.status === 'fulfilled') setVideoModels(videoModelsResult.value)
      setShortcut(readCanvasShortcutConfig())
      setLoading(false)
    })()
    return () => { alive = false }
  }, [opened, dramaId])

  /** 保存视觉风格自定义值 */
  const handleSaveCustomStyle = React.useCallback(() => {
    const value = customStyle.trim()
    if (!value) {
      toast('请输入自定义风格内容', 'error')
      return
    }
    if (value.length > 30) {
      toast('自定义风格不能超过 30 个字', 'error')
      return
    }
    updateForm('selectedStyle', value)
    setShowCustomStyle(false)
    setCustomStyle('')
  }, [customStyle, updateForm])

  /** 修改换行快捷键：提交自动取反（互斥联动） */
  const handleLineBreakChange = React.useCallback((value: string | null) => {
    const lineBreak: CanvasShortcutKey = value === 'enter' ? 'enter' : 'ctrl+enter'
    setShortcut({ lineBreak, submit: lineBreak === 'enter' ? 'ctrl+enter' : 'enter' })
  }, [])

  /** 修改提交快捷键：换行自动取反（互斥联动） */
  const handleSubmitChange = React.useCallback((value: string | null) => {
    const submit: CanvasShortcutKey = value === 'enter' ? 'enter' : 'ctrl+enter'
    setShortcut({ lineBreak: submit === 'enter' ? 'ctrl+enter' : 'enter', submit })
  }, [])

  /** 保存配置（基本设置写服务端 + 快捷键写 localStorage，保存后立即生效） */
  const handleSave = React.useCallback(async () => {
    if (!dramaId) {
      toast('未找到当前剧，无法保存配置', 'error')
      return
    }
    // 加载中/加载失败时禁止保存：此时 form 只是默认值，保存会覆盖服务端真实配置
    if (loading || loadFailed || saving) {
      toast(loading ? '配置加载中，请稍候' : '配置加载失败，请关闭弹窗重试', 'error')
      return
    }
    setSaving(true)
    try {
      // 保存前先读服务端最新 style_config，与表单合并：服务端未知字段原样保留，
      // 表单字段覆盖已知字段（防止丢 lockStyle/lockPrompt/syncChannels 等字段）。
      let serverSettings: Record<string, unknown> | null = null
      try {
        serverSettings = await getStyleConfig(dramaId, true)
      } catch (error) {
        // 拉不到最新配置时必须中止保存：继续用旧 form 保存会覆盖服务端在打开弹窗后新增/变更的字段
        console.error('[canvas-config] 保存前读取服务端配置失败，已中止保存', error)
        toast('拉取最新配置失败，请重试', 'error')
        return
      }
      const merged: LensCanvasStyleConfig = {
        ...(serverSettings ? (serverSettings as LensCanvasStyleConfig) : {}),
        ...form,
      }
      await saveCanvasBasicSettings(dramaId, merged)
      setForm(merged)
      saveCanvasShortcutConfig(shortcut)
      toast('画布配置已保存', 'success')
      onClose()
    } catch (error) {
      console.error('[canvas-config] 保存配置失败', error)
      toast('保存失败：' + (error instanceof Error ? error.message : String(error)), 'error')
    } finally {
      setSaving(false)
    }
  }, [dramaId, form, loadFailed, loading, onClose, saving, shortcut])

  /** 取消当前剧所有排队中任务 */
  const handleCancelQueued = React.useCallback(async () => {
    if (!dramaId) return
    setCancelingQueued(true)
    try {
      await cancelAllQueuedTasks(dramaId)
      toast('已提交取消排队任务', 'success')
    } catch (error) {
      console.error('[canvas-config] 取消排队任务失败', error)
      toast('取消失败：' + (error instanceof Error ? error.message : String(error)), 'error')
    } finally {
      setCancelingQueued(false)
      setCancelConfirmOpened(false)
    }
  }, [dramaId])

  /** 视频分辨率选项（跟随视频执行模型） */
  const resolutionOptions = resolveModelResolutions(videoModels, form.autoGenerateModel, ['720p', '480p'])

  /** 生图分辨率选项（跟随生图默认模型） */
  const imageResolutionOptions = resolveModelResolutions(imageModels, form.autoImageModel, ['2k'])

  /** 生图/视频组合下拉 data */
  const imageComboData = React.useMemo(() => buildComboSelectData(imageCombos), [imageCombos])
  const videoComboData = React.useMemo(() => buildComboSelectData(videoCombos), [videoCombos])
  const directorData = React.useMemo(
    () => directors.map((item) => ({ value: String(item.id), label: item.directorName })),
    [directors],
  )

  return (
    <Modal
      className="lens-canvas-config-modal"
      opened={opened}
      onClose={onClose}
      title="画布配置"
      centered
      withinPortal
      /* 宽度走 Mantine 的 size（映射为 --modal-size / width: var(--modal-size)），
         直接写 styles.content.width 会被 Mantine 的 content 宽度规则覆盖。 */
      size="70vw"
      styles={{
        content: {
          maxWidth: 'none',
          height: 'min(900px, 88vh)',
          display: 'flex',
          flexDirection: 'column',
        },
        body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px 20px' },
      }}
    >
      {loading ? (
        <Group className="lens-canvas-config-loading" justify="center" py="xl">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">正在加载配置…</Text>
        </Group>
      ) : (
        <Tabs className="lens-canvas-config-tabs" value={activeTab} onChange={setActiveTab}>
          <Tabs.List className="lens-canvas-config__tab-list">
            <Tabs.Tab className="lens-canvas-config__tab" value="basic" leftSection={<IconSettings size={14} />}>基本设置</Tabs.Tab>
            <Tabs.Tab className="lens-canvas-config__tab" value="imagePrompt" leftSection={<IconBrush size={14} />}>生图前置提示词</Tabs.Tab>
            <Tabs.Tab className="lens-canvas-config__tab" value="videoPrompt" leftSection={<IconPhoto size={14} />}>视频前置提示词</Tabs.Tab>
            <Tabs.Tab className="lens-canvas-config__tab" value="utility" leftSection={<IconTool size={14} />}>实用功能</Tabs.Tab>
            <Tabs.Tab className="lens-canvas-config__tab" value="general" leftSection={<IconKeyboard size={14} />}>通用</Tabs.Tab>
          </Tabs.List>

          {/* 基本设置 */}
          <Tabs.Panel value="basic" pt="md">
            <Stack gap="md">
              <div>
                <Text className="lens-canvas-config-section-title" size="sm" fw={700}>基础配置</Text>
                <Group grow align="flex-start" mt="xs">
                  <div>
                    <Text size="xs" fw={500} mb={4}>视觉风格</Text>
                    <Group gap="xs" wrap="nowrap">
                      <Select
                        data={STYLE_OPTIONS.map((style) => ({ value: style, label: style }))}
                        value={String(form.selectedStyle || '真人电影')}
                        onChange={(value) => updateForm('selectedStyle', value || '真人电影')}
                        comboboxProps={{ withinPortal: true }}
                        style={{ flex: 1 }}
                      />
                      <Button size="xs" variant="light" onClick={() => setShowCustomStyle((prev) => !prev)}>自定义</Button>
                    </Group>
                    {showCustomStyle ? (
                      <Group gap="xs" mt={6} wrap="nowrap">
                        <input
                          className="lens-canvas-config-custom-style"
                          value={customStyle}
                          maxLength={30}
                          placeholder="输入自定义风格（最多30字）"
                          onChange={(event) => setCustomStyle(event.target.value)}
                          style={{ flex: 1, height: 30, borderRadius: 4, border: '1px solid #ced4da', padding: '0 8px' }}
                        />
                        <Button size="xs" onClick={handleSaveCustomStyle}>保存</Button>
                      </Group>
                    ) : null}
                  </div>
                  <div>
                    <Text size="xs" fw={500} mb={4}>屏幕比例</Text>
                    <Select
                      id="canvas-config-ratio-select"
                      data={RATIO_OPTIONS.map((ratio) => ({ value: ratio, label: ratio }))}
                      value={String(form.screenRatio || '9:16')}
                      onChange={(value) => updateForm('screenRatio', value || '9:16')}
                      comboboxProps={{ withinPortal: true }}
                    />
                  </div>
                </Group>
                <Group grow mt="sm">
                  <div>
                    <Text size="xs" fw={500} mb={4}>生图前置提示词</Text>
                    <Select
                      data={imageComboData}
                      value={form.selectedImagePrompt === '' || form.selectedImagePrompt === undefined ? null : String(form.selectedImagePrompt)}
                      onChange={(value) => updateForm('selectedImagePrompt', value || '')}
                      placeholder="不选表示不加前置提示词"
                      clearable
                      comboboxProps={{ withinPortal: true }}
                    />
                  </div>
                  <div>
                    <Text size="xs" fw={500} mb={4}>视频前置提示词</Text>
                    <Select
                      data={videoComboData}
                      value={form.selectedVideoPrompt === '' || form.selectedVideoPrompt === undefined ? null : String(form.selectedVideoPrompt)}
                      onChange={(value) => updateForm('selectedVideoPrompt', value || '')}
                      placeholder="请选择"
                      clearable
                      comboboxProps={{ withinPortal: true }}
                    />
                  </div>
                </Group>
                <Group grow mt="sm">
                  <div>
                    <Text size="xs" fw={500} mb={4}>风格导演</Text>
                    <Select
                      data={directorData}
                      value={form.selectedDirectorId === null || form.selectedDirectorId === undefined ? null : String(form.selectedDirectorId)}
                      onChange={(value) => updateForm('selectedDirectorId', value ? Number(value) : null)}
                      placeholder="请选择"
                      clearable
                      comboboxProps={{ withinPortal: true }}
                    />
                  </div>
                  <div>
                    <Text size="xs" fw={500} mb={4}>最大视频时长（秒）</Text>
                    <NumberInput
                      value={Number(form.maxVideoDuration ?? 15)}
                      onChange={(value) => updateForm('maxVideoDuration', typeof value === 'number' ? value : 15)}
                      min={1}
                      max={60}
                      step={1}
                    />
                  </div>
                </Group>
              </div>
              <Divider />
              <div>
                <Text className="lens-canvas-config-section-title" size="sm" fw={700}>自动生成设置</Text>
                <Group grow mt="xs">
                  <div>
                    <Text size="xs" fw={500} mb={4}>视频执行模型</Text>
                    <Select
                      data={buildModelSelectData(videoModels)}
                      value={form.autoGenerateModel ? String(form.autoGenerateModel) : null}
                      onChange={(value) => {
                        updateForm('autoGenerateModel', value || '')
                        // 切换模型时校正分辨率，避免保留该模型不支持的档位
                        const nextResolutions = resolveModelResolutions(videoModels, value || '', ['720p', '480p'])
                        if (!nextResolutions.includes(String(form.resolution || ''))) {
                          updateForm('resolution', nextResolutions[0] || '720p')
                        }
                      }}
                      comboboxProps={{ withinPortal: true }}
                    />
                  </div>
                  <div>
                    <Text size="xs" fw={500} mb={4}>视频分辨率</Text>
                    <Select
                      data={resolutionOptions.map((item) => ({ value: item, label: item }))}
                      value={form.resolution ? String(form.resolution) : null}
                      onChange={(value) => updateForm('resolution', value || resolutionOptions[0] || '720p')}
                      comboboxProps={{ withinPortal: true }}
                    />
                  </div>
                </Group>
                <Group grow mt="sm">
                  <div>
                    <Text size="xs" fw={500} mb={4}>生图默认模型</Text>
                    <Select
                      data={buildModelSelectData(imageModels)}
                      value={form.autoImageModel ? String(form.autoImageModel) : null}
                      onChange={(value) => {
                        updateForm('autoImageModel', value || '')
                        const nextResolutions = resolveModelResolutions(imageModels, value || '', ['2k'])
                        if (!nextResolutions.includes(String(form.imageResolution || ''))) {
                          updateForm('imageResolution', nextResolutions.includes('2k') ? '2k' : (nextResolutions[0] || '2k'))
                        }
                      }}
                      comboboxProps={{ withinPortal: true }}
                    />
                  </div>
                  <div>
                    <Text size="xs" fw={500} mb={4}>生图分辨率</Text>
                    <Select
                      data={imageResolutionOptions.map((item) => ({ value: item, label: item }))}
                      value={form.imageResolution ? String(form.imageResolution) : null}
                      onChange={(value) => updateForm('imageResolution', value || '2k')}
                      comboboxProps={{ withinPortal: true }}
                    />
                  </div>
                </Group>
                <Group grow mt="sm">
                  <div>
                    <Text size="xs" fw={500} mb={4}>图生图默认模型</Text>
                    <Select
                      data={buildModelSelectData(image2imageModels)}
                      value={form.autoImage2ImageModel ? String(form.autoImage2ImageModel) : null}
                      onChange={(value) => updateForm('autoImage2ImageModel', value || '')}
                      comboboxProps={{ withinPortal: true }}
                    />
                  </div>
                  <div>
                    <Text size="xs" fw={500} mb={4}>台本功能</Text>
                    <Switch
                      checked={form.enableScriptGen === true}
                      onChange={(event) => updateForm('enableScriptGen', event.currentTarget.checked)}
                      label={form.enableScriptGen === true ? '开启' : '关闭'}
                    />
                  </div>
                </Group>
                <Group grow mt="sm" align="flex-start">
                  <div>
                    <Text size="xs" fw={500} mb={4}>生视频模式</Text>
                    <Radio.Group
                      value={String(form.autoGenerateVideoMode || 'reference')}
                      onChange={(value) => updateForm('autoGenerateVideoMode', value)}
                    >
                      <Group gap="md">
                        {VIDEO_MODE_OPTIONS.map((option) => (
                          <Radio key={option.value} value={option.value} label={option.label} />
                        ))}
                      </Group>
                    </Radio.Group>
                  </div>
                  <div>
                    <Text size="xs" fw={500} mb={4}>人物参考图类型</Text>
                    <Radio.Group
                      value={String(form.referenceImgType || 'threeImg')}
                      onChange={(value) => updateForm('referenceImgType', value)}
                    >
                      <Group gap="md">
                        {REFERENCE_IMG_TYPE_OPTIONS.map((option) => (
                          <Radio key={option.value} value={option.value} label={option.label} />
                        ))}
                      </Group>
                    </Radio.Group>
                  </div>
                </Group>
              </div>
              <Divider />
              <div>
                <Text className="lens-canvas-config-section-title" size="sm" fw={700}>角色生图提示词</Text>
                <Stack gap="sm" mt="xs">

                  <div>
                    <Text size="xs" fw={500} mb={4}>三视图提示词</Text>
                    <Textarea
                      autosize
                      minRows={2}
                      maxRows={5}
                      value={String(form.threeViewPrompt || '')}
                      onChange={(event) => updateForm('threeViewPrompt', event.currentTarget.value)}
                    />
                  </div>
                  <div>
                    <Text size="xs" fw={500} mb={4}>文生三视图提示词</Text>
                    <Textarea
                      autosize
                      minRows={2}
                      maxRows={5}
                      value={String(form.threeViewDirectPrompt || '')}
                      onChange={(event) => updateForm('threeViewDirectPrompt', event.currentTarget.value)}
                    />
                  </div>
                </Stack>
              </div>
            </Stack>
          </Tabs.Panel>

          {/* 生图前置提示词 */}
          <Tabs.Panel value="imagePrompt" pt="md">
            <Stack gap="md">
              <Alert color="blue" variant="light">
                复杂组合编辑（颜色/光影等细化选项）请在 lens 配置页「生图前置提示词」中管理；这里选择后保存即可生效。
              </Alert>
              <div>
                <Text size="xs" fw={500} mb={4}>当前选择</Text>
                <Select
                  data={imageComboData}
                  value={form.selectedImagePrompt === '' || form.selectedImagePrompt === undefined ? null : String(form.selectedImagePrompt)}
                  onChange={(value) => updateForm('selectedImagePrompt', value || '')}
                  placeholder="不选表示不加前置提示词"
                  clearable
                  comboboxProps={{ withinPortal: true }}
                />
              </div>
              <div>
                <Text size="xs" fw={500} mb={6}>可用组合（只读）</Text>
                {imageCombos.length === 0 ? (
                  <Text size="sm" c="dimmed">暂无可用组合</Text>
                ) : (
                  <Stack gap={6}>
                    {imageCombos.map((combo) => (
                      <Group key={combo.id} justify="space-between" wrap="nowrap">
                        <Group gap="xs" wrap="nowrap">
                          <Badge size="xs" variant="light" color={combo.isSystem ? 'grape' : 'blue'}>
                            {combo.isSystem ? '系统' : '剧内'}
                          </Badge>
                          <Text size="sm">{combo.name}</Text>
                        </Group>
                        <Text size="xs" c="dimmed" truncate style={{ maxWidth: 420 }}>
                          {String(combo.prePrompt || combo.optionPrompt || '—')}
                        </Text>
                      </Group>
                    ))}
                  </Stack>
                )}
              </div>
            </Stack>
          </Tabs.Panel>

          {/* 视频前置提示词 */}
          <Tabs.Panel value="videoPrompt" pt="md">
            <Stack gap="md">
              <Alert color="blue" variant="light">
                复杂组合编辑（颜色/光影等细化选项）请在 lens 配置页「视频前置提示词」中管理；这里选择后保存即可生效。
              </Alert>
              <div>
                <Text size="xs" fw={500} mb={4}>当前选择</Text>
                <Select
                  data={videoComboData}
                  value={form.selectedVideoPrompt === '' || form.selectedVideoPrompt === undefined ? null : String(form.selectedVideoPrompt)}
                  onChange={(value) => updateForm('selectedVideoPrompt', value || '')}
                  placeholder="请选择"
                  clearable
                  comboboxProps={{ withinPortal: true }}
                />
              </div>
              <div>
                <Text size="xs" fw={500} mb={6}>可用组合（只读）</Text>
                {videoCombos.length === 0 ? (
                  <Text size="sm" c="dimmed">暂无可用组合</Text>
                ) : (
                  <Stack gap={6}>
                    {videoCombos.map((combo) => (
                      <Group key={combo.id} justify="space-between" wrap="nowrap">
                        <Group gap="xs" wrap="nowrap">
                          <Badge size="xs" variant="light" color={combo.isSystem ? 'grape' : combo.isDefault ? 'gray' : 'blue'}>
                            {combo.isSystem ? '系统' : combo.isDefault ? '内置' : '剧内'}
                          </Badge>
                          <Text size="sm">{combo.name}</Text>
                        </Group>
                        <Text size="xs" c="dimmed" truncate style={{ maxWidth: 420 }}>
                          {String(combo.prePrompt || combo.optionPrompt || '—')}
                        </Text>
                      </Group>
                    ))}
                  </Stack>
                )}
              </div>
            </Stack>
          </Tabs.Panel>

          {/* 实用功能 */}
          <Tabs.Panel value="utility" pt="md">
            <Stack gap="lg">
              <div>
                <Text size="sm" fw={700} mb={4}>取消排队任务</Text>
                <Text size="xs" c="dimmed" mb={8}>取消当前剧所有排队中的任务；已在执行中的任务不受影响。</Text>
                <Button
                  color="red"
                  variant="light"
                  size="xs"
                  loading={cancelingQueued}
                  onClick={() => setCancelConfirmOpened(true)}
                >
                  取消所有排队任务
                </Button>
              </div>
              <Divider />
              <div>
                <Text size="sm" fw={700} mb={8}>备用通道</Text>
                <Group gap="lg" align="flex-end">
                  <Switch
                    checked={form.enableBackupChannel !== false}
                    onChange={(event) => updateForm('enableBackupChannel', event.currentTarget.checked)}
                    label="开启备用通道"
                  />
                  <NumberInput
                    label="备用通道最大重试次数"
                    value={Number(form.backupRetryMax ?? 2)}
                    onChange={(value) => updateForm('backupRetryMax', typeof value === 'number' ? value : 2)}
                    min={0}
                    max={10}
                    w={180}
                  />
                </Group>
              </div>
            </Stack>
          </Tabs.Panel>

          {/* 通用 */}
          <Tabs.Panel value="general" pt="md">
            <Stack gap="md">
              <Alert color="blue" variant="light">
                快捷键用于画布右下角 AI 对话输入框；两项互斥（一项选 Enter，另一项自动为 Ctrl/⌘+Enter），保存后立即生效。
              </Alert>
              <div>
                <Text size="xs" fw={500} mb={4}>换行快捷键</Text>
                <Select
                  id="canvas-config-linebreak-select"
                  data={SHORTCUT_OPTIONS}
                  value={shortcut.lineBreak}
                  onChange={handleLineBreakChange}
                  comboboxProps={{ withinPortal: true }}
                />
              </div>
              <div>
                <Text size="xs" fw={500} mb={4}>提交生成快捷键</Text>
                <Select
                  id="canvas-config-submit-select"
                  data={SHORTCUT_OPTIONS}
                  value={shortcut.submit}
                  onChange={handleSubmitChange}
                  comboboxProps={{ withinPortal: true }}
                />
              </div>
              <Text size="xs" c="dimmed">
                当前：Enter = {shortcut.submit === 'enter' ? '发送' : '换行'}，Ctrl/⌘+Enter = {shortcut.submit === 'enter' ? '换行' : '发送'}
              </Text>
            </Stack>
          </Tabs.Panel>
        </Tabs>
      )}

      <Group className="lens-canvas-config-footer" justify="flex-end" mt="lg">
        <Button variant="default" onClick={onClose}>关闭</Button>
        <Button
          id="canvas-config-save-button"
          color="blue"
          loading={saving}
          disabled={loading || loadFailed}
          onClick={() => { void handleSave() }}
        >
          保存配置
        </Button>
      </Group>

      {/* 取消排队确认 */}
      <Modal
        className="lens-canvas-config-confirm"
        opened={cancelConfirmOpened}
        onClose={() => setCancelConfirmOpened(false)}
        title="确认取消排队任务"
        size="sm"
        centered
      >
        <Text size="sm">确定取消当前剧所有排队中的任务吗？已在执行中的任务不受影响。</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" size="xs" onClick={() => setCancelConfirmOpened(false)}>取消</Button>
          <Button color="red" size="xs" loading={cancelingQueued} onClick={() => { void handleCancelQueued() }}>确定</Button>
        </Group>
      </Modal>
    </Modal>
  )
}

export default CanvasConfigModal

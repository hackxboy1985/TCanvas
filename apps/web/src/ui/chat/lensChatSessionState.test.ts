import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyLensChatComposerState, isLensChatHistoryRequestCurrent } from './lensChatSessionState'

// 直接提取真实组件回调，防止只测 helper 而漏掉组件接线和 effect 执行顺序。
const source = readFileSync(new URL('./AiChatDialog.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('AiChatDialog.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function extractCallback(name: string): string {
  let result = ''
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer && ts.isCallExpression(node.initializer)) {
      result = node.initializer.arguments[0].getText(ast)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (!result) throw new Error('未找到真实回调：' + name)
  return result
}
function extractEffect(marker: string): string {
  let result = ''
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'React.useEffect' && node.arguments[0].getText(ast).includes(marker)) {
      result = node.arguments[0].getText(ast)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (!result) throw new Error('未找到真实 effect：' + marker)
  return result
}
function compile<T>(text: string, scope: Record<string, unknown>): T {
  const js = ts.transpileModule('const callback = ' + text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  return new Function(...Object.keys(scope), js + '; return callback')(...Object.values(scope)) as T
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness() {
  const requests = new Map<string, ReturnType<typeof deferred<string[]>>>()
  const scope = {
    historyLoadVersionRef: { current: 0 },
    lensChatSessionRestoredRef: { current: false },
    activeStreamInterruptRef: { current: null },
    lensMentionStartRef: { current: 7 }, lensMentionCaretRef: { current: 9 },
    lensCanvasMode: true,
    createEmptyLensChatComposerState, isLensChatHistoryRequestCurrent,
    setDraft: vi.fn(), setLensMentionedNodes: vi.fn(), setLensMentionQuery: vi.fn(), setLensMentionCandidates: vi.fn(), setLensMentionActiveIndex: vi.fn(),
    setMessages: vi.fn(), setLensChatSessionId: vi.fn(), setLensChatSessionIdState: vi.fn(), setLensActiveSkill: vi.fn(),
    getLensChatSessionId: () => 'initial', createLensChatSessionId: () => 'new',
    fetchLensChatSessionMessages: (id: string) => { const request = deferred<string[]>(); requests.set(id, request); return request.promise },
    mapLensHistoryToChatMessages: (messages: string[]) => messages,
    toast: vi.fn(), $: (text: string) => text, $t: (text: string) => text,
    console: { warn: vi.fn() },
  }
  const clear = compile<() => void>(extractCallback('clearLensChatComposer'), scope)
  const bound = { ...scope, clearLensChatComposer: clear }
  return {
    scope, requests,
    switchSession: compile<(summary: { sessionId: string }) => Promise<void>>(extractCallback('switchLensChatSession'), bound),
    startNew: compile<() => void>(extractCallback('startNewLensConversation'), bound),
    restore: compile<() => () => void>(extractEffect('lensChatSessionRestoredRef.current'), bound),
    genericHistory: compile<() => void>(extractEffect('String(effectiveChatSessionKey'), bound),
  }
}
function expectCleared(h: ReturnType<typeof harness>): void {
  expect(h.scope.setDraft).toHaveBeenLastCalledWith('')
  expect(h.scope.setLensMentionedNodes).toHaveBeenLastCalledWith([])
  expect(h.scope.setLensMentionQuery).toHaveBeenLastCalledWith(null)
  expect(h.scope.setLensMentionCandidates).toHaveBeenLastCalledWith([])
  expect(h.scope.setLensMentionActiveIndex).toHaveBeenLastCalledWith(0)
  expect(h.scope.lensMentionStartRef.current).toBe(-1)
  expect(h.scope.lensMentionCaretRef.current).toBe(0)
}

describe('Lens 真实会话切换回调和恢复 effect', () => {
  it('切换立即清理正文、引用和候选及位置', async () => {
    const h = harness(); const pending = h.switchSession({ sessionId: 'A' })
    expectCleared(h)
    h.requests.get('A')!.resolve(['A']); await pending
    expect(h.scope.setMessages).toHaveBeenLastCalledWith(['A'])
  })
  it.each(['resolve', 'reject'] as const)('A/B 快速切换后忽略 A 的 %s', async (outcome) => {
    const h = harness(); const a = h.switchSession({ sessionId: 'A' }); const b = h.switchSession({ sessionId: 'B' })
    h.requests.get('B')!.resolve(['B']); await b
    h.scope.setMessages.mockClear(); h.scope.toast.mockClear()
    if (outcome === 'resolve') h.requests.get('A')!.resolve(['A'])
    else h.requests.get('A')!.reject(new Error('A失败'))
    await a
    expect(h.scope.setMessages).not.toHaveBeenCalled(); expect(h.scope.toast).not.toHaveBeenCalled()
  })
  it.each(['resolve', 'reject'] as const)('新建后忽略在途历史 %s', async (outcome) => {
    const h = harness(); const pending = h.switchSession({ sessionId: 'A' }); h.startNew(); expectCleared(h)
    h.scope.setMessages.mockClear(); h.scope.toast.mockClear()
    if (outcome === 'resolve') h.requests.get('A')!.resolve(['A'])
    else h.requests.get('A')!.reject(new Error('A失败'))
    await pending
    expect(h.scope.setMessages).not.toHaveBeenCalled(); expect(h.scope.toast).not.toHaveBeenCalled()
  })
  it('首次恢复不会被随后注册的通用历史 effect 误伤', async () => {
    const h = harness(); h.restore(); h.genericHistory()
    h.requests.get('initial')!.resolve(['initial']); await Promise.resolve()
    expect(h.scope.setMessages).toHaveBeenLastCalledWith(['initial'])
  })
  it('首次恢复不能覆盖随后选中的历史会话', async () => {
    const h = harness(); h.restore(); const b = h.switchSession({ sessionId: 'B' })
    h.requests.get('B')!.resolve(['B']); await b; h.scope.setMessages.mockClear()
    h.requests.get('initial')!.resolve(['initial']); await Promise.resolve()
    expect(h.scope.setMessages).not.toHaveBeenCalled()
  })
  it.each(['resolve', 'reject'] as const)('新建后首次恢复的 %s 已失效', async (outcome) => {
    const h = harness(); h.restore(); h.startNew(); h.scope.setMessages.mockClear()
    if (outcome === 'resolve') h.requests.get('initial')!.resolve(['initial'])
    else h.requests.get('initial')!.reject(new Error('恢复失败'))
    await Promise.resolve()
    expect(h.scope.setMessages).not.toHaveBeenCalled(); expect(h.scope.console.warn).not.toHaveBeenCalled()
  })
  it('恢复 cleanup 使旧请求失效并允许严格模式重新恢复', async () => {
    const h = harness(); const cleanup = h.restore(); const old = h.requests.get('initial')!; cleanup(); h.restore()
    old.resolve(['old']); await Promise.resolve(); expect(h.scope.setMessages).not.toHaveBeenCalled()
    h.requests.get('initial')!.resolve(['fresh']); await Promise.resolve()
    expect(h.scope.setMessages).toHaveBeenLastCalledWith(['fresh'])
  })
  it('当前请求失败仍明确提示错误', async () => {
    const h = harness(); const pending = h.switchSession({ sessionId: 'A' })
    h.requests.get('A')!.reject(new Error('A失败')); await pending
    expect(h.scope.toast).toHaveBeenLastCalledWith('恢复历史对话失败：{{message}}', 'error')
  })
})

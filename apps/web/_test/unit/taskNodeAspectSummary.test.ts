import source from '../../src/canvas/nodes/TaskNode.tsx?raw'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/** 独立执行真实源码的摘要表达式，覆盖图片编辑与视频共用工具栏的展示边界。 */
const file = ts.createSourceFile('TaskNode.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let expression: string | undefined
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'summaryResolution') {
    expression = node.initializer?.getText(file)
  }
  ts.forEachChild(node, visit)
}
visit(file)
if (!expression) throw new Error('未找到比例工具栏的摘要表达式')
const summarize = new Function('isVideoNode', 'summaryVideoSize', 'selectedConfiguredImageAspectOption', 'aspect', `return (${expression})`) as (
  isVideoNode: boolean, sizeLabel: string, selected: { label: string } | null, aspect: string
) => string

describe('底部比例工具栏展示', () => {
  it.each(['16:9', '9:16', '1:1', '21:9'])('图片编辑节点显示当前比例 %s 而非像素尺寸', (aspect) => {
    expect(summarize(false, '1280x720 · 720P横屏', { label: aspect }, aspect)).toBe(aspect)
  })
  it('未匹配到配置选项时显示当前比例值', () => {
    expect(summarize(false, '1280x720 · 720P横屏', null, '4:3')).toBe('4:3')
  })
  it('视频仍显示模型配置的画幅说明', () => {
    expect(summarize(true, '1280x720 · 720P横屏', null, '16:9')).toBe('1280x720 · 720P横屏')
  })
})

/**
 * 从画布文本编辑器 DOM 中提取「业务纯文本」。
 *
 * <p><b>为什么不用 innerText</b>：浏览器会给每个块级元素（p/h1/li…）额外插入换行，
 * 例如 `<p>a</p><p>b</p>` 的 innerText 是 `a\n\nb`，与「每一行一个 p」的
 * {@link convertPlainTextToHtml} 不互逆——用户什么都没改，点保存也会把单换行写成双换行。
 * 更严重的是 H1-H4 只是块级标签替换（p → h1），innerText 的换行口径会随展示结构变化，
 * 导致「富文本只影响界面」这个约定被破坏。</p>
 *
 * <p><b>提取规则</b>：块级元素各占一行（相邻块之间 1 个 \n，空块保留为空行），
 * `<br>` 表示换行，行内元素（b/i/span…）直接拼接文本；与
 * {@link convertPlainTextToHtml} 的「每行一个 <p>」严格互逆，
 * 且把 p 换成 h1/h2… 不会改变提取结果。</p>
 *
 * @param root 文本编辑器的 contentEditable 容器
 * @returns 业务纯文本（行间以 \n 分隔）
 */
export function extractEditorPlainText(root: HTMLElement | null): string {
  if (!root) return ''
  const lines = collectLines(root)
  // contentEditable 末尾常驻一个空块/空行（浏览器自动补），只去掉整体末尾这一个空行，
  // 正文中间的空行必须保留
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines.join('\n')
}

/**
 * 块级标签集合：这些元素在编辑器里代表「独立一行」。
 *
 * <p>只要 H1-H4 与 P 同属块级标签，两者互相替换时提取结果完全一致。</p>
 */
const BLOCK_TAG_NAMES = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE', 'FIGURE',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
])

/**
 * 递归收集节点内的文本行。
 *
 * @param node 任意 DOM 节点
 * @returns 该节点对应的文本行数组（可能为空数组）
 */
function collectLines(node: Node): string[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = String(node.textContent || '').replace(/\u00A0/g, ' ')
    // 文本节点内的真实换行也按行拆开（contentEditable 在部分输入法下会写入换行符）
    return text ? text.split('\n') : []
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return []
  const element = node as HTMLElement
  const tag = element.tagName
  if (tag === 'BR' || tag === 'HR') return [''] 

  const lines: string[] = []
  /** 把行内元素/文本节点的行片段并入当前行：第一段拼到当前行，其余各自成行 */
  const appendInlineSegments = (segments: string[]): void => {
    if (segments.length === 0) return
    if (lines.length === 0) lines.push(segments[0])
    else lines[lines.length - 1] += segments[0]
    for (let index = 1; index < segments.length; index += 1) {
      lines.push(segments[index])
    }
  }

  Array.from(element.childNodes).forEach((child) => {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const childElement = child as HTMLElement
      const childTag = childElement.tagName
      if (childTag === 'BR' || childTag === 'HR') {
        lines.push('')
        return
      }
      const childLines = collectLines(child)
      if (BLOCK_TAG_NAMES.has(childTag)) {
        // 块级子节点：整体作为新的一行（空块产出一个空行）
        if (childLines.length === 0) lines.push('')
        else lines.push(...childLines)
      } else {
        appendInlineSegments(childLines)
      }
      return
    }
    appendInlineSegments(collectLines(child))
  })
  return lines
}

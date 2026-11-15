// 回复的 markdown 标题：只在「需要摘要」或「需要多级召回」时使用。
// 短内容仍然整段进检查点/整段召回，不经过这里——这是「内容不长就保持原文」的边界。

// 围栏只认行首（最多 3 个空格缩进）的反引号或波浪号；行尾带信息串的是开启行，
// 关闭行必须同字符、长度不短于开启行且后面没有内容。
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
// ATX 标题：1~6 个 #，后面必须是空白（"# 标题" 而不是 "#标题"）。
// 中文输入法常打出全角空格，也认。
const HEADING = /^ {0,3}(#{1,6})(?:[ \t\u3000]+(.*?))?[ \t\u3000]*$/

// 标题列表：{ level, title, text, line }。跳过代码块里的「# 注释」，否则示例代码会被当成章节。
export function headingsOf(text) {
  const lines = String(text === null || text === undefined ? '' : text).split('\n')
  const out = []
  let fence = ''
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const fenceMatch = line.match(FENCE)
    if (fenceMatch) {
      const mark = fenceMatch[1]
      const rest = fenceMatch[2].trim()
      if (!fence) fence = mark
      else if (rest === '' && mark[0] === fence[0] && mark.length >= fence.length) fence = ''
      continue
    }
    if (fence) continue
    const match = line.match(HEADING)
    if (!match) continue
    const title = (match[2] || '').replace(/[ \t\u3000]+#+[ \t\u3000]*$/, '').trim()
    if (!title) continue
    out.push({ level: match[1].length, title, text: '#'.repeat(match[1].length) + ' ' + title, line: i })
  }
  return out
}

// 检查点里的「回复摘要」：只列标题，不列正文。至少两个标题才值得用——
// 一个标题的「目录」等于没有内容，退回去用开头+结尾反而更有信息量。
// 标题总长不受 maxNoteTokens 约束：它就是取代默认节选的另一种摘要。
export function outlineOf(text) {
  const headings = headingsOf(text)
  if (headings.length < 2) return null
  return { count: headings.length, text: headings.map((heading) => heading.text).join(' / ') }
}

// 多级召回里的「回复分段」：每个标题开启一段，标题前的导语单独成段（标题为空）。
// 同样要求至少两个标题：一段切不开的回复仍然整段召回。
export function splitSections(text) {
  const value = String(text === null || text === undefined ? '' : text)
  const lines = value.split('\n')
  const headings = headingsOf(value)
  if (headings.length < 2) return null
  const sections = []
  if (headings[0].line > 0) {
    const intro = lines.slice(0, headings[0].line).join('\n').trim()
    if (intro) sections.push({ level: 0, title: '', text: intro })
  }
  for (let i = 0; i < headings.length; i += 1) {
    const from = headings[i].line
    const to = i + 1 < headings.length ? headings[i + 1].line : lines.length
    const body = lines.slice(from, to).join('\n').trimEnd()
    if (body) sections.push({ level: headings[i].level, title: headings[i].title, text: body })
  }
  return sections
}

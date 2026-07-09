// 锚点解析器：把模型给的短锚点定位到文件里的行范围。
// 核心思路是不让模型复述原文，只给"足够唯一的片段"。
// 分层 fallback：正则 → 多行块 → 单行精确 → 单行包含 → unicode 容错。

export type AnchorMatch = {
  // 闭区间，0-indexed 行号
  startLine: number
  endLine: number
}

export class AnchorNotFoundError extends Error {
  constructor(anchor: string, filePath: string) {
    super(`Anchor not found in ${filePath}:\n${anchor}\nRe-read the file and provide a snippet that exists.`)
    this.name = "AnchorNotFoundError"
  }
}

export class AmbiguousAnchorError extends Error {
  constructor(anchor: string, filePath: string, count: number) {
    super(
      `Anchor matched ${count} places in ${filePath}. Provide a longer or more unique snippet:\n${anchor}`,
    )
    this.name = "AmbiguousAnchorError"
  }
}

// 单行 normalize：trim + 折叠连续空白，让模型给的锚点对缩进/多余空格容错
function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ")
}

// unicode 标点归一化，抄 patch/index.ts:418 的思路
function normalizeUnicode(str: string): string {
  return str
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
}

// 把 anchor 拆成行，丢掉末尾空行（模型常多带一个换行）
function toAnchorLines(anchor: string): string[] {
  const lines = anchor.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

// 正则匹配：anchor 以 "re:" 开头时，剩余部分当正则源码用
function matchRegex(lines: string[], pattern: string): AnchorMatch[] {
  let re: RegExp
  try {
    re = new RegExp(pattern)
  } catch {
    return []
  }
  const hits: AnchorMatch[] = []
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) hits.push({ startLine: i, endLine: i })
  }
  return hits
}

// 多行块匹配：anchor 拆成 N 行，找连续 N 行使得每行 trim 后包含对应 anchor 行 trim
function matchBlock(lines: string[], anchorLines: string[]): AnchorMatch[] {
  const hits: AnchorMatch[] = []
  const n = anchorLines.length
  const normed = anchorLines.map(normalizeLine)
  for (let i = 0; i <= lines.length - n; i++) {
    let ok = true
    for (let j = 0; j < n; j++) {
      if (!normalizeLine(lines[i + j]).includes(normed[j])) {
        ok = false
        break
      }
    }
    if (ok) hits.push({ startLine: i, endLine: i + n - 1 })
  }
  return hits
}

// 单行匹配，四 pass 逐级放宽
function matchSingleLine(lines: string[], anchor: string): AnchorMatch[] {
  const target = anchor.trim()
  const targetNorm = normalizeUnicode(target)
  const hits: AnchorMatch[] = []

  // pass 1：trim 后精确相等
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === target) hits.push({ startLine: i, endLine: i })
  }
  if (hits.length > 0) return dedupe(hits)

  // pass 2：trim 后包含
  const targetCollapsed = normalizeLine(target)
  for (let i = 0; i < lines.length; i++) {
    if (normalizeLine(lines[i]).includes(targetCollapsed)) hits.push({ startLine: i, endLine: i })
  }
  if (hits.length > 0) return dedupe(hits)

  // pass 3：unicode 归一化后包含
  for (let i = 0; i < lines.length; i++) {
    if (normalizeUnicode(lines[i].trim()).includes(targetNorm)) hits.push({ startLine: i, endLine: i })
  }
  return dedupe(hits)
}

function dedupe(hits: AnchorMatch[]): AnchorMatch[] {
  const seen = new Set<string>()
  const out: AnchorMatch[] = []
  for (const h of hits) {
    const key = `${h.startLine}:${h.endLine}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(h)
    }
  }
  return out
}

// 主入口：解析 anchor 到唯一行范围。多匹配或零匹配都抛错。
export function resolveAnchor(lines: string[], anchor: string, filePath: string): AnchorMatch {
  const trimmed = anchor.trim()

  // 正则模式
  if (trimmed.startsWith("re:")) {
    const pattern = trimmed.slice(3)
    const hits = matchRegex(lines, pattern)
    if (hits.length === 0) throw new AnchorNotFoundError(anchor, filePath)
    if (hits.length > 1) throw new AmbiguousAnchorError(anchor, filePath, hits.length)
    return hits[0]
  }

  const anchorLines = toAnchorLines(trimmed)

  // 多行块
  if (anchorLines.length > 1) {
    const hits = matchBlock(lines, anchorLines)
    if (hits.length === 0) throw new AnchorNotFoundError(anchor, filePath)
    if (hits.length > 1) throw new AmbiguousAnchorError(anchor, filePath, hits.length)
    return hits[0]
  }

  // 单行
  const hits = matchSingleLine(lines, trimmed)
  if (hits.length === 0) throw new AnchorNotFoundError(anchor, filePath)
  if (hits.length > 1) throw new AmbiguousAnchorError(anchor, filePath, hits.length)
  return hits[0]
}

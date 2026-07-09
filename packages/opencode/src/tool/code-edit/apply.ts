// ops 应用器：把一批编辑操作链式应用到 lines 数组上。
// 原子性靠"全在内存里 reduce，全成功才写盘"保证——任何一步抛错就直接返回错误，文件不动。

import { resolveAnchor, AnchorNotFoundError, AmbiguousAnchorError } from "./anchor"

export type Op =
  | { op: "insert"; anchor: string; position: "before" | "after"; content: string }
  | { op: "replace"; anchor: string; content: string }
  | { op: "delete"; anchor: string; endAnchor?: string }

export class OpError extends Error {
  constructor(
    message: string,
    readonly index: number,
    readonly cause?: unknown,
  ) {
    super(`op[${index}]: ${message}`)
    this.name = "OpError"
    if (cause !== undefined) (this as any).cause = cause
  }
}

function splitContent(content: string): string[] {
  // 模型给的 content 末尾不带换行是常态，split 会多出一个空串，丢掉它
  const lines = content.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

// 把单个 op 应用到当前 lines，返回新 lines。抛错则整个批次作废。
function applyOne(lines: string[], op: Op, index: number, filePath: string): string[] {
  const match = (() => {
    try {
      return resolveAnchor(lines, op.anchor, filePath)
    } catch (e) {
      throw new OpError(
        e instanceof Error ? e.message : String(e),
        index,
        e,
      )
    }
  })()

  switch (op.op) {
    case "insert": {
      const newLines = splitContent(op.content)
      const at = op.position === "before" ? match.startLine : match.endLine + 1
      const next = lines.slice(0, at)
      next.push(...newLines)
      next.push(...lines.slice(at))
      return next
    }

    case "replace": {
      const newLines = splitContent(op.content)
      const next = lines.slice(0, match.startLine)
      next.push(...newLines)
      next.push(...lines.slice(match.endLine + 1))
      return next
    }

    case "delete": {
      let endLine = match.endLine
      if (op.endAnchor) {
        const end = (() => {
          try {
            return resolveAnchor(lines, op.endAnchor, filePath)
          } catch (e) {
            throw new OpError(
              `endAnchor: ${e instanceof Error ? e.message : String(e)}`,
              index,
              e,
            )
          }
        })()
        if (end.startLine < match.startLine) {
          throw new OpError("endAnchor is before anchor in delete op", index)
        }
        endLine = end.endLine
      }
      const next = lines.slice(0, match.startLine)
      next.push(...lines.slice(endLine + 1))
      return next
    }
  }
}

// 链式 reduce：lines0 → op0 → lines1 → op1 → ... → linesN
// 任何一步抛错，整个调用抛出，调用方不写盘。
export function applyOps(lines: string[], ops: Op[], filePath: string): string[] {
  let current = lines
  for (let i = 0; i < ops.length; i++) {
    current = applyOne(current, ops[i], i, filePath)
  }
  return current
}

export { AnchorNotFoundError, AmbiguousAnchorError }

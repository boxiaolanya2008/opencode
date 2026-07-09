// diff 生成：复用 edit.ts 的 trimDiff + diff 包的 createTwoFilesPatch。
// 跟 edit/write/apply_patch 保持一致，UI 渲染无需改。

import { createTwoFilesPatch, diffLines } from "diff"
import { trimDiff } from "../edit"

export type FileDiff = {
  file: string
  patch: string
  additions: number
  deletions: number
}

export function buildDiff(filePath: string, oldContent: string, newContent: string): FileDiff {
  const patch = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))
  let additions = 0
  let deletions = 0
  for (const change of diffLines(oldContent, newContent)) {
    if (change.added) additions += change.count || 0
    if (change.removed) deletions += change.count || 0
  }
  return { file: filePath, patch, additions, deletions }
}

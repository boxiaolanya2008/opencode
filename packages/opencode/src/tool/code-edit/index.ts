import * as path from "path"
import { Effect, Schema, Semaphore } from "effect"
import { diffLines } from "diff"
import * as Tool from "../tool"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./code-edit.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "../external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Bom from "@/util/bom"
import { applyOps, type Op } from "./apply"
import { buildDiff } from "./diff"

// per-file 锁，跟 edit.ts 同一套，避免并发写冲突。
// 直接复用 edit.ts 的 locks Map 会导致循环依赖，所以这里自建一份。
const locks = new Map<string, Semaphore.Semaphore>()

function lock(filePath: string) {
  const resolved = FSUtil.resolve(filePath)
  const hit = locks.get(resolved)
  if (hit) return hit
  const next = Semaphore.makeUnsafe(1)
  locks.set(resolved, next)
  return next
}

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({
    description: "Absolute path to the file to modify.",
  }),
  ops: Schema.Array(
    Schema.Union([
      Schema.Struct({
        op: Schema.Literal("insert"),
        anchor: Schema.String.annotate({
          description:
            "A short snippet that uniquely identifies where to insert. Matched against file lines (trimmed, contains). Must be unique in the file.",
        }),
        position: Schema.Literal("before", "after").annotate({
          description: "Insert before or after the matched anchor line(s).",
        }),
        content: Schema.String.annotate({
          description: "The code to insert.",
        }),
      }),
      Schema.Struct({
        op: Schema.Literal("replace"),
        anchor: Schema.String.annotate({
          description:
            "A short snippet identifying the line range to replace. The matched lines are fully replaced by content.",
        }),
        content: Schema.String.annotate({
          description: "The replacement code.",
        }),
      }),
      Schema.Struct({
        op: Schema.Literal("delete"),
        anchor: Schema.String.annotate({
          description: "A short snippet identifying the first line to delete.",
        }),
        endAnchor: Schema.optional(Schema.String).annotate({
          description:
            "Optional snippet identifying the last line to delete. If omitted, only the anchor line is deleted.",
        }),
      }),
    ]),
  ).annotate({
    description:
      "Ordered list of edit operations. Applied sequentially; each op sees the result of the previous one. If any op fails, no changes are written.",
  }),
})

export const CodeEditTool = Tool.define(
  "code_edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.filePath) throw new Error("filePath is required")
          if (params.ops.length === 0) throw new Error("ops must not be empty")

          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filePath)

          let contentOld = ""
          let contentNew = ""
          let diff = ""

          yield* lock(filePath).withPermits(1)(
            Effect.gen(function* () {
              const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!info) throw new Error(`File ${filePath} not found`)
              if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)

              const source = yield* Bom.readFile(afs, filePath)
              contentOld = source.text
              const ending = detectLineEnding(contentOld)

              // 核心逻辑：normalize → split → applyOps → join → 还原行尾
              const normalized = normalizeLineEndings(contentOld)
              let lines = normalized.split("\n")
              // 丢掉末尾空串（split 末尾换行的产物），应用完再加回来
              const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === ""
              if (hadTrailingNewline) lines.pop()

              lines = applyOps(lines, params.ops as Op[], filePath)

              if (hadTrailingNewline) lines.push("")
              let joined = lines.join("\n")
              joined = convertToLineEnding(joined, ending)

              const next = Bom.split(joined)
              const desiredBom = source.bom || next.bom
              contentNew = next.text

              const built = buildDiff(
                filePath,
                normalizeLineEndings(contentOld),
                normalizeLineEndings(contentNew),
              )
              diff = built.patch

              yield* ctx.ask({
                permission: "edit",
                patterns: [path.relative(instance.worktree, filePath)],
                always: ["*"],
                metadata: {
                  filepath: filePath,
                  diff,
                },
              })

              yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
              if (yield* format.file(filePath)) {
                contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
                const rebuilt = buildDiff(
                  filePath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                )
                diff = rebuilt.patch
              }

              yield* events.publish(FileSystem.Event.Edited, { file: filePath })
              yield* events.publish(Watcher.Event.Updated, { file: filePath, event: "change" })
            }).pipe(Effect.orDie),
          )

          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: diff,
            additions: 0,
            deletions: 0,
          }
          for (const change of diffLines(contentOld, contentNew)) {
            if (change.added) filediff.additions += change.count || 0
            if (change.removed) filediff.deletions += change.count || 0
          }

          yield* ctx.metadata({
            metadata: {
              diff,
              filediff,
              diagnostics: {},
            },
          })

          let output = `Applied ${params.ops.length} operation(s) successfully.`
          yield* lsp.touchFile(filePath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilePath = FSUtil.normalizePath(filePath)
          const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          return {
            metadata: {
              diagnostics,
              diff,
              filediff,
            },
            title: path.relative(instance.worktree, filePath),
            output,
          }
        }),
    }
  }),
)

export * as CodeEdit from "."

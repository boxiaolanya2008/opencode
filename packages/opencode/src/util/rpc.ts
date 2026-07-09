type Definition = {
  [method: string]: (input: any) => any
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    try {
      const parsed = JSON.parse(evt.data)
      if (parsed.type === "rpc.request") {
        try {
          const result = await rpc[parsed.method](parsed.input)
          postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          postMessage(JSON.stringify({ type: "rpc.error", error: message, id: parsed.id }))
        }
        return
      }
      if (parsed.type === "rpc.log") {
        process.stderr.write(parsed.message)
        return
      }
      if (typeof parsed.message === "string") {
        process.stderr.write(parsed.message)
      }
    } catch {}
  }
}

export function emitLog(message: string) {
  postMessage(JSON.stringify({ type: "rpc.log", message }))
}

export const onLog = (handler: (message: string) => void) => {
  const wrapped = (evt: MessageEvent) => {
    try {
      const parsed = JSON.parse(evt.data)
      if (parsed.type === "rpc.log") handler(parsed.message)
    } catch {}
  }
  onmessage = wrapped
  return wrapped
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
  onerror?: ((this: AbstractWorker, ev: ErrorEvent) => any) | null
}) {
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  target.onmessage = async (evt) => {
    try {
      const parsed = JSON.parse(evt.data)
      if (parsed.type === "rpc.result") {
        const entry = pending.get(parsed.id)
        if (entry) {
          entry.resolve(parsed.result)
          pending.delete(parsed.id)
        }
      }
      if (parsed.type === "rpc.error") {
        const entry = pending.get(parsed.id)
        if (entry) {
          entry.reject(new Error(parsed.error))
          pending.delete(parsed.id)
        }
      }
      if (parsed.type === "rpc.event") {
        const handlers = listeners.get(parsed.event)
        if (handlers) {
          for (const handler of handlers) {
            handler(parsed.data)
          }
        }
      }
    } catch {}
  }
  target.onerror = () => {
    const error = new Error("Worker has been terminated")
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        try {
          target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
        } catch (error) {
          pending.delete(requestId)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}

export * as Rpc from "./rpc"

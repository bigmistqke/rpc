import {
  $MESSENGER_ERROR,
  $MESSENGER_RESPONSE,
  ErrorShape,
  RequestData,
  RequestShape,
  ResponseShape,
  RPCPayloadShape,
} from './message-protocol'
import { RPC } from './types'
export type { RPC } from './types'
import { callMethod, createCommander, createIdRegistry, defer } from './utils'

export const $TRANSFER = 'RPC-TRANSFER'
export const $MESSENGER = Symbol('RPC-MESSENGER')

/** Wrapper type for transferable values */
export type Transferred<T> = T & {
  [$TRANSFER]: true
}

/**
 * Mark a value as transferable for postMessage.
 * Use this to transfer ownership of ArrayBuffer, ReadableStream, etc.
 */
export function transfer<T extends object>(value: T): Transferred<T> {
  return Object.assign(value, { [$TRANSFER]: true } as const)
}

/**
 * Check if a value is marked for transfer
 */
function isTransferred(value: unknown): value is Transferred<unknown> {
  return !!value && typeof value === 'object' && $TRANSFER in value
}

/**
 * Extract transferables from args and unwrap transferred values
 */
function extractTransferables(args: any[]): { args: any[]; transferables: Transferable[] } {
  const transferables: Transferable[] = []

  const processValue = (value: any): any => {
    if (isTransferred(value)) {
      transferables.push(value)
      return value
    }
    if (Array.isArray(value)) {
      return value.map(processValue)
    }
    if (value && typeof value === 'object' && value.constructor === Object) {
      const result: any = {}
      for (const key in value) {
        result[key] = processValue(value[key])
      }
      return result
    }
    return value
  }

  const processedArgs = args.map(processValue)
  return { args: processedArgs, transferables }
}

interface WorkerMessenger {
  postMessage(message: any, transferables?: any[]): void
  addEventListener(key: 'message', callback: (event: MessageEvent) => void): void
  start?(): void
}

type Messenger = Window | WorkerMessenger

/**********************************************************************************/
/*                                                                                */
/*                                      Utils                                     */
/*                                                                                */
/**********************************************************************************/

/**
 * Checks whether the given target is a `Window` object (WindowProxy).
 */
function isWindowProxy(target: any): target is Window {
  return (
    typeof target === 'object' &&
    typeof target?.postMessage === 'function' &&
    typeof target?.closed === 'boolean'
  )
}

/**
 * Returns a `postMessage` function compatible with both Window and Worker contexts.
 */
function usePostMessage(messenger: Messenger) {
  if (isWindowProxy(messenger)) {
    return (message: any, transferables?: any[]) =>
      messenger.postMessage(message, '*', transferables)
  } else {
    return (message: any, transferables?: any[]) => messenger.postMessage(message, transferables)
  }
}

/**********************************************************************************/
/*                                                                                */
/*                              Requester / Responder                             */
/*                                                                                */
/**********************************************************************************/

/**
 * Sets up a requester that sends messages and returns promises resolving when a response is received.
 *
 * @param messenger - The target Messenger to send messages to
 * @param options - Optional abort signal
 * @returns A function to send payloads and await responses
 */
function createRequester(messenger: Messenger, options: { signal?: AbortSignal } = {}) {
  const promiseRegistry = createIdRegistry<{
    resolve(value: any): void
    reject(value: unknown): void
  }>()
  const postMessage = usePostMessage(messenger)

  messenger.addEventListener(
    'message',
    event => {
      const data = (event as MessageEvent<unknown>).data
      if (ErrorShape.validate(data)) {
        promiseRegistry.free(data[$MESSENGER_ERROR])?.reject(data.error)
      } else if (ResponseShape.validate(data)) {
        promiseRegistry.free(data[$MESSENGER_RESPONSE])?.resolve(data.payload)
      }
    },
    options,
  )

  if ('start' in messenger) {
    messenger.start?.()
  }

  return (payload: any, transferables?: any[]) => {
    const { promise, resolve, reject } = defer()
    const id = promiseRegistry.register({ resolve, reject })
    postMessage(RequestShape.create(id, payload), transferables)
    return promise
  }
}

/**
 * Sets up a responder that listens for requests and responds with the result of the callback.
 *
 * @param messenger - The Messenger to receive messages from
 * @param callback - A function called with the validated request event
 * @param options - Optional abort signal
 */
export function createResponder(
  messenger: Messenger,
  callback: (data: RequestData) => any,
  options: { signal?: AbortSignal } = {},
) {
  const postMessage = usePostMessage(messenger)

  messenger.addEventListener(
    'message',
    async event => {
      const data = (event as MessageEvent).data
      if (RequestShape.validate(data)) {
        try {
          const result = await callback(data)
          // Extract transferables from the result
          const { args: [processedResult], transferables } = extractTransferables([result])
          postMessage(ResponseShape.create(data, processedResult), transferables)
        } catch (error) {
          postMessage(ErrorShape.create(data, error))
        }
      }
    },
    options,
  )

  if ('start' in messenger) {
    messenger.start?.()
  }
}

/**********************************************************************************/
/*                                                                                */
/*                                  Expose / Rpc                                  */
/*                                                                                */
/**********************************************************************************/

/**
 * Exposes a set of methods as an RPC endpoint over the given messenger.
 *
 * @param methods - An object containing functions to expose
 * @param options - Optional target Messenger and abort signal
 */
export function expose<T extends object>(
  methods: T,
  { to = self, signal }: { to?: Messenger; signal?: AbortSignal } = {},
) {
  createResponder(
    to,
    data => {
      if (RPCPayloadShape.validate(data.payload)) {
        try {
          const { topics, args } = data.payload
          return callMethod(methods, topics, args)
        } catch (error) {
          console.error('Error while processing rpc request:', error, data.payload, methods)
        }
      }
    },
    { signal },
  )
}

/**
 * Creates an RPC proxy for calling remote methods on the given Messenger.
 *
 * @param messenger - The Messenger to communicate with (e.g. Worker or Window)
 * @param options - Optional abort signal
 * @returns A proxy object that lets you call methods remotely
 *
 * @example
 * ```ts
 * const worker = new Worker('worker.js')
 * const api = rpc<WorkerAPI>(worker)
 *
 * // Call remote methods
 * await api.doSomething()
 *
 * // Access underlying messenger
 * api[$MESSENGER].terminate()
 * ```
 */
// Overloads for specific messenger types to enable proper type inference
export function rpc<T extends object>(
  messenger: Worker,
  options?: { signal?: AbortSignal },
): RPC<T> & { [$MESSENGER]: Worker }

export function rpc<T extends object>(
  messenger: MessagePort,
  options?: { signal?: AbortSignal },
): RPC<T> & { [$MESSENGER]: MessagePort }

export function rpc<T extends object>(
  messenger: Window,
  options?: { signal?: AbortSignal },
): RPC<T> & { [$MESSENGER]: Window }

export function rpc<T extends object>(
  messenger: BroadcastChannel,
  options?: { signal?: AbortSignal },
): RPC<T> & { [$MESSENGER]: BroadcastChannel }

export function rpc<T extends object>(
  messenger: ServiceWorker,
  options?: { signal?: AbortSignal },
): RPC<T> & { [$MESSENGER]: ServiceWorker }

export function rpc<T extends object, M extends Messenger = Messenger>(
  messenger: M,
  options?: { signal?: AbortSignal },
): RPC<T> & { [$MESSENGER]: M }

// Implementation
export function rpc<T extends object, M extends Messenger>(
  messenger: M,
  options?: { signal?: AbortSignal },
): RPC<T> & { [$MESSENGER]: M } {
  const request = createRequester(messenger, options)
  const proxy = createCommander<RPC<T>>((topics, args) => {
    const { args: processedArgs, transferables } = extractTransferables(args)
    return request(RPCPayloadShape.create(topics, processedArgs), transferables)
  })
  return Object.assign(proxy, { [$MESSENGER]: messenger })
}

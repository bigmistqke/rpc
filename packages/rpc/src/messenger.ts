import {
  $MESSENGER_ERROR,
  $MESSENGER_HANDLE,
  $MESSENGER_RESPONSE,
  ErrorShape,
  HandleResponseShape,
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

/**********************************************************************************/
/*                                                                                */
/*                                     Handle                                     */
/*                                                                                */
/**********************************************************************************/

const $HANDLE_MARKER = Symbol('RPC-HANDLE-MARKER')

/** Internal marker type for handle() */
interface HandleMarker<T extends object> {
  [$HANDLE_MARKER]: true
  methods: T
}

/**
 * Mark methods to be returned as a sub-proxy from an RPC method.
 * Use this when a method needs to return an object with callable methods.
 *
 * @example
 * ```ts
 * expose({
 *   init(canvas: OffscreenCanvas) {
 *     const renderer = createRenderer(canvas)
 *     return handle({
 *       render: () => renderer.render(),
 *       resize: (w, h) => renderer.resize(w, h),
 *     })
 *   }
 * })
 * ```
 */
export function handle<T extends object>(methods: T): T {
  return { [$HANDLE_MARKER]: true, methods } as unknown as T
}

/**
 * Check if a value is a handle marker
 */
function isHandleMarker<T extends object>(value: unknown): value is HandleMarker<T> {
  return !!value && typeof value === 'object' && $HANDLE_MARKER in value
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

// Prefix for namespace IDs to avoid collisions
const HANDLE_NAMESPACE_PREFIX = '__rpc_handle_'

// Counter for generating unique namespace IDs
let handleNamespaceCounter = 0

/**
 * Exposes methods as an RPC endpoint over the given messenger.
 *
 * @param methods - Object containing methods to expose
 * @param options - Optional target Messenger and abort signal
 *
 * @example
 * ```ts
 * // Worker side - simple methods
 * expose({
 *   add: (a, b) => a + b,
 *   multiply: (a, b) => a * b,
 * })
 *
 * // Worker side - with initialization returning sub-proxy
 * expose({
 *   init(canvas: OffscreenCanvas) {
 *     const renderer = createRenderer(canvas)
 *     return handle({
 *       render: () => renderer.render(),
 *       resize: (w, h) => renderer.resize(w, h),
 *     })
 *   }
 * })
 * ```
 */
export function expose<TMethods extends object>(
  methods: TMethods,
  { to = self, signal }: { to?: Messenger; signal?: AbortSignal } = {},
): void {
  const postMessage = usePostMessage(to)

  // Registry of namespaced handlers (for handle() sub-proxies)
  const namespaceHandlers = new Map<string, object>()

  /**
   * Process a result value, registering handle markers as namespaces
   */
  const processResult = (result: unknown): unknown => {
    if (isHandleMarker(result)) {
      const namespaceId = `${HANDLE_NAMESPACE_PREFIX}${handleNamespaceCounter++}`
      namespaceHandlers.set(namespaceId, result.methods)
      return HandleResponseShape.create(namespaceId)
    }
    return result
  }

  to.addEventListener(
    'message',
    async event => {
      const data = (event as MessageEvent).data

      if (RequestShape.validate(data)) {
        try {
          // Handle RPC request
          if (RPCPayloadShape.validate(data.payload)) {
            const { topics, args } = data.payload

            // Check if this is a namespaced request (for handle() sub-proxies)
            if (topics.length > 0 && topics[0].startsWith(HANDLE_NAMESPACE_PREFIX)) {
              const namespaceId = topics[0]
              const handler = namespaceHandlers.get(namespaceId)

              if (!handler) {
                throw new Error(`Unknown namespace: ${namespaceId}`)
              }

              // Call method on the namespaced handler (skip namespace ID in topics)
              const result = await callMethod(handler, topics.slice(1), args)
              const processedResult = processResult(result)
              const { args: [finalResult], transferables } = extractTransferables([processedResult])
              postMessage(ResponseShape.create(data, finalResult), transferables)
              return
            }

            // Regular method call on root methods
            const result = await callMethod(methods, topics, args)
            const processedResult = processResult(result)
            const { args: [finalResult], transferables } = extractTransferables([processedResult])
            postMessage(ResponseShape.create(data, finalResult), transferables)
            return
          }
        } catch (error) {
          console.error('Error while processing rpc request:', error, data.payload)
          postMessage(ErrorShape.create(data, error))
        }
      }
    },
    { signal },
  )

  if ('start' in to) {
    to.start?.()
  }
}

/**
 * Check if a response payload is a handle response
 */
function isHandleResponse(value: unknown): value is { [$MESSENGER_HANDLE]: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    $MESSENGER_HANDLE in value &&
    typeof (value as any)[$MESSENGER_HANDLE] === 'string'
  )
}

/**
 * Creates an RPC proxy for calling remote methods on the given Messenger.
 *
 * @param messenger - The Messenger to communicate with (e.g. Worker or Window)
 * @param options - Optional abort signal
 * @returns A proxy object for calling remote methods
 *
 * @example
 * ```ts
 * // Create RPC proxy (synchronous)
 * const worker = rpc<WorkerMethods>(new Worker('worker.js'))
 *
 * // Call methods that return handle() get sub-proxies
 * const renderer = await worker.init(transfer(canvas))
 * await renderer.render()
 *
 * // Access underlying messenger
 * worker[$MESSENGER].terminate()
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

  /**
   * Create a commander proxy that handles handle() responses
   */
  const createRpcCommander = <U extends object>(topicPrefix: string[] = []): RPC<U> => {
    return createCommander<RPC<U>>((topics, methodArgs) => {
      const { args: processedMethodArgs, transferables: methodTransferables } =
        extractTransferables(methodArgs)
      const fullTopics = [...topicPrefix, ...topics]
      return request(RPCPayloadShape.create(fullTopics, processedMethodArgs), methodTransferables).then(
        (result: unknown) => {
          // If result is a handle response, create a sub-proxy
          if (isHandleResponse(result)) {
            return createRpcCommander(result[$MESSENGER_HANDLE] ? [result[$MESSENGER_HANDLE]] : [])
          }
          return result
        },
      )
    })
  }

  const proxy = createRpcCommander<T>()

  return Object.assign(proxy, { [$MESSENGER]: messenger })
}

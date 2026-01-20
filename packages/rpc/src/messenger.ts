import {
  $MESSENGER_ERROR,
  $MESSENGER_RESPONSE,
  ErrorShape,
  InitPayloadShape,
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

/** Factory function that creates methods from constructor args */
type MethodsFactory<TArgs extends any[], TMethods extends object> = (
  ...args: TArgs
) => TMethods | Promise<TMethods>

/**
 * Exposes methods as an RPC endpoint over the given messenger.
 * Accepts a factory function that receives constructor args and returns methods.
 *
 * @param factory - A function that takes constructor args and returns methods (can be async)
 * @param options - Optional target Messenger and abort signal
 *
 * @example
 * ```ts
 * // Worker side
 * expose(async (canvas: OffscreenCanvas, config: Config) => {
 *   await initializeWasm()
 *   const renderer = createRenderer(canvas, config)
 *
 *   return {
 *     render: renderer.render,
 *     resize: renderer.resize,
 *   }
 * })
 * ```
 */
export function expose<TArgs extends any[], TMethods extends object>(
  factory: MethodsFactory<TArgs, TMethods>,
  { to = self, signal }: { to?: Messenger; signal?: AbortSignal } = {},
): void {
  const postMessage = usePostMessage(to)
  let methods: TMethods | null = null
  let initPromise: Promise<TMethods> | null = null

  to.addEventListener(
    'message',
    async event => {
      const data = (event as MessageEvent).data

      if (RequestShape.validate(data)) {
        try {
          // Handle init request
          if (InitPayloadShape.validate(data.payload)) {
            const { args } = data.payload
            // Call factory with constructor args
            initPromise = Promise.resolve(factory(...(args as TArgs)))
            methods = await initPromise
            // Respond with success (no payload needed, just acknowledgment)
            postMessage(ResponseShape.create(data, undefined), [])
            return
          }

          // Handle RPC request
          if (RPCPayloadShape.validate(data.payload)) {
            // Wait for init if still in progress
            if (initPromise && !methods) {
              methods = await initPromise
            }

            if (!methods) {
              throw new Error('RPC called before initialization')
            }

            const { topics, args } = data.payload
            const result = await callMethod(methods, topics, args)
            const { args: [processedResult], transferables } = extractTransferables([result])
            postMessage(ResponseShape.create(data, processedResult), transferables)
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
 * Creates an RPC proxy for calling remote methods on the given Messenger.
 * Sends constructor args to the worker and waits for initialization.
 *
 * @param messenger - The Messenger to communicate with (e.g. Worker or Window)
 * @param args - Constructor arguments to pass to the worker's factory function
 * @param options - Optional abort signal
 * @returns A promise that resolves to a proxy object for calling remote methods
 *
 * @example
 * ```ts
 * const api = await rpc<RendererAPI>(
 *   new Worker('renderer.worker.js'),
 *   [transfer(offscreenCanvas), { width: 1920, height: 1080 }]
 * )
 *
 * // Worker is fully initialized, safe to call methods
 * await api.render(frameData)
 *
 * // Access underlying messenger
 * api[$MESSENGER].terminate()
 * ```
 */
// Overloads for specific messenger types to enable proper type inference
export function rpc<T extends object>(
  messenger: Worker,
  args?: any[],
  options?: { signal?: AbortSignal },
): Promise<RPC<T> & { [$MESSENGER]: Worker }>

export function rpc<T extends object>(
  messenger: MessagePort,
  args?: any[],
  options?: { signal?: AbortSignal },
): Promise<RPC<T> & { [$MESSENGER]: MessagePort }>

export function rpc<T extends object>(
  messenger: Window,
  args?: any[],
  options?: { signal?: AbortSignal },
): Promise<RPC<T> & { [$MESSENGER]: Window }>

export function rpc<T extends object>(
  messenger: BroadcastChannel,
  args?: any[],
  options?: { signal?: AbortSignal },
): Promise<RPC<T> & { [$MESSENGER]: BroadcastChannel }>

export function rpc<T extends object>(
  messenger: ServiceWorker,
  args?: any[],
  options?: { signal?: AbortSignal },
): Promise<RPC<T> & { [$MESSENGER]: ServiceWorker }>

export function rpc<T extends object, M extends Messenger = Messenger>(
  messenger: M,
  args?: any[],
  options?: { signal?: AbortSignal },
): Promise<RPC<T> & { [$MESSENGER]: M }>

// Implementation
export async function rpc<T extends object, M extends Messenger>(
  messenger: M,
  args: any[] = [],
  options?: { signal?: AbortSignal },
): Promise<RPC<T> & { [$MESSENGER]: M }> {
  const request = createRequester(messenger, options)

  // Send init request with constructor args
  const { args: processedArgs, transferables } = extractTransferables(args)
  await request(InitPayloadShape.create(processedArgs), transferables)

  // Create proxy for method calls
  const proxy = createCommander<RPC<T>>((topics, methodArgs) => {
    const { args: processedMethodArgs, transferables: methodTransferables } =
      extractTransferables(methodArgs)
    return request(RPCPayloadShape.create(topics, processedMethodArgs), methodTransferables)
  })

  return Object.assign(proxy, { [$MESSENGER]: messenger })
}

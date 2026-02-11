import * as v from 'valibot'
import { createExposeRequestHandler, createRpcCommander } from '../core'
import {
  $MESSENGER_ERROR,
  $MESSENGER_RESPONSE,
  ErrorShape,
  RequestShape,
  ResponseShape,
  RPCPayloadShape,
} from '../protocol'
import { RPC as BaseRPC } from '../types'
import { createIdRegistry, createShape, defer } from '../utils'
export { handle, type Handled } from '../handle'

export const $WEBSOCKET = Symbol.for('RPC-WEBSOCKET')

export interface WebSocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: unknown) => void): void
}

export type RPC<T extends object, WS extends WebSocketLike = WebSocketLike> = BaseRPC<T> & {
  [$WEBSOCKET]: WS
}

/**********************************************************************************/
/*                                                                                */
/*                              Requester / Responder                             */
/*                                                                                */
/**********************************************************************************/

const MessageEventShape = createShape(v.object({ data: v.unknown() }), (data: unknown) => ({
  data,
}))

function parseData(raw: unknown): unknown {
  return JSON.parse(typeof raw === 'string' ? raw : String(raw))
}

function createRequester(ws: WebSocketLike) {
  const promiseRegistry = createIdRegistry<{
    resolve(value: any): void
    reject(value: unknown): void
  }>()

  ws.addEventListener('message', (event: unknown) => {
    if (!MessageEventShape.validate(event)) return
    try {
      const data = parseData(event.data)
      if (ErrorShape.validate(data)) {
        promiseRegistry.free(data[$MESSENGER_ERROR])?.reject(data.error)
      } else if (ResponseShape.validate(data)) {
        promiseRegistry.free(data[$MESSENGER_RESPONSE])?.resolve(data.payload)
      }
    } catch (error) {
      console.error(error)
    }
  })

  return (payload: any) => {
    const { promise, resolve, reject } = defer()
    const id = promiseRegistry.register({ resolve, reject })
    ws.send(JSON.stringify(RequestShape.create(id, payload)))
    return promise
  }
}

/**********************************************************************************/
/*                                                                                */
/*                                  Expose / Rpc                                  */
/*                                                                                */
/**********************************************************************************/

/**
 * Exposes methods as an RPC endpoint over the given WebSocket.
 *
 * @param methods - Object containing methods to expose
 * @param options - Target WebSocket and optional abort signal
 *
 * @example
 * ```ts
 * expose({
 *   add: (a, b) => a + b,
 *   multiply: (a, b) => a * b,
 * }, { to: ws })
 * ```
 */
export function expose<TMethods extends object>(
  methods: TMethods,
  { to }: { to: WebSocketLike },
): void {
  const handleRequest = createExposeRequestHandler(methods)

  to.addEventListener('message', async (event: unknown) => {
    if (!MessageEventShape.validate(event)) return
    try {
      const data = parseData(event.data)
      if (RequestShape.validate(data)) {
        try {
          if (RPCPayloadShape.validate(data.payload)) {
            const result = await handleRequest(data.payload.topics, data.payload.args)
            to.send(JSON.stringify(ResponseShape.create(data, result)))
          }
        } catch (error) {
          console.error('Error while processing rpc request:', error, data.payload)
          to.send(JSON.stringify(ErrorShape.create(data, error)))
        }
      }
    } catch (error) {
      console.error(error)
    }
  })
}

/**
 * Creates an RPC proxy for calling remote methods on the given WebSocket.
 *
 * @param ws - The WebSocket to communicate with
 * @param options - Optional abort signal
 * @returns A proxy object for calling remote methods
 *
 * @example
 * ```ts
 * const server = rpc<ServerMethods>(ws)
 * const result = await server.add(2, 3)
 *
 * // Access underlying WebSocket
 * server[$WEBSOCKET].close()
 * ```
 */
export function rpc<T extends object, WS extends WebSocketLike = WebSocketLike>(
  ws: WS,
): RPC<T, WS> {
  const request = createRequester(ws)

  const proxy = createRpcCommander<T>((topics, args) => {
    return request(RPCPayloadShape.create(topics, args))
  })

  return Object.assign(proxy, { [$WEBSOCKET]: ws }) as RPC<T, WS>
}

import * as v from 'valibot'
import { $MESSENGER_REQUEST, RequestShape, RPCPayloadShape } from '../protocol'
import { RPC } from '../types'
import { callMethod, createCommander, createIdRegistry, createShape, defer } from '../utils'

const $SSE_RESPONSE_HEADER = 'RPC_SSE_RESPONSE'

export const isSSEResponse = (event: { request: Request }) =>
  event.request.headers.has($SSE_RESPONSE_HEADER)

export const Payload = createShape(
  v.object({ args: v.array(v.any()), topics: v.array(v.string()) }),
  (topics: Array<string>, args: Array<any>) => ({ topics, args }),
)

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
export function expose<T extends object>(url: string, methods: T) {
  const sse = new EventSource(url)
  sse.addEventListener('message', async event => {
    try {
      const data = JSON.parse(event.data)

      if (RequestShape.validate(data) && RPCPayloadShape.validate(data.payload)) {
        const {
          [$MESSENGER_REQUEST]: id,
          payload: { args, topics },
        } = data

        fetch(url, {
          method: 'POST',
          headers: {
            [$SSE_RESPONSE_HEADER]: id.toString(),
          },
          body: JSON.stringify({ payload: await callMethod(methods, topics, args) }),
        })
      }
    } catch (error) {
      console.error('ERROR', error, event)
    }
  })
}

/**
 * Creates an RPC proxy for calling remote methods on the given Messenger.
 *
 * @param messenger - The Messenger to communicate with (e.g. Worker or Window)
 * @param options - Optional abort signal
 * @returns A proxy object that lets you call methods remotely
 */
export function rpc<T extends object>() {
  const promiseRegistry = createIdRegistry<{
    resolve(value: any): void
    reject(value: unknown): void
  }>()

  return {
    create() {
      const encoder = new TextEncoder()
      const closeHandlers = new Set<() => void>()
      let controller: ReadableStreamDefaultController
      let closed = false

      function send(value: any) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
      }

      const stream = new ReadableStream({
        start(_controller) {
          controller = _controller
        },
        cancel() {
          closeHandlers.forEach(handler => handler())
          closed = true
        },
      })

      return [
        createCommander<RPC<T>>(async (topics, args) => {
          if (closed) {
            throw new Error(`[rpc/sse] Stream is closed.`)
          }
          const { promise, resolve, reject } = defer()
          const id = promiseRegistry.register({ resolve, reject })
          send(RequestShape.create(id, RPCPayloadShape.create(topics, args)))
          return promise
        }),
        {
          get closed() {
            return closed
          },
          onClose(callback: () => void) {
            closeHandlers.add(callback)
            return () => closeHandlers.delete(callback)
          },
          response: new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            },
          }),
        },
      ] as const
    },
    handleAnswer: async (event: { request: Request }) => {
      const id = event.request.headers.get($SSE_RESPONSE_HEADER)
      if (id !== null) {
        try {
          const { payload } = await event.request.json()
          promiseRegistry.free(+id)?.resolve(payload)
        } catch (error) {
          console.error('ERROR', error, event)
        }
      }
      return new Response()
    },
  }
}

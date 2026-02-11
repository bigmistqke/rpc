import * as v from 'valibot'
import { RPC } from '../types'
import { callMethod, createCommander } from '../core'
import { createShape } from '../utils'

const $FETCH_HEADER = 'RPC_RR_PROXY'

export const isFetchRequest = (event: { request: Request }) =>
  event.request.headers.has($FETCH_HEADER)

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
export function expose<T extends object>(methods: T) {
  return async (event: { request: Request }) => {
    try {
      const json = await event.request.json()

      if (!Payload.validate(json)) {
        throw new Error(`Incorrect shape`)
      }
      const { args, topics } = json

      const payload = await callMethod(methods, topics, args)
      return new Response(JSON.stringify({ payload }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (error) {
      return new Response(null, {
        statusText:
          typeof error === 'string'
            ? error
            : typeof error === 'object' &&
              error &&
              'message' in error &&
              typeof error.message === 'string'
            ? error.message
            : undefined,
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }
}

/**
 * Creates an RPC proxy for calling remote methods on the given Messenger.
 *
 * @param messenger - The Messenger to communicate with (e.g. Worker or Window)
 * @param options - Optional abort signal
 * @returns A proxy object that lets you call methods remotely
 */
export function rpc<T extends object>(base: string): RPC<T> {
  return createCommander<RPC<T>>(async (topics, args) => {
    const result = await fetch(
      new Request(`${base}/${topics.join('/')}`, {
        method: topics.length > 0 ? 'POST' : 'GET',
        headers: { [$FETCH_HEADER]: 'true' },
        body: JSON.stringify(Payload.create(topics, args)),
      }),
    )

    if (result.status !== 200) {
      throw result.statusText
    }

    const { payload } = await result.json()
    return payload
  })
}

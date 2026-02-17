import { HANDLE_NAMESPACE_PREFIX, isHandleMarker, nextHandleNamespaceId } from './handle'
import { $MESSENGER_HANDLE, HandleResponseShape } from './protocol'
import type { RPC } from './types'

export function createCommander<T extends object = object>(
  apply: (topics: Array<string>, args: Array<any>) => void,
): T {
  function _createCommander(
    topics: Array<string>,
    apply: (topics: Array<string>, args: Array<any>) => void,
  ): T {
    return new Proxy(function () { } as T, {
      get(target, topic) {
        if (typeof topic === 'symbol') return (target as any)[topic]
        // Return undefined for 'then' so proxy isn't treated as thenable
        if (topic === 'then') return undefined
        return _createCommander([...topics, topic], apply)
      },
      apply(_, __, args) {
        return apply(topics, args)
      },
    })
  }
  return _createCommander([], apply)
}

export function callMethod(methods: object, topics: string[], args: unknown[]) {
  const method = topics.reduce((acc, topic) => {
    const result = (acc as any)?.[topic]
    return result
  }, methods)
  if (typeof method !== 'function') {
    throw new Error(`Topics did not resolve to a function: [${topics.join(',')}]`)
  }
  return method.call(methods, ...args)
}

/**
 * Check if a response payload is a handle response
 */
export function isHandleResponse(value: unknown): value is { [$MESSENGER_HANDLE]: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    $MESSENGER_HANDLE in value &&
    typeof (value as any)[$MESSENGER_HANDLE] === 'string'
  )
}

/**
 * Creates a request handler for expose() that manages namespace routing and handle() sub-proxies.
 * Returns the processed result ready to be sent back over the transport.
 */
export function createExposeRequestHandler(methods: object) {
  const namespaceHandlers = new Map<string, object>()

  const processResult = (result: unknown): unknown => {
    if (isHandleMarker(result)) {
      const namespaceId = nextHandleNamespaceId()
      namespaceHandlers.set(namespaceId, result.methods)
      return HandleResponseShape.create(namespaceId)
    }
    return result
  }

  return async (topics: string[], args: unknown[]): Promise<unknown> => {
    const firstTopic = topics[0]
    if (firstTopic && firstTopic.startsWith(HANDLE_NAMESPACE_PREFIX)) {
      const handler = namespaceHandlers.get(firstTopic)
      if (!handler) {
        throw new Error(`Unknown namespace: ${firstTopic}`)
      }
      const result = await callMethod(handler, topics.slice(1), args)
      return processResult(result)
    }
    const result = await callMethod(methods, topics, args)
    return processResult(result)
  }
}

/**
 * Creates an RPC commander proxy that handles handle() sub-proxy responses.
 */
export function createRpcCommander<T extends object>(
  request: (topics: string[], args: any[]) => Promise<unknown>,
  topicPrefix: string[] = [],
): RPC<T> {
  return createCommander<RPC<T>>((topics, methodArgs) => {
    const fullTopics = [...topicPrefix, ...topics]
    return request(fullTopics, methodArgs).then((result: unknown) => {
      if (isHandleResponse(result)) {
        return createRpcCommander(
          request,
          result[$MESSENGER_HANDLE] ? [result[$MESSENGER_HANDLE]] : [],
        )
      }
      return result
    })
  })
}

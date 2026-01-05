import { BaseSchema, InferOutput, safeParse } from 'valibot'

export function createIdAllocator() {
  const freeIds = new Array<number>()
  let id = 0

  return {
    create() {
      if (freeIds.length) {
        return freeIds.pop()!
      }
      return id++
    },
    free(id: number) {
      freeIds.push(id)
    },
  }
}

export interface IdRegistry<T> {
  register(value: T): number
  free(id: number): T | undefined
}

export function createIdRegistry<T>(): IdRegistry<T> {
  const map = new Map<number, T>()
  const idFactory = createIdAllocator()

  return {
    register(value: T) {
      const id = idFactory.create()
      map.set(id, value)
      return id
    },
    free(id: number) {
      idFactory.free(id)
      return map.get(id)
    },
  }
}

export type PromiseRegistry = IdRegistry<{
  resolve(value: any): void
  reject(value: unknown): void
}>

export function createPromiseRegistry(): PromiseRegistry {
  return createIdRegistry()
}

export function defer<T = void>() {
  let resolve: (value: T) => void = null!
  let reject: (value: unknown) => void = null!
  return {
    promise: new Promise<T>((_resolve, _reject) => ((resolve = _resolve), (reject = _reject))),
    resolve,
    reject,
  }
}

export function createCommander<T extends object = object>(
  apply: (topics: Array<string>, args: Array<any>) => void,
): T {
  function _createCommander(
    topics: Array<string>,
    apply: (topics: Array<string>, args: Array<any>) => void,
  ): T {
    return new Proxy(function () {} as T, {
      get(target, topic) {
        if (typeof topic === 'symbol') return (target as any)[topic]
        return _createCommander([...topics, topic], apply)
      },
      apply(_, __, args) {
        return apply(topics, args)
      },
    })
  }
  return _createCommander([], apply)
}

/**
 * Creates a schema-backed shape definition with a validator and constructor.
 *
 * @param schema - A Valibot schema for the shape
 * @param create - A function that produces valid output for the schema
 */
export function createShape<
  TSchema extends BaseSchema<any, any, any>,
  TCreate extends (...args: Array<any>) => InferOutput<TSchema>,
>(schema: TSchema, create: TCreate) {
  return {
    validate: (value: any): value is InferOutput<TSchema> => safeParse(schema, value).success,
    create,
  }
}

// expose-core.ts
export function callMethod(methods: object, topics: string[], args: unknown[]) {
  const method = topics.reduce((acc, topic) => {
    const result = (acc as any)?.[topic]
    return result
  }, methods)
  if (typeof method !== 'function') {
    throw new Error(`Topics did not resolve to a function: [${topics.join(',')}]`)
  }
  return method(...args)
}

// NOTE:  safari does not implement AsyncIterator for ReadableStream
//        see https://caniuse.com/mdn-api_readablestream_--asynciterator
export function streamToAsyncIterable<T>(stream: ReadableStream<T>): AsyncIterable<T> {
  if (Symbol.asyncIterator in stream) {
    return stream as ReadableStream<T> & AsyncIterable<T>
  }
  const reader = stream.getReader()
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const result = await reader.read()
          return result as IteratorResult<T>
        },
        async return() {
          reader.releaseLock()
          return { value: undefined, done: true }
        },
      }
    },
  }
}

export function createReadableStream() {
  const closeHandlers = new Set<() => void>()
  let controller: ReadableStreamDefaultController = null!
  let closed = false

  const stream = new ReadableStream({
    start(_controller) {
      controller = _controller
    },
    cancel() {
      closeHandlers.forEach(handler => handler())
      closed = true
    },
  })

  return {
    controller,
    stream,
    enqueue: controller.enqueue.bind(controller),
    closed() {
      return closed
    },
    onClose(cb: () => void) {
      closeHandlers.add(cb)
      return () => closeHandlers.delete(cb)
    },
  }
}

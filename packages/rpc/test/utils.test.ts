import { describe, it, expect, vi } from 'vitest'
import { callMethod, createCommander } from '../src/core'
import {
  createIdAllocator,
  createIdRegistry,
  createPromiseRegistry,
  defer,
  createReadableStream,
  streamToAsyncIterable,
  createShape,
} from '../src/utils'
import * as v from 'valibot'

describe('createIdAllocator', () => {
  it('should generate sequential IDs starting from 0', () => {
    const allocator = createIdAllocator()
    expect(allocator.create()).toBe(0)
    expect(allocator.create()).toBe(1)
    expect(allocator.create()).toBe(2)
  })

  it('should reuse freed IDs', () => {
    const allocator = createIdAllocator()
    const id0 = allocator.create()
    const id1 = allocator.create()
    const id2 = allocator.create()

    allocator.free(id1)
    expect(allocator.create()).toBe(1) // Reuses freed ID

    allocator.free(id0)
    allocator.free(id2)
    expect(allocator.create()).toBe(2) // LIFO order for freed IDs
    expect(allocator.create()).toBe(0)
  })

  it('should continue generating new IDs when no freed IDs available', () => {
    const allocator = createIdAllocator()
    allocator.create() // 0
    allocator.create() // 1
    allocator.free(0)
    allocator.create() // reuses 0
    expect(allocator.create()).toBe(2) // new ID
  })
})

describe('createIdRegistry', () => {
  it('should register values and return IDs', () => {
    const registry = createIdRegistry<string>()
    const id0 = registry.register('foo')
    const id1 = registry.register('bar')
    expect(id0).toBe(0)
    expect(id1).toBe(1)
  })

  it('should free IDs and return stored values', () => {
    const registry = createIdRegistry<string>()
    registry.register('foo')
    registry.register('bar')

    expect(registry.free(0)).toBe('foo')
    expect(registry.free(1)).toBe('bar')
  })

  it('should return undefined for non-existent IDs', () => {
    const registry = createIdRegistry<string>()
    expect(registry.free(999)).toBeUndefined()
  })

  it('should reuse freed IDs for new registrations', () => {
    const registry = createIdRegistry<string>()
    const id0 = registry.register('foo')
    registry.free(id0)
    const id1 = registry.register('bar')
    expect(id1).toBe(0) // Reused
  })
})

describe('createPromiseRegistry', () => {
  it('should register promise handlers and retrieve them', () => {
    const registry = createPromiseRegistry()
    const resolve = vi.fn()
    const reject = vi.fn()

    const id = registry.register({ resolve, reject })
    const handlers = registry.free(id)

    expect(handlers).toEqual({ resolve, reject })
  })
})

describe('defer', () => {
  it('should create a deferred promise that can be resolved', async () => {
    const deferred = defer<string>()
    deferred.resolve('test')
    await expect(deferred.promise).resolves.toBe('test')
  })

  it('should create a deferred promise that can be rejected', async () => {
    const deferred = defer<string>()
    deferred.reject(new Error('test error'))
    await expect(deferred.promise).rejects.toThrow('test error')
  })

  it('should work with void type', async () => {
    const deferred = defer()
    deferred.resolve()
    await expect(deferred.promise).resolves.toBeUndefined()
  })
})

describe('createCommander', () => {
  it('should track property access as topics', () => {
    const apply = vi.fn()
    const commander = createCommander<{ foo: { bar: () => void } }>(apply)

    commander.foo.bar()

    expect(apply).toHaveBeenCalledWith(['foo', 'bar'], [])
  })

  it('should pass arguments to apply function', () => {
    const apply = vi.fn()
    const commander = createCommander<{ method: (a: number, b: string) => void }>(apply)

    commander.method(42, 'hello')

    expect(apply).toHaveBeenCalledWith(['method'], [42, 'hello'])
  })

  it('should handle deeply nested paths', () => {
    const apply = vi.fn()
    const commander = createCommander<{ a: { b: { c: { d: () => void } } } }>(apply)

    commander.a.b.c.d()

    expect(apply).toHaveBeenCalledWith(['a', 'b', 'c', 'd'], [])
  })

  it('should return undefined for symbol properties', () => {
    const apply = vi.fn()
    const commander = createCommander(apply)

    expect((commander as any)[Symbol.iterator]).toBeUndefined()
  })

  it('should return result from apply function', () => {
    const apply = vi.fn().mockReturnValue('result')
    const commander = createCommander<{ method: () => string }>(apply)

    const result = commander.method()

    expect(result).toBe('result')
  })
})

describe('callMethod', () => {
  it('should call top-level method', () => {
    const methods = {
      greet: (name: string) => `Hello, ${name}!`,
    }

    expect(callMethod(methods, ['greet'], ['World'])).toBe('Hello, World!')
  })

  it('should call nested method', () => {
    const methods = {
      user: {
        profile: {
          getName: () => 'John',
        },
      },
    }

    expect(callMethod(methods, ['user', 'profile', 'getName'], [])).toBe('John')
  })

  it('should pass multiple arguments', () => {
    const methods = {
      add: (a: number, b: number) => a + b,
    }

    expect(callMethod(methods, ['add'], [2, 3])).toBe(5)
  })

  it('should throw if topics do not resolve to a function', () => {
    const methods = {
      value: 42,
    }

    expect(() => callMethod(methods, ['value'], [])).toThrow(
      'Topics did not resolve to a function: [value]',
    )
  })

  it('should throw if intermediate path is undefined', () => {
    const methods = {
      foo: {},
    }

    expect(() => callMethod(methods, ['foo', 'bar', 'baz'], [])).toThrow(
      'Topics did not resolve to a function: [foo,bar,baz]',
    )
  })

  it('should throw for non-existent path', () => {
    const methods = {}

    expect(() => callMethod(methods, ['nonexistent'], [])).toThrow(
      'Topics did not resolve to a function: [nonexistent]',
    )
  })
})

describe('createShape', () => {
  it('should validate values against schema', () => {
    const shape = createShape(v.object({ name: v.string() }), (name: string) => ({ name }))

    expect(shape.validate({ name: 'test' })).toBe(true)
    expect(shape.validate({ name: 123 })).toBe(false)
    expect(shape.validate({})).toBe(false)
    expect(shape.validate(null)).toBe(false)
  })

  it('should create valid instances', () => {
    const shape = createShape(
      v.object({ id: v.number(), value: v.string() }),
      (id: number, value: string) => ({ id, value }),
    )

    const instance = shape.create(1, 'test')
    expect(instance).toEqual({ id: 1, value: 'test' })
    expect(shape.validate(instance)).toBe(true)
  })
})

describe('createReadableStream', () => {
  it('should create a readable stream with controller', () => {
    const { stream, controller } = createReadableStream()
    expect(stream).toBeInstanceOf(ReadableStream)
    expect(controller).toBeDefined()
  })

  it('should allow enqueueing data', async () => {
    const { stream, enqueue } = createReadableStream()

    enqueue('chunk1')
    enqueue('chunk2')

    const reader = stream.getReader()
    expect(await reader.read()).toEqual({ value: 'chunk1', done: false })
    expect(await reader.read()).toEqual({ value: 'chunk2', done: false })
  })

  it('should track closed state', () => {
    const { closed } = createReadableStream()
    expect(closed()).toBe(false)
  })

  it('should call onClose handlers when stream is cancelled', async () => {
    const { stream, onClose } = createReadableStream()
    const handler = vi.fn()

    onClose(handler)

    const reader = stream.getReader()
    await reader.cancel()

    expect(handler).toHaveBeenCalled()
  })

  it('should allow removing onClose handlers', async () => {
    const { stream, onClose } = createReadableStream()
    const handler = vi.fn()

    const unsubscribe = onClose(handler)
    unsubscribe()

    const reader = stream.getReader()
    await reader.cancel()

    expect(handler).not.toHaveBeenCalled()
  })
})

describe('streamToAsyncIterable', () => {
  it('should convert ReadableStream to AsyncIterable', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(1)
        controller.enqueue(2)
        controller.enqueue(3)
        controller.close()
      },
    })

    const iterable = streamToAsyncIterable(stream)
    const results: number[] = []

    for await (const value of iterable) {
      results.push(value)
    }

    expect(results).toEqual([1, 2, 3])
  })

  it('should use native async iterator if available', async () => {
    const mockStream = {
      [Symbol.asyncIterator]: function* () {
        yield 1
        yield 2
      },
    } as unknown as ReadableStream<number>

    const iterable = streamToAsyncIterable(mockStream)
    expect(iterable).toBe(mockStream)
  })

  it('should handle empty stream', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close()
      },
    })

    const iterable = streamToAsyncIterable(stream)
    const results: unknown[] = []

    for await (const value of iterable) {
      results.push(value)
    }

    expect(results).toEqual([])
  })
})

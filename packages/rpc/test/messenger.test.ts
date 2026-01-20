import { describe, it, expect, vi, beforeEach } from 'vitest'
import { expose, rpc, createResponder } from '../src/messenger'
import {
  $MESSENGER_REQUEST,
  $MESSENGER_RESPONSE,
  $MESSENGER_ERROR,
  $MESSENGER_RPC_REQUEST,
  $MESSENGER_INIT,
} from '../src/message-protocol'

// Helper to flush pending promises
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

// Mock MessagePort
function createMockMessagePort() {
  const handlers: Array<(event: MessageEvent) => void> = []
  return {
    postMessage: vi.fn(),
    addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
      if (type === 'message') {
        handlers.push(handler)
      }
    }),
    removeEventListener: vi.fn(),
    start: vi.fn(),
    _emit(data: any) {
      handlers.forEach(h => h({ data } as MessageEvent))
    },
    _handlers: handlers,
  }
}

// Mock MessageChannel - wires two ports together
function createMockMessageChannel() {
  const port1 = createMockMessagePort()
  const port2 = createMockMessagePort()

  // Wire ports together
  port1.postMessage = vi.fn((data: any) => {
    setTimeout(() => port2._emit(data), 0)
  })
  port2.postMessage = vi.fn((data: any) => {
    setTimeout(() => port1._emit(data), 0)
  })

  return { port1, port2 }
}

describe('createResponder', () => {
  it('should respond to valid requests', async () => {
    const port = createMockMessagePort()
    const callback = vi.fn().mockReturnValue('result')

    createResponder(port, callback)

    // Simulate incoming request
    port._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: { test: 'data' },
    })

    await flushPromises()

    expect(callback).toHaveBeenCalledWith({
      [$MESSENGER_REQUEST]: 1,
      payload: { test: 'data' },
    })
    // Worker-style postMessage is called with (message, transferables)
    expect(port.postMessage).toHaveBeenCalledWith(
      {
        [$MESSENGER_RESPONSE]: 1,
        payload: 'result',
      },
      [],
    )
  })

  it('should send error response when callback throws', async () => {
    const port = createMockMessagePort()
    const error = new Error('test error')
    const callback = vi.fn().mockImplementation(() => {
      throw error
    })

    createResponder(port, callback)

    port._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {},
    })

    await flushPromises()

    expect(port.postMessage).toHaveBeenCalledWith(
      {
        [$MESSENGER_ERROR]: 1,
        error,
      },
      undefined,
    )
  })

  it('should ignore non-request messages', () => {
    const port = createMockMessagePort()
    const callback = vi.fn()

    createResponder(port, callback)

    port._emit({ random: 'data' })
    port._emit({ [$MESSENGER_RESPONSE]: 1, payload: 'response' })

    expect(callback).not.toHaveBeenCalled()
  })

  it('should call start() on MessagePort if available', () => {
    const port = createMockMessagePort()

    createResponder(port, vi.fn())

    expect(port.start).toHaveBeenCalled()
  })
})

describe('expose', () => {
  it('should handle init request and then RPC requests', async () => {
    const port = createMockMessagePort()
    const factory = vi.fn(() => ({
      greet: (name: string) => `Hello, ${name}!`,
    }))

    expose(factory, { to: port })

    // First, send init request
    port._emit({
      [$MESSENGER_REQUEST]: 0,
      payload: {
        [$MESSENGER_INIT]: true,
        args: [],
      },
    })

    await flushPromises()

    // Factory should have been called
    expect(factory).toHaveBeenCalled()

    // Init response should have been sent
    expect(port.postMessage).toHaveBeenCalledWith(
      {
        [$MESSENGER_RESPONSE]: 0,
        payload: undefined,
      },
      [],
    )

    // Now send RPC request
    port._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['greet'],
        args: ['World'],
      },
    })

    await flushPromises()

    expect(port.postMessage).toHaveBeenCalledWith(
      {
        [$MESSENGER_RESPONSE]: 1,
        payload: 'Hello, World!',
      },
      [],
    )
  })

  it('should pass constructor args to factory', async () => {
    const port = createMockMessagePort()
    const factory = vi.fn((config: { prefix: string }) => ({
      greet: (name: string) => `${config.prefix} ${name}!`,
    }))

    expose(factory, { to: port })

    // Send init with args
    port._emit({
      [$MESSENGER_REQUEST]: 0,
      payload: {
        [$MESSENGER_INIT]: true,
        args: [{ prefix: 'Welcome,' }],
      },
    })

    await flushPromises()

    expect(factory).toHaveBeenCalledWith({ prefix: 'Welcome,' })
  })

  it('should handle async factory', async () => {
    const port = createMockMessagePort()
    const factory = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      return {
        getValue: () => 42,
      }
    })

    expose(factory, { to: port })

    // Send init
    port._emit({
      [$MESSENGER_REQUEST]: 0,
      payload: {
        [$MESSENGER_INIT]: true,
        args: [],
      },
    })

    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(factory).toHaveBeenCalled()
  })

  it('should handle nested method calls', async () => {
    const port = createMockMessagePort()

    expose(
      () => ({
        user: {
          profile: {
            getName: () => 'John Doe',
          },
        },
      }),
      { to: port },
    )

    // Init first
    port._emit({
      [$MESSENGER_REQUEST]: 0,
      payload: { [$MESSENGER_INIT]: true, args: [] },
    })
    await flushPromises()

    // Then call nested method
    port._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['user', 'profile', 'getName'],
        args: [],
      },
    })

    await flushPromises()

    expect(port.postMessage).toHaveBeenLastCalledWith(
      {
        [$MESSENGER_RESPONSE]: 1,
        payload: 'John Doe',
      },
      [],
    )
  })

  it('should error if RPC called before init', async () => {
    const port = createMockMessagePort()

    expose(() => ({ test: vi.fn() }), { to: port })

    // Send RPC without init
    port._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['test'],
        args: [],
      },
    })

    await flushPromises()

    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        [$MESSENGER_ERROR]: 1,
      }),
      undefined,
    )
  })
})

describe('rpc', () => {
  it('should create a proxy that sends RPC requests', async () => {
    const { port1, port2 } = createMockMessageChannel()

    // Set up responder on port2
    expose(() => ({ add: (a: number, b: number) => a + b }), { to: port2 })

    // Create RPC proxy on port1 (now async)
    const proxy = await rpc<{ add: (a: number, b: number) => number }>(port1)

    const result = await proxy.add(2, 3)
    expect(result).toBe(5)
  })

  it('should pass constructor args to worker', async () => {
    const { port1, port2 } = createMockMessageChannel()

    const factory = vi.fn((multiplier: number) => ({
      multiply: (a: number) => a * multiplier,
    }))

    expose(factory, { to: port2 })

    const proxy = await rpc<{ multiply: (a: number) => number }>(port1, [10])

    const result = await proxy.multiply(5)
    expect(result).toBe(50)
    expect(factory).toHaveBeenCalledWith(10)
  })

  it('should handle nested method calls via proxy', async () => {
    const { port1, port2 } = createMockMessageChannel()

    expose(
      () => ({
        math: {
          multiply: (a: number, b: number) => a * b,
        },
      }),
      { to: port2 },
    )

    const proxy = await rpc<{ math: { multiply: (a: number, b: number) => number } }>(port1)

    const result = await proxy.math.multiply(4, 5)
    expect(result).toBe(20)
  })

  it('should handle errors from remote methods', async () => {
    const { port1, port2 } = createMockMessageChannel()

    expose(
      () => ({
        failingMethod: () => {
          throw new Error('Remote error')
        },
      }),
      { to: port2 },
    )

    const proxy = await rpc<{ failingMethod: () => void }>(port1)

    await expect(proxy.failingMethod()).rejects.toThrow()
  })

  it('should handle multiple concurrent requests', async () => {
    const { port1, port2 } = createMockMessageChannel()

    expose(
      () => ({
        delayed: async (ms: number, value: string) => {
          await new Promise(resolve => setTimeout(resolve, ms))
          return value
        },
      }),
      { to: port2 },
    )

    const proxy = await rpc<{ delayed: (ms: number, value: string) => Promise<string> }>(port1)

    const [result1, result2, result3] = await Promise.all([
      proxy.delayed(30, 'first'),
      proxy.delayed(10, 'second'),
      proxy.delayed(20, 'third'),
    ])

    expect(result1).toBe('first')
    expect(result2).toBe('second')
    expect(result3).toBe('third')
  })
})

describe('Window vs Worker handling', () => {
  it('should use targetOrigin "*" for Window-like objects', async () => {
    const windowLike = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      closed: false,
    }

    expose(() => ({ test: () => 'ok' }), { to: windowLike as any })

    // Send init
    windowLike.addEventListener.mock.calls[0]![1]({
      data: {
        [$MESSENGER_REQUEST]: 0,
        payload: { [$MESSENGER_INIT]: true, args: [] },
      },
    } as MessageEvent)

    await flushPromises()

    // Send RPC
    windowLike.addEventListener.mock.calls[0]![1]({
      data: {
        [$MESSENGER_REQUEST]: 1,
        payload: {
          [$MESSENGER_RPC_REQUEST]: true,
          topics: ['test'],
          args: [],
        },
      },
    } as MessageEvent)

    await flushPromises()

    // Window-style postMessage should include '*' as second argument
    expect(windowLike.postMessage).toHaveBeenLastCalledWith(expect.any(Object), '*', [])
  })

  it('should not use targetOrigin for Worker-like objects', async () => {
    const workerLike = createMockMessagePort()

    expose(() => ({ test: () => 'ok' }), { to: workerLike })

    // Init first
    workerLike._emit({
      [$MESSENGER_REQUEST]: 0,
      payload: { [$MESSENGER_INIT]: true, args: [] },
    })
    await flushPromises()

    // Then RPC
    workerLike._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['test'],
        args: [],
      },
    })

    await flushPromises()

    // Worker-style postMessage is called with (message, transferables)
    expect(workerLike.postMessage).toHaveBeenLastCalledWith(expect.any(Object), [])
  })
})

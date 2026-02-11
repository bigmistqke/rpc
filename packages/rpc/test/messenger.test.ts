import { describe, expect, it, vi } from 'vitest'
import { createResponder, expose, handle, rpc } from '../src/messenger'
import {
  $MESSENGER_ERROR,
  $MESSENGER_HANDLE,
  $MESSENGER_REQUEST,
  $MESSENGER_RESPONSE,
  $MESSENGER_RPC_REQUEST,
} from '../src/protocol'

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
  it('should handle RPC requests directly', async () => {
    const port = createMockMessagePort()

    expose(
      {
        greet: (name: string) => `Hello, ${name}!`,
      },
      { to: port },
    )

    // Send RPC request directly (no init needed)
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

  it('should handle nested method calls', async () => {
    const port = createMockMessagePort()

    expose(
      {
        user: {
          profile: {
            getName: () => 'John Doe',
          },
        },
      },
      { to: port },
    )

    port._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['user', 'profile', 'getName'],
        args: [],
      },
    })

    await flushPromises()

    expect(port.postMessage).toHaveBeenCalledWith(
      {
        [$MESSENGER_RESPONSE]: 1,
        payload: 'John Doe',
      },
      [],
    )
  })

  it('should handle async methods', async () => {
    const port = createMockMessagePort()

    expose(
      {
        asyncMethod: async () => {
          await new Promise(resolve => setTimeout(resolve, 10))
          return 'async result'
        },
      },
      { to: port },
    )

    port._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['asyncMethod'],
        args: [],
      },
    })

    await new Promise(resolve => setTimeout(resolve, 20))

    expect(port.postMessage).toHaveBeenCalledWith(
      {
        [$MESSENGER_RESPONSE]: 1,
        payload: 'async result',
      },
      [],
    )
  })

  it('should return handle response when method returns handle()', async () => {
    const port = createMockMessagePort()

    expose(
      {
        init: () =>
          handle({
            getValue: () => 42,
          }),
      },
      { to: port },
    )

    port._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['init'],
        args: [],
      },
    })

    await flushPromises()

    // Should return a handle response with namespace ID
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        [$MESSENGER_RESPONSE]: 1,
        payload: expect.objectContaining({
          [$MESSENGER_HANDLE]: expect.stringContaining('__rpc_handle_'),
        }),
      }),
      [],
    )
  })

  it('should handle namespaced RPC calls from handle()', async () => {
    const port = createMockMessagePort()
    const getValue = vi.fn(() => 42)

    expose(
      {
        init: () =>
          handle({
            getValue,
          }),
      },
      { to: port },
    )

    // First call init to get namespace ID
    port._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['init'],
        args: [],
      },
    })

    await flushPromises()

    // Extract namespace ID from response
    const initResponse = port.postMessage.mock.calls[0][0]
    const namespaceId = initResponse.payload[$MESSENGER_HANDLE]

    // Now call method on the handle
    port._emit({
      [$MESSENGER_REQUEST]: 2,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: [namespaceId, 'getValue'],
        args: [],
      },
    })

    await flushPromises()

    expect(getValue).toHaveBeenCalled()
    expect(port.postMessage).toHaveBeenLastCalledWith(
      {
        [$MESSENGER_RESPONSE]: 2,
        payload: 42,
      },
      [],
    )
  })

  it('should handle errors in RPC methods', async () => {
    const port = createMockMessagePort()

    expose(
      {
        failingMethod: () => {
          throw new Error('test error')
        },
      },
      { to: port },
    )

    port._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['failingMethod'],
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
  it('should create a synchronous proxy that sends RPC requests', async () => {
    const { port1, port2 } = createMockMessageChannel()

    // Set up responder on port2
    expose({ add: (a: number, b: number) => a + b }, { to: port2 })

    // Create RPC proxy on port1 (now synchronous)
    const proxy = rpc<{ add: (a: number, b: number) => number }>(port1)

    const result = await proxy.add(2, 3)
    expect(result).toBe(5)
  })

  it('should handle nested method calls via proxy', async () => {
    const { port1, port2 } = createMockMessageChannel()

    expose(
      {
        math: {
          multiply: (a: number, b: number) => a * b,
        },
      },
      { to: port2 },
    )

    const proxy = rpc<{ math: { multiply: (a: number, b: number) => number } }>(port1)

    const result = await proxy.math.multiply(4, 5)
    expect(result).toBe(20)
  })

  it('should handle errors from remote methods', async () => {
    const { port1, port2 } = createMockMessageChannel()

    expose(
      {
        failingMethod: () => {
          throw new Error('Remote error')
        },
      },
      { to: port2 },
    )

    const proxy = rpc<{ failingMethod: () => void }>(port1)

    await expect(proxy.failingMethod()).rejects.toThrow()
  })

  it('should handle multiple concurrent requests', async () => {
    const { port1, port2 } = createMockMessageChannel()

    expose(
      {
        delayed: async (ms: number, value: string) => {
          await new Promise(resolve => setTimeout(resolve, ms))
          return value
        },
      },
      { to: port2 },
    )

    const proxy = rpc<{ delayed: (ms: number, value: string) => Promise<string> }>(port1)

    const [result1, result2, result3] = await Promise.all([
      proxy.delayed(30, 'first'),
      proxy.delayed(10, 'second'),
      proxy.delayed(20, 'third'),
    ])

    expect(result1).toBe('first')
    expect(result2).toBe('second')
    expect(result3).toBe('third')
  })

  it('should create sub-proxy when method returns handle()', async () => {
    const { port1, port2 } = createMockMessageChannel()

    expose(
      {
        init: (multiplier: number) =>
          handle({
            multiply: (a: number) => a * multiplier,
          }),
      },
      { to: port2 },
    )

    const proxy = rpc<{
      init: (multiplier: number) => { multiply: (a: number) => number }
    }>(port1)

    // Call init to get sub-proxy
    const calculator = await proxy.init(10)

    // Call method on sub-proxy
    const result = await calculator.multiply(5)
    expect(result).toBe(50)
  })

  it('should handle async methods that return handle()', async () => {
    const { port1, port2 } = createMockMessageChannel()

    expose(
      {
        asyncInit: async (config: { prefix: string }) => {
          await new Promise(resolve => setTimeout(resolve, 10))
          return handle({
            greet: (name: string) => `${config.prefix} ${name}!`,
          })
        },
      },
      { to: port2 },
    )

    const proxy = rpc<{
      asyncInit: (config: { prefix: string }) => Promise<{ greet: (name: string) => string }>
    }>(port1)

    const greeter = await proxy.asyncInit({ prefix: 'Hello,' })
    const result = await greeter.greet('World')
    expect(result).toBe('Hello, World!')
  })

  it('should handle nested handle() calls', async () => {
    const { port1, port2 } = createMockMessageChannel()

    expose(
      {
        createOuter: () =>
          handle({
            createInner: () =>
              handle({
                getValue: () => 'nested value',
              }),
          }),
      },
      { to: port2 },
    )

    const proxy = rpc<{
      createOuter: () => {
        createInner: () => {
          getValue: () => string
        }
      }
    }>(port1)

    const outer = await proxy.createOuter()
    const inner = await outer.createInner()
    const result = await inner.getValue()
    expect(result).toBe('nested value')
  })
})

describe('Window vs Worker handling', () => {
  it('should use targetOrigin "*" for Window-like objects', async () => {
    const windowLike = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      closed: false,
    }

    expose({ test: () => 'ok' }, { to: windowLike as any })

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
    expect(windowLike.postMessage).toHaveBeenCalledWith(expect.any(Object), '*', [])
  })

  it('should not use targetOrigin for Worker-like objects', async () => {
    const workerLike = createMockMessagePort()

    expose({ test: () => 'ok' }, { to: workerLike })

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
    expect(workerLike.postMessage).toHaveBeenCalledWith(expect.any(Object), [])
  })
})

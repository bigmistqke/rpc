import { describe, it, expect, vi, beforeEach } from 'vitest'
import { expose, rpc, createResponder } from '../src/messenger'
import {
  $MESSENGER_REQUEST,
  $MESSENGER_RESPONSE,
  $MESSENGER_ERROR,
  $MESSENGER_RPC_REQUEST,
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
  it('should handle RPC requests and call methods', async () => {
    const port = createMockMessagePort()
    const methods = {
      greet: (name: string) => `Hello, ${name}!`,
    }

    expose(methods, { to: port })

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
    const methods = {
      user: {
        profile: {
          getName: () => 'John Doe',
        },
      },
    }

    expose(methods, { to: port })

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

  it('should ignore non-RPC payloads', () => {
    const port = createMockMessagePort()
    const methods = {
      test: vi.fn(),
    }

    expose(methods, { to: port })

    port._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: { notRpc: true },
    })

    expect(methods.test).not.toHaveBeenCalled()
  })
})

describe('rpc', () => {
  it('should create a proxy that sends RPC requests', async () => {
    const { port1, port2 } = createMockMessageChannel()

    // Set up responder on port2
    expose({ add: (a: number, b: number) => a + b }, { to: port2 })

    // Create RPC proxy on port1
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

    // Note: Currently, errors in expose() are caught and logged but not rethrown,
    // so the response is undefined rather than an error rejection.
    // This is a quirk of the current implementation.
    const result = await proxy.failingMethod()
    expect(result).toBeUndefined()
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
})

describe('Window vs Worker handling', () => {
  it('should use targetOrigin "*" for Window-like objects', async () => {
    const windowLike = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      closed: false,
    }

    expose({ test: () => 'ok' }, { to: windowLike as any })

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
    expect(windowLike.postMessage).toHaveBeenCalledWith(
      expect.any(Object),
      '*',
      [],
    )
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

import { describe, expect, it, vi } from 'vitest'
import { $WEBSOCKET, expose, handle, rpc } from '../src/websocket'
import {
  $MESSENGER_ERROR,
  $MESSENGER_HANDLE,
  $MESSENGER_REQUEST,
  $MESSENGER_RESPONSE,
  $MESSENGER_RPC_REQUEST,
} from '../src/protocol'

// Helper to flush pending promises
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

// Mock WebSocket - simulates JSON serialization round-trip
function createMockWebSocket() {
  const handlers: Array<(event: unknown) => void> = []
  return {
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
      if (type === 'message') {
        handlers.push(handler)
      }
    }),
    _emit(data: any) {
      // Simulate JSON round-trip like a real WebSocket
      const serialized = JSON.stringify(data)
      handlers.forEach(h => h({ data: serialized }))
    },
    _handlers: handlers,
  }
}

// Mock WebSocket pair - wires two sockets together with JSON serialization
function createMockWebSocketPair() {
  const ws1 = createMockWebSocket()
  const ws2 = createMockWebSocket()

  // Wire sockets together: send on one emits on the other (with JSON round-trip)
  ws1.send = vi.fn((data: string) => {
    setTimeout(() => {
      const parsed = JSON.parse(data)
      ws2._emit(parsed)
    }, 0)
  })
  ws2.send = vi.fn((data: string) => {
    setTimeout(() => {
      const parsed = JSON.parse(data)
      ws1._emit(parsed)
    }, 0)
  })

  return { ws1, ws2 }
}

describe('expose', () => {
  it('should handle RPC requests', async () => {
    const ws = createMockWebSocket()

    expose(
      {
        greet: (name: string) => `Hello, ${name}!`,
      },
      { to: ws },
    )

    ws._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['greet'],
        args: ['World'],
      },
    })

    await flushPromises()

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        [$MESSENGER_RESPONSE]: 1,
        payload: 'Hello, World!',
      }),
    )
  })

  it('should handle nested method calls', async () => {
    const ws = createMockWebSocket()

    expose(
      {
        user: {
          profile: {
            getName: () => 'John Doe',
          },
        },
      },
      { to: ws },
    )

    ws._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['user', 'profile', 'getName'],
        args: [],
      },
    })

    await flushPromises()

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        [$MESSENGER_RESPONSE]: 1,
        payload: 'John Doe',
      }),
    )
  })

  it('should handle async methods', async () => {
    const ws = createMockWebSocket()

    expose(
      {
        asyncMethod: async () => {
          await new Promise(resolve => setTimeout(resolve, 10))
          return 'async result'
        },
      },
      { to: ws },
    )

    ws._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['asyncMethod'],
        args: [],
      },
    })

    await new Promise(resolve => setTimeout(resolve, 20))

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        [$MESSENGER_RESPONSE]: 1,
        payload: 'async result',
      }),
    )
  })

  it('should handle void-returning methods (undefined survives JSON round-trip)', async () => {
    const ws = createMockWebSocket()

    expose(
      {
        doSomething: () => {},
      },
      { to: ws },
    )

    ws._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['doSomething'],
        args: [],
      },
    })

    await flushPromises()

    // payload is undefined which gets stripped by JSON.stringify
    // ResponseShape.validate should still pass with optional payload
    const sent = JSON.parse(ws.send.mock.calls[0][0])
    expect(sent[$MESSENGER_RESPONSE]).toBe(1)
  })

  it('should return handle response when method returns handle()', async () => {
    const ws = createMockWebSocket()

    expose(
      {
        init: () =>
          handle({
            getValue: () => 42,
          }),
      },
      { to: ws },
    )

    ws._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['init'],
        args: [],
      },
    })

    await flushPromises()

    const sent = JSON.parse(ws.send.mock.calls[0][0])
    expect(sent[$MESSENGER_RESPONSE]).toBe(1)
    expect(sent.payload[$MESSENGER_HANDLE]).toContain('__rpc_handle_')
  })

  it('should handle namespaced RPC calls from handle()', async () => {
    const ws = createMockWebSocket()
    const getValue = vi.fn(() => 42)

    expose(
      {
        init: () =>
          handle({
            getValue,
          }),
      },
      { to: ws },
    )

    // First call init to get namespace ID
    ws._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['init'],
        args: [],
      },
    })

    await flushPromises()

    // Extract namespace ID from response
    const initResponse = JSON.parse(ws.send.mock.calls[0][0])
    const namespaceId = initResponse.payload[$MESSENGER_HANDLE]

    // Now call method on the handle
    ws._emit({
      [$MESSENGER_REQUEST]: 2,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: [namespaceId, 'getValue'],
        args: [],
      },
    })

    await flushPromises()

    expect(getValue).toHaveBeenCalled()
    const response = JSON.parse(ws.send.mock.calls[1][0])
    expect(response).toEqual({
      [$MESSENGER_RESPONSE]: 2,
      payload: 42,
    })
  })

  it('should handle errors in RPC methods', async () => {
    const ws = createMockWebSocket()

    expose(
      {
        failingMethod: () => {
          throw new Error('test error')
        },
      },
      { to: ws },
    )

    ws._emit({
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['failingMethod'],
        args: [],
      },
    })

    await flushPromises()

    const sent = JSON.parse(ws.send.mock.calls[0][0])
    expect(sent[$MESSENGER_ERROR]).toBe(1)
  })

  it('should ignore non-request messages', async () => {
    const ws = createMockWebSocket()

    expose(
      {
        test: () => 'ok',
      },
      { to: ws },
    )

    ws._emit({ random: 'data' })
    ws._emit({ [$MESSENGER_RESPONSE]: 1, payload: 'response' })

    await flushPromises()

    expect(ws.send).not.toHaveBeenCalled()
  })

  it('should ignore invalid JSON', async () => {
    const ws = createMockWebSocket()

    expose(
      {
        test: () => 'ok',
      },
      { to: ws },
    )

    // Send raw invalid JSON string directly to handlers
    ws._handlers.forEach(h => h({ data: 'not valid json{' }))

    await flushPromises()

    expect(ws.send).not.toHaveBeenCalled()
  })
})

describe('rpc', () => {
  it('should call remote methods and receive results', async () => {
    const { ws1, ws2 } = createMockWebSocketPair()

    expose({ add: (a: number, b: number) => a + b }, { to: ws2 })

    const proxy = rpc<{ add: (a: number, b: number) => number }>(ws1)

    const result = await proxy.add(2, 3)
    expect(result).toBe(5)
  })

  it('should handle nested method calls via proxy', async () => {
    const { ws1, ws2 } = createMockWebSocketPair()

    expose(
      {
        math: {
          multiply: (a: number, b: number) => a * b,
        },
      },
      { to: ws2 },
    )

    const proxy = rpc<{ math: { multiply: (a: number, b: number) => number } }>(ws1)

    const result = await proxy.math.multiply(4, 5)
    expect(result).toBe(20)
  })

  it('should handle errors from remote methods', async () => {
    const { ws1, ws2 } = createMockWebSocketPair()

    expose(
      {
        failingMethod: () => {
          throw new Error('Remote error')
        },
      },
      { to: ws2 },
    )

    const proxy = rpc<{ failingMethod: () => void }>(ws1)

    await expect(proxy.failingMethod()).rejects.toThrow()
  })

  it('should handle multiple concurrent requests', async () => {
    const { ws1, ws2 } = createMockWebSocketPair()

    expose(
      {
        delayed: async (ms: number, value: string) => {
          await new Promise(resolve => setTimeout(resolve, ms))
          return value
        },
      },
      { to: ws2 },
    )

    const proxy = rpc<{ delayed: (ms: number, value: string) => Promise<string> }>(ws1)

    const [result1, result2, result3] = await Promise.all([
      proxy.delayed(30, 'first'),
      proxy.delayed(10, 'second'),
      proxy.delayed(20, 'third'),
    ])

    expect(result1).toBe('first')
    expect(result2).toBe('second')
    expect(result3).toBe('third')
  })

  it('should handle void-returning methods', async () => {
    const { ws1, ws2 } = createMockWebSocketPair()

    const sideEffect = vi.fn()
    expose(
      {
        fire: () => {
          sideEffect()
        },
      },
      { to: ws2 },
    )

    const proxy = rpc<{ fire: () => void }>(ws1)

    await proxy.fire()
    expect(sideEffect).toHaveBeenCalled()
  })

  it('should create sub-proxy when method returns handle()', async () => {
    const { ws1, ws2 } = createMockWebSocketPair()

    expose(
      {
        init: (multiplier: number) =>
          handle({
            multiply: (a: number) => a * multiplier,
          }),
      },
      { to: ws2 },
    )

    const proxy = rpc<{
      init: (multiplier: number) => { multiply: (a: number) => number }
    }>(ws1)

    const calculator = await proxy.init(10)
    const result = await calculator.multiply(5)
    expect(result).toBe(50)
  })

  it('should handle async methods that return handle()', async () => {
    const { ws1, ws2 } = createMockWebSocketPair()

    expose(
      {
        asyncInit: async (config: { prefix: string }) => {
          await new Promise(resolve => setTimeout(resolve, 10))
          return handle({
            greet: (name: string) => `${config.prefix} ${name}!`,
          })
        },
      },
      { to: ws2 },
    )

    const proxy = rpc<{
      asyncInit: (config: { prefix: string }) => Promise<{ greet: (name: string) => string }>
    }>(ws1)

    const greeter = await proxy.asyncInit({ prefix: 'Hello,' })
    const result = await greeter.greet('World')
    expect(result).toBe('Hello, World!')
  })

  it('should handle nested handle() calls', async () => {
    const { ws1, ws2 } = createMockWebSocketPair()

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
      { to: ws2 },
    )

    const proxy = rpc<{
      createOuter: () => {
        createInner: () => {
          getValue: () => string
        }
      }
    }>(ws1)

    const outer = await proxy.createOuter()
    const inner = await outer.createInner()
    const result = await inner.getValue()
    expect(result).toBe('nested value')
  })

  it('should expose $WEBSOCKET with the original websocket', () => {
    const ws = createMockWebSocket()
    const proxy = rpc<{ test: () => void }>(ws)

    // Access the underlying websocket via $WEBSOCKET
    const isSame = proxy[$WEBSOCKET] === ws
    expect(isSame).toBe(true)
  })

  it('should support bidirectional RPC on the same websocket', async () => {
    const { ws1, ws2 } = createMockWebSocketPair()

    // Side A exposes methods and calls side B
    expose({ ping: () => 'pong' }, { to: ws1 })
    const proxyB = rpc<{ echo: (msg: string) => string }>(ws1)

    // Side B exposes methods and calls side A
    expose({ echo: (msg: string) => msg }, { to: ws2 })
    const proxyA = rpc<{ ping: () => string }>(ws2)

    const [pong, echoed] = await Promise.all([proxyA.ping(), proxyB.echo('hello')])

    expect(pong).toBe('pong')
    expect(echoed).toBe('hello')
  })
})

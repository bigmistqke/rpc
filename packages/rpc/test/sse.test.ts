import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $MESSENGER_REQUEST, $MESSENGER_RPC_REQUEST } from '../src/protocol'
import { expose, isSSEResponse, Payload, rpc } from '../src/server-send-events/index'

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  handlers: Map<string, ((event: { data: string }) => void)[]> = new Map()

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: (event: { data: string }) => void) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, [])
    }
    this.handlers.get(type)!.push(handler)
  }

  removeEventListener(type: string, handler: (event: { data: string }) => void) {
    const handlers = this.handlers.get(type)
    if (handlers) {
      const index = handlers.indexOf(handler)
      if (index !== -1) handlers.splice(index, 1)
    }
  }

  dispatchEvent(type: string, data: any) {
    const handlers = this.handlers.get(type) || []
    handlers.forEach(h => h({ data: JSON.stringify(data) }))
  }

  close() {
    const index = MockEventSource.instances.indexOf(this)
    if (index !== -1) MockEventSource.instances.splice(index, 1)
  }
}

describe('isSSEResponse', () => {
  it('should return true for requests with SSE response header', () => {
    const request = new Request('http://example.com', {
      headers: { RPC_SSE_RESPONSE: '1' },
    })
    expect(isSSEResponse({ request })).toBe(true)
  })

  it('should return false for requests without SSE response header', () => {
    const request = new Request('http://example.com')
    expect(isSSEResponse({ request })).toBe(false)
  })
})

describe('Payload', () => {
  describe('validate', () => {
    it('should validate correct payloads', () => {
      expect(Payload.validate({ topics: ['method'], args: [] })).toBe(true)
      expect(Payload.validate({ topics: ['a', 'b'], args: [1, 'test'] })).toBe(true)
    })

    it('should reject invalid payloads', () => {
      expect(Payload.validate({})).toBe(false)
      expect(Payload.validate({ topics: 'not-array', args: [] })).toBe(false)
    })
  })

  describe('create', () => {
    it('should create valid payloads', () => {
      const payload = Payload.create(['test'], [1, 2])
      expect(payload).toEqual({ topics: ['test'], args: [1, 2] })
    })
  })
})

describe('rpc', () => {
  describe('create', () => {
    it('should return proxy, closed state, onClose, and response', () => {
      const { create } = rpc<{ test: () => void }>()
      const [proxy, { closed, onClose, response }] = create()

      expect(proxy).toBeDefined()
      expect(closed).toBe(false)
      expect(typeof onClose).toBe('function')
      expect(response).toBeInstanceOf(Response)
    })

    it('should create Response with SSE headers', () => {
      const { create } = rpc<{}>()
      const [, { response }] = create()

      expect(response.headers.get('Content-Type')).toBe('text/event-stream')
      expect(response.headers.get('Cache-Control')).toBe('no-cache')
      expect(response.headers.get('Connection')).toBe('keep-alive')
    })

    it('should throw when calling proxy after stream is closed', async () => {
      const { create } = rpc<{ test: () => void }>()
      const [proxy, { response }] = create()

      // Cancel the stream to close it
      const reader = response.body!.getReader()
      await reader.cancel()

      await expect(proxy.test()).rejects.toThrow('[rpc/sse] Stream is closed.')
    })

    it('should call onClose handlers when stream is cancelled', async () => {
      const { create } = rpc<{}>()
      const [, { response, onClose }] = create()

      const handler = vi.fn()
      onClose(handler)

      const reader = response.body!.getReader()
      await reader.cancel()

      expect(handler).toHaveBeenCalled()
    })

    it('should allow unsubscribing from onClose', async () => {
      const { create } = rpc<{}>()
      const [, { response, onClose }] = create()

      const handler = vi.fn()
      const unsubscribe = onClose(handler)
      unsubscribe()

      const reader = response.body!.getReader()
      await reader.cancel()

      expect(handler).not.toHaveBeenCalled()
    })

    it('should send requests as SSE data format', async () => {
      const { create } = rpc<{ greet: (name: string) => string }>()
      const [proxy, { response }] = create()

      // Start reading the response body
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()

      // Make a request (won't resolve without handleAnswer)
      const resultPromise = proxy.greet('World')

      // Read the output
      const { value } = await reader.read()
      const text = decoder.decode(value)

      // Should be in SSE format: "data: {...}\n\n"
      expect(text).toMatch(/^data: .+\n\n$/)

      // Parse the JSON
      const jsonStr = text.replace('data: ', '').trim()
      const data = JSON.parse(jsonStr)

      expect(data[$MESSENGER_REQUEST]).toBeDefined()
      expect(data.payload[$MESSENGER_RPC_REQUEST]).toBe(true)
      expect(data.payload.topics).toEqual(['greet'])
      expect(data.payload.args).toEqual(['World'])

      reader.releaseLock()
    })
  })

  describe('handleAnswer', () => {
    it('should resolve pending promises when answer is received', async () => {
      const { create, handleAnswer } = rpc<{ test: () => string }>()
      const [proxy, { response }] = create()

      // Read the request to get the ID
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()

      const resultPromise = proxy.test()

      const { value } = await reader.read()
      const text = decoder.decode(value)
      const jsonStr = text.replace('data: ', '').trim()
      const requestData = JSON.parse(jsonStr)
      const requestId = requestData[$MESSENGER_REQUEST]

      // Simulate response via handleAnswer
      const answerRequest = new Request('http://example.com', {
        method: 'POST',
        headers: { RPC_SSE_RESPONSE: requestId.toString() },
        body: JSON.stringify({ payload: 'test result' }),
      })

      await handleAnswer({ request: answerRequest })

      const result = await resultPromise
      expect(result).toBe('test result')

      reader.releaseLock()
    })

    it('should return empty Response', async () => {
      const { handleAnswer } = rpc<{}>()

      const request = new Request('http://example.com', {
        method: 'POST',
        headers: { RPC_SSE_RESPONSE: '1' },
        body: JSON.stringify({ payload: 'test' }),
      })

      const response = await handleAnswer({ request })
      expect(response).toBeInstanceOf(Response)
    })

    it('should ignore requests without SSE response header', async () => {
      const { create, handleAnswer } = rpc<{ test: () => string }>()
      const [proxy] = create()

      const request = new Request('http://example.com', {
        method: 'POST',
        body: JSON.stringify({ payload: 'test' }),
      })

      // Should not throw and should return Response
      const response = await handleAnswer({ request })
      expect(response).toBeInstanceOf(Response)
    })
  })
})

describe('expose', () => {
  const originalEventSource = globalThis.EventSource
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    MockEventSource.instances = []
    ;(globalThis as any).EventSource = MockEventSource
    globalThis.fetch = vi.fn().mockResolvedValue(new Response())
  })

  afterEach(() => {
    ;(globalThis as any).EventSource = originalEventSource
    globalThis.fetch = originalFetch
  })

  it('should create EventSource connection', () => {
    expose('http://example.com/sse', { test: () => 'ok' })

    expect(MockEventSource.instances.length).toBe(1)
    expect(MockEventSource.instances[0]!.url).toBe('http://example.com/sse')
  })

  it('should handle incoming RPC requests', async () => {
    const methods = {
      greet: (name: string) => `Hello, ${name}!`,
    }

    expose('http://example.com/sse', methods)

    const eventSource = MockEventSource.instances[0]!

    // Simulate incoming RPC request
    eventSource.dispatchEvent('message', {
      [$MESSENGER_REQUEST]: 42,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['greet'],
        args: ['World'],
      },
    })

    // Wait for async processing
    await new Promise(resolve => setTimeout(resolve, 10))

    // Should have made fetch call with response
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://example.com/sse',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          RPC_SSE_RESPONSE: '42',
        }),
      }),
    )

    // Verify the body contains the result
    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]!
    const body = JSON.parse(fetchCall[1]!.body as string)
    expect(body).toEqual({ payload: 'Hello, World!' })
  })

  it('should handle nested method calls', async () => {
    const methods = {
      math: {
        add: (a: number, b: number) => a + b,
      },
    }

    expose('http://example.com/sse', methods)

    const eventSource = MockEventSource.instances[0]!

    eventSource.dispatchEvent('message', {
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['math', 'add'],
        args: [5, 3],
      },
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]!
    const body = JSON.parse(fetchCall[1]!.body as string)
    expect(body).toEqual({ payload: 8 })
  })

  it('should handle async methods', async () => {
    const methods = {
      asyncMethod: async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return 'async result'
      },
    }

    expose('http://example.com/sse', methods)

    const eventSource = MockEventSource.instances[0]!

    eventSource.dispatchEvent('message', {
      [$MESSENGER_REQUEST]: 1,
      payload: {
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['asyncMethod'],
        args: [],
      },
    })

    await new Promise(resolve => setTimeout(resolve, 20))

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]!
    const body = JSON.parse(fetchCall[1]!.body as string)
    expect(body).toEqual({ payload: 'async result' })
  })

  it('should ignore non-RPC messages', async () => {
    expose('http://example.com/sse', { test: () => 'ok' })

    const eventSource = MockEventSource.instances[0]!

    // Invalid message format
    eventSource.dispatchEvent('message', { random: 'data' })

    await new Promise(resolve => setTimeout(resolve, 10))

    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

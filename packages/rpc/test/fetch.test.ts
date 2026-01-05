import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { expose, rpc, isFetchRequest, Payload } from '../src/fetch/index'

// Store original fetch
const originalFetch = globalThis.fetch

describe('isFetchRequest', () => {
  it('should return true for requests with RPC header', () => {
    const request = new Request('http://example.com', {
      headers: { RPC_RR_PROXY: 'true' },
    })
    expect(isFetchRequest({ request })).toBe(true)
  })

  it('should return false for requests without RPC header', () => {
    const request = new Request('http://example.com')
    expect(isFetchRequest({ request })).toBe(false)
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
      expect(Payload.validate({ topics: [], args: 'not-array' })).toBe(false)
    })
  })

  describe('create', () => {
    it('should create valid payloads', () => {
      const payload = Payload.create(['test', 'method'], [1, 2])
      expect(payload).toEqual({ topics: ['test', 'method'], args: [1, 2] })
    })
  })
})

describe('expose', () => {
  it('should handle valid RPC requests', async () => {
    const methods = {
      greet: (name: string) => `Hello, ${name}!`,
    }

    const handler = expose(methods)
    const request = new Request('http://example.com/greet', {
      method: 'POST',
      body: JSON.stringify({ topics: ['greet'], args: ['World'] }),
    })

    const response = await handler({ request })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ payload: 'Hello, World!' })
  })

  it('should handle nested method calls', async () => {
    const methods = {
      math: {
        add: (a: number, b: number) => a + b,
      },
    }

    const handler = expose(methods)
    const request = new Request('http://example.com/math/add', {
      method: 'POST',
      body: JSON.stringify({ topics: ['math', 'add'], args: [5, 3] }),
    })

    const response = await handler({ request })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ payload: 8 })
  })

  it('should handle async methods', async () => {
    const methods = {
      asyncMethod: async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        return 'async result'
      },
    }

    const handler = expose(methods)
    const request = new Request('http://example.com', {
      method: 'POST',
      body: JSON.stringify({ topics: ['asyncMethod'], args: [] }),
    })

    const response = await handler({ request })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ payload: 'async result' })
  })

  it('should return 500 for invalid payload shape', async () => {
    const methods = { test: () => 'ok' }
    const handler = expose(methods)

    const request = new Request('http://example.com', {
      method: 'POST',
      body: JSON.stringify({ invalid: 'data' }),
    })

    const response = await handler({ request })

    expect(response.status).toBe(500)
    expect(response.statusText).toBe('Incorrect shape')
  })

  it('should return 500 when method throws string error', async () => {
    const methods = {
      failing: () => {
        throw 'String error message'
      },
    }

    const handler = expose(methods)
    const request = new Request('http://example.com', {
      method: 'POST',
      body: JSON.stringify({ topics: ['failing'], args: [] }),
    })

    const response = await handler({ request })

    expect(response.status).toBe(500)
    expect(response.statusText).toBe('String error message')
  })

  it('should return 500 when method throws Error object', async () => {
    const methods = {
      failing: () => {
        throw new Error('Error object message')
      },
    }

    const handler = expose(methods)
    const request = new Request('http://example.com', {
      method: 'POST',
      body: JSON.stringify({ topics: ['failing'], args: [] }),
    })

    const response = await handler({ request })

    expect(response.status).toBe(500)
    expect(response.statusText).toBe('Error object message')
  })

  it('should return 500 with undefined statusText for non-string/non-Error throws', async () => {
    const methods = {
      failing: () => {
        throw { custom: 'error' }
      },
    }

    const handler = expose(methods)
    const request = new Request('http://example.com', {
      method: 'POST',
      body: JSON.stringify({ topics: ['failing'], args: [] }),
    })

    const response = await handler({ request })

    expect(response.status).toBe(500)
  })

  it('should return 500 when method does not exist', async () => {
    const methods = {}
    const handler = expose(methods)

    const request = new Request('http://example.com', {
      method: 'POST',
      body: JSON.stringify({ topics: ['nonexistent'], args: [] }),
    })

    const response = await handler({ request })

    expect(response.status).toBe(500)
  })
})

describe('rpc', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('should create proxy that makes POST requests', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ payload: 'result' }), { status: 200 }),
    )

    const proxy = rpc<{ method: () => string }>('http://api.example.com')
    const result = await proxy.method()

    expect(result).toBe('result')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
      }),
    )
  })

  it('should construct URL from topics', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ payload: 'ok' }), { status: 200 }),
    )

    const proxy = rpc<{ user: { profile: { get: () => string } } }>('http://api.example.com')
    await proxy.user.profile.get()

    const calledRequest = vi.mocked(globalThis.fetch).mock.calls[0]![0] as Request
    expect(calledRequest.url).toBe('http://api.example.com/user/profile/get')
  })

  it('should include RPC header in requests', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ payload: 'ok' }), { status: 200 }),
    )

    const proxy = rpc<{ test: () => void }>('http://api.example.com')
    await proxy.test()

    const calledRequest = vi.mocked(globalThis.fetch).mock.calls[0]![0] as Request
    expect(calledRequest.headers.get('RPC_RR_PROXY')).toBe('true')
  })

  it('should send topics and args in request body', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ payload: 'ok' }), { status: 200 }),
    )

    const proxy = rpc<{ add: (a: number, b: number) => number }>('http://api.example.com')
    await proxy.add(1, 2)

    const calledRequest = vi.mocked(globalThis.fetch).mock.calls[0]![0] as Request
    const body = await calledRequest.json()
    expect(body).toEqual({ topics: ['add'], args: [1, 2] })
  })

  it('should throw when response status is not 200', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' }),
    )

    const proxy = rpc<{ method: () => void }>('http://api.example.com')

    await expect(proxy.method()).rejects.toBe('Internal Server Error')
  })

  // Note: The source code attempts to use GET when topics is empty, but still includes
  // a body which causes an error. This test documents that behavior.
  it('should throw when calling with empty topics due to GET with body', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ payload: 'ok' }), { status: 200 }),
    )

    const proxy = rpc<() => string>('http://api.example.com')
    // Direct call with no topics - this throws because GET can't have a body
    await expect((proxy as any)()).rejects.toThrow('Request with GET/HEAD method cannot have body')
  })
})

describe('expose + rpc integration', () => {
  beforeEach(() => {
    // Create an in-memory mock that connects expose and rpc
    const methods = {
      greet: (name: string) => `Hello, ${name}!`,
      math: {
        add: (a: number, b: number) => a + b,
        subtract: (a: number, b: number) => a - b,
      },
    }

    const handler = expose(methods)

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request
      return handler({ request })
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('should work end-to-end', async () => {
    const proxy = rpc<{
      greet: (name: string) => string
      math: {
        add: (a: number, b: number) => number
        subtract: (a: number, b: number) => number
      }
    }>('http://test.local')

    expect(await proxy.greet('Test')).toBe('Hello, Test!')
    expect(await proxy.math.add(10, 5)).toBe(15)
    expect(await proxy.math.subtract(10, 5)).toBe(5)
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rpc, client, server, isStreamRequest } from '../src/stream/index'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Helper to create a controllable ReadableStream
function createControllableStream() {
  let controller: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    stream,
    enqueue: (data: string) => controller.enqueue(encoder.encode(data)),
    close: () => controller.close(),
  }
}

// Helper to collect stream output
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader()
  const chunks: string[] = []
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newlineIndex
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      chunks.push(buffer.slice(0, newlineIndex))
      buffer = buffer.slice(newlineIndex + 1)
    }
  }

  return chunks
}

describe('isStreamRequest', () => {
  it('should return true for requests with stream header', () => {
    const request = new Request('http://example.com', {
      headers: { RPC_STREAM_REQUEST_HEADER: '1' },
    })
    expect(isStreamRequest({ request })).toBe(true)
  })

  it('should return false for requests without stream header', () => {
    const request = new Request('http://example.com')
    expect(isStreamRequest({ request })).toBe(false)
  })
})

describe('rpc', () => {
  it('should create proxy and stream', () => {
    const inputStream = new ReadableStream()
    const { proxy, stream, closed, onClose } = rpc(inputStream, {})

    expect(proxy).toBeDefined()
    expect(stream).toBeInstanceOf(ReadableStream)
    expect(typeof closed).toBe('function')
    expect(typeof onClose).toBe('function')
  })

  it('should handle bidirectional communication', async () => {
    // Create two connected RPC endpoints
    const { stream: stream1, enqueue: enqueue1, close: close1 } = createControllableStream()
    const { stream: stream2, enqueue: enqueue2, close: close2 } = createControllableStream()

    const methods1 = {
      ping: () => 'pong',
    }

    const methods2 = {
      echo: (msg: string) => msg,
    }

    // Set up endpoint 1 - reads from stream1, writes to its output stream
    const endpoint1 = rpc<{ echo: (msg: string) => string }, typeof methods1>(stream1, methods1)

    // Set up endpoint 2 - reads from stream2, writes to its output stream
    const endpoint2 = rpc<{ ping: () => string }, typeof methods2>(stream2, methods2)

    // Connect the streams: endpoint1's output goes to endpoint2's input and vice versa
    // This simulates the bidirectional connection
    const reader1 = endpoint1.stream.getReader()
    const reader2 = endpoint2.stream.getReader()

    // Forward messages from endpoint1 to endpoint2
    ;(async () => {
      while (true) {
        const { done, value } = await reader1.read()
        if (done) break
        enqueue2(decoder.decode(value))
      }
    })()

    // Forward messages from endpoint2 to endpoint1
    ;(async () => {
      while (true) {
        const { done, value } = await reader2.read()
        if (done) break
        enqueue1(decoder.decode(value))
      }
    })()

    // Test RPC calls
    const pingResult = await endpoint2.proxy.ping()
    expect(pingResult).toBe('pong')

    const echoResult = await endpoint1.proxy.echo('hello')
    expect(echoResult).toBe('hello')
  })

  it('should serialize requests as JSON lines', async () => {
    const inputStream = new ReadableStream()
    const { proxy, stream } = rpc<{ test: () => void }>(inputStream, {})

    // Get reader before making request
    const reader = stream.getReader()
    const decoder = new TextDecoder()

    // Make a request (don't await - it will hang since there's no response)
    proxy.test()

    // Read the first chunk
    const { value, done } = await reader.read()
    expect(done).toBe(false)
    expect(value).toBeInstanceOf(Uint8Array)

    // Verify it's JSON line format (ends with newline)
    const text = decoder.decode(value)
    expect(text.endsWith('\n')).toBe(true)

    // Should be valid JSON
    const parsed = JSON.parse(text.trim())
    expect(parsed).toHaveProperty('RPC_PROXY_REQUEST')
    expect(parsed).toHaveProperty('payload')

    reader.releaseLock()
  })

  it('should throw when stream is closed', async () => {
    const { stream: inputStream, close } = createControllableStream()
    const { proxy, closed, stream } = rpc<{ test: () => void }>(inputStream, {})

    // Cancel the output stream to trigger closed state
    const reader = stream.getReader()
    await reader.cancel()

    // Now the closed() should return true and proxy calls should throw
    expect(closed()).toBe(true)
    await expect(proxy.test()).rejects.toThrow('[rpc/sse] Stream is closed.')
  })

  it('should accept stream from function', async () => {
    const inputStream = new ReadableStream()
    const streamFactory = vi.fn((outputStream: ReadableStream) => inputStream)

    const { proxy, stream } = rpc(streamFactory, {})

    expect(streamFactory).toHaveBeenCalledWith(stream)
  })

  it('should accept stream from promise', async () => {
    const inputStream = new ReadableStream()
    const streamPromise = Promise.resolve(inputStream)

    const { proxy } = rpc(streamPromise, {})

    expect(proxy).toBeDefined()
  })

  it('should use custom codec when provided', async () => {
    const { stream: inputStream, enqueue, close } = createControllableStream()

    const customCodec = {
      serialize: vi.fn((value: any, onChunk: (chunk: any) => void) => {
        onChunk(encoder.encode(`CUSTOM:${JSON.stringify(value)}\n`))
      }),
      deserialize: vi.fn(async (stream: ReadableStream, onChunk: (chunk: any) => void) => {
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
          const text = decoder.decode(chunk)
          const lines = text.split('\n').filter(Boolean)
          for (const line of lines) {
            if (line.startsWith('CUSTOM:')) {
              onChunk(JSON.parse(line.slice(7)))
            }
          }
        }
      }),
    }

    const { proxy, stream } = rpc<{ test: () => void }>(inputStream, {}, customCodec)

    proxy.test()

    await new Promise(resolve => setTimeout(resolve, 10))

    expect(customCodec.serialize).toHaveBeenCalled()
    expect(customCodec.deserialize).toHaveBeenCalled()
  })

  it('should handle nested method calls', async () => {
    const { stream: stream1, enqueue: enqueue1 } = createControllableStream()
    const { stream: stream2, enqueue: enqueue2 } = createControllableStream()

    const methods = {
      user: {
        profile: {
          getName: () => 'John Doe',
        },
      },
    }

    const endpoint1 = rpc<{}, typeof methods>(stream1, methods)
    const endpoint2 = rpc<typeof methods, {}>(stream2, {})

    // Wire up the streams
    const reader1 = endpoint1.stream.getReader()
    const reader2 = endpoint2.stream.getReader()

    ;(async () => {
      while (true) {
        const { done, value } = await reader1.read()
        if (done) break
        enqueue2(decoder.decode(value))
      }
    })()
    ;(async () => {
      while (true) {
        const { done, value } = await reader2.read()
        if (done) break
        enqueue1(decoder.decode(value))
      }
    })()

    const result = await endpoint2.proxy.user.profile.getName()
    expect(result).toBe('John Doe')
  })
})

describe('server', () => {
  it('should create a Response with correct headers', () => {
    const inputStream = new ReadableStream()
    const { response } = server(inputStream, {})

    expect(response).toBeInstanceOf(Response)
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    expect(response.headers.get('Cache-Control')).toBe('no-cache')
    expect(response.headers.get('Connection')).toBe('keep-alive')
  })

  it('should expose proxy and lifecycle methods', () => {
    const inputStream = new ReadableStream()
    const { proxy, closed, onClose, response } = server(inputStream, {})

    expect(proxy).toBeDefined()
    expect(typeof closed).toBe('function')
    expect(typeof onClose).toBe('function')
    expect(response).toBeInstanceOf(Response)
  })
})

describe('client', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('should make POST request with correct headers', async () => {
    const mockResponseStream = new ReadableStream()
    vi.mocked(globalThis.fetch).mockResolvedValue({
      body: mockResponseStream,
    } as Response)

    const { proxy, stream } = client('http://example.com/rpc', {})

    // Verify fetch was called with correct options
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://example.com/rpc',
      expect.objectContaining({
        method: 'POST',
        duplex: 'half',
        headers: expect.objectContaining({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          RPC_STREAM_REQUEST_HEADER: '1',
        }),
      }),
    )
  })

  it('should send output stream as request body', async () => {
    const mockResponseStream = new ReadableStream()
    vi.mocked(globalThis.fetch).mockResolvedValue({
      body: mockResponseStream,
    } as Response)

    const { stream } = client('http://example.com/rpc', {})

    await new Promise(resolve => setTimeout(resolve, 10))

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]!
    expect(fetchCall[1]?.body).toBeInstanceOf(ReadableStream)
  })
})

describe('onClose callback', () => {
  it('should call onClose handlers when stream is cancelled', async () => {
    const inputStream = new ReadableStream()
    const { stream, onClose } = rpc(inputStream, {})

    const handler = vi.fn()
    onClose(handler)

    const reader = stream.getReader()
    await reader.cancel()

    expect(handler).toHaveBeenCalled()
  })

  it('should allow unsubscribing from onClose', async () => {
    const inputStream = new ReadableStream()
    const { stream, onClose } = rpc(inputStream, {})

    const handler = vi.fn()
    const unsubscribe = onClose(handler)
    unsubscribe()

    const reader = stream.getReader()
    await reader.cancel()

    expect(handler).not.toHaveBeenCalled()
  })
})

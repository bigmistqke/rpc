import { describe, it, expect, vi } from 'vitest'
import {
  createStreamCodec,
  PrimitiveCodec,
  StructuralCodec,
  GeneratorCodec,
} from '../src/stream/encoding'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Helper to create a stream from chunks
function createStreamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++])
      } else {
        controller.close()
      }
    },
  })
}

// Helper to collect serialized chunks
function collectChunks(serialize: (onChunk: (chunk: Uint8Array) => void) => void): Uint8Array[] {
  const chunks: Uint8Array[] = []
  serialize(chunk => chunks.push(chunk))
  return chunks
}

describe('PrimitiveCodec', () => {
  it('should create a primitive codec', () => {
    const stringCodec = new PrimitiveCodec({
      test: (value): value is string => typeof value === 'string',
      encode: (value: string) => encoder.encode(value),
      decode: (buffer: Uint8Array) => decoder.decode(buffer),
    })

    expect(stringCodec.type).toBe('primitive')
    expect(stringCodec.test('hello')).toBe(true)
    expect(stringCodec.test(123)).toBe(false)

    const encoded = stringCodec.encode('hello')
    expect(encoded).toBeInstanceOf(Uint8Array)
    expect(stringCodec.decode(encoded)).toBe('hello')
  })
})

describe('StructuralCodec', () => {
  it('should create a structural codec for objects', () => {
    const objectCodec = new StructuralCodec({
      test: (value): value is object =>
        typeof value === 'object' && value !== null && !Array.isArray(value),
      encode: (value: Record<string, any>) => ({
        keys: Object.keys(value),
        values: Object.values(value),
      }),
      decode: () => {
        const obj: Record<string, any> = {}
        return {
          value: obj,
          set: (value: any, key: string | number) => {
            obj[key] = value
          },
        }
      },
    })

    expect(objectCodec.type).toBe('structural')
    expect(objectCodec.test({ foo: 'bar' })).toBe(true)
    expect(objectCodec.test([1, 2, 3])).toBe(false)
    expect(objectCodec.test(null)).toBe(false)
  })

  it('should create a structural codec for arrays', () => {
    const arrayCodec = new StructuralCodec({
      test: (value): value is any[] => Array.isArray(value),
      encode: (value: any[]) => ({
        length: value.length,
        values: value,
      }),
      decode: () => {
        const arr: any[] = []
        return {
          value: arr,
          set: (value: any, key: string | number) => {
            arr[key as number] = value
          },
        }
      },
    })

    expect(arrayCodec.type).toBe('structural')
    expect(arrayCodec.test([1, 2, 3])).toBe(true)
    expect(arrayCodec.test({ a: 1 })).toBe(false)
  })
})

describe('GeneratorCodec', () => {
  it('should create a generator codec', () => {
    const generatorCodec = new GeneratorCodec({
      test: (value): value is AsyncGenerator => value?.[Symbol.asyncIterator] !== undefined,
      encode: async function* (value: AsyncGenerator<string>) {
        for await (const item of value) {
          yield encoder.encode(item)
        }
      },
      decode: async function* (): AsyncGenerator<AsyncGenerator<string>, unknown, Uint8Array> {
        let buffer: Uint8Array
        while (true) {
          buffer = yield decoder.decode(buffer!) as any
        }
      },
    })

    expect(generatorCodec.type).toBe('generator')
  })
})

describe('createStreamCodec', () => {
  describe('with default JSON codec only', () => {
    it('should serialize and deserialize primitive values', async () => {
      const codec = createStreamCodec([])
      const values: any[] = []

      const chunks = collectChunks(onChunk => codec.serialize({ test: 'value' }, onChunk))
      expect(chunks.length).toBeGreaterThan(0)

      const stream = createStreamFromChunks(chunks)
      await codec.deserialize(stream, value => values.push(value))

      expect(values).toEqual([{ test: 'value' }])
    })

    it('should serialize and deserialize numbers', async () => {
      const codec = createStreamCodec([])
      const values: any[] = []

      const chunks = collectChunks(onChunk => codec.serialize(42, onChunk))
      const stream = createStreamFromChunks(chunks)
      await codec.deserialize(stream, value => values.push(value))

      expect(values).toEqual([42])
    })

    it('should serialize and deserialize strings', async () => {
      const codec = createStreamCodec([])
      const values: any[] = []

      const chunks = collectChunks(onChunk => codec.serialize('hello world', onChunk))
      const stream = createStreamFromChunks(chunks)
      await codec.deserialize(stream, value => values.push(value))

      expect(values).toEqual(['hello world'])
    })

    it('should serialize and deserialize null', async () => {
      const codec = createStreamCodec([])
      const values: any[] = []

      const chunks = collectChunks(onChunk => codec.serialize(null, onChunk))
      const stream = createStreamFromChunks(chunks)
      await codec.deserialize(stream, value => values.push(value))

      expect(values).toEqual([null])
    })

    it('should serialize and deserialize arrays', async () => {
      const codec = createStreamCodec([])
      const values: any[] = []

      const chunks = collectChunks(onChunk => codec.serialize([1, 2, 3], onChunk))
      const stream = createStreamFromChunks(chunks)
      await codec.deserialize(stream, value => values.push(value))

      expect(values).toEqual([[1, 2, 3]])
    })

    it('should handle multiple values', async () => {
      const codec = createStreamCodec([])
      const values: any[] = []

      const allChunks: Uint8Array[] = []
      codec.serialize('first', chunk => allChunks.push(chunk))
      codec.serialize({ second: true }, chunk => allChunks.push(chunk))
      codec.serialize([3], chunk => allChunks.push(chunk))

      const stream = createStreamFromChunks(allChunks)
      await codec.deserialize(stream, value => values.push(value))

      expect(values).toEqual(['first', { second: true }, [3]])
    })
  })

  describe('with custom PrimitiveCodec', () => {
    it('should use custom codec when test matches', async () => {
      const uint8Codec = new PrimitiveCodec({
        test: (value): value is Uint8Array => value instanceof Uint8Array,
        encode: (value: Uint8Array) => value,
        decode: (buffer: Uint8Array) => buffer,
      })

      const codec = createStreamCodec([uint8Codec])
      const values: any[] = []

      const testData = new Uint8Array([1, 2, 3, 4, 5])
      const chunks = collectChunks(onChunk => codec.serialize(testData, onChunk))
      const stream = createStreamFromChunks(chunks)
      await codec.deserialize(stream, value => values.push(value))

      expect(values[0]).toBeInstanceOf(Uint8Array)
      expect(Array.from(values[0])).toEqual([1, 2, 3, 4, 5])
    })

    it('should fall back to JSON codec when custom codec does not match', async () => {
      const uint8Codec = new PrimitiveCodec({
        test: (value): value is Uint8Array => value instanceof Uint8Array,
        encode: (value: Uint8Array) => value,
        decode: (buffer: Uint8Array) => buffer,
      })

      const codec = createStreamCodec([uint8Codec])
      const values: any[] = []

      const chunks = collectChunks(onChunk => codec.serialize({ regular: 'object' }, onChunk))
      const stream = createStreamFromChunks(chunks)
      await codec.deserialize(stream, value => values.push(value))

      expect(values).toEqual([{ regular: 'object' }])
    })
  })

  describe('with StructuralCodec', () => {
    it('should handle structural encoding with keys', async () => {
      const mapCodec = new StructuralCodec({
        test: (value): value is Map<string, any> => value instanceof Map,
        encode: (value: Map<string, any>) => ({
          keys: Array.from(value.keys()),
          values: value.values(),
        }),
        decode: () => {
          const map = new Map()
          return {
            value: map,
            set: (value: any, key: string | number) => map.set(key, value),
          }
        },
      })

      const codec = createStreamCodec([mapCodec])
      const values: any[] = []

      const testMap = new Map([
        ['a', 1],
        ['b', 2],
      ])
      const chunks = collectChunks(onChunk => codec.serialize(testMap, onChunk))
      const stream = createStreamFromChunks(chunks)
      await codec.deserialize(stream, value => values.push(value))

      expect(values[0]).toBeInstanceOf(Map)
      expect(values[0].get('a')).toBe(1)
      expect(values[0].get('b')).toBe(2)
    })

    it('should handle structural encoding with length (arrays)', async () => {
      const setCodec = new StructuralCodec({
        test: (value): value is Set<any> => value instanceof Set,
        encode: (value: Set<any>) => ({
          length: value.size,
          values: value.values(),
        }),
        decode: () => {
          const items: any[] = []
          return {
            value: new Set(items),
            set: (value: any) => items.push(value),
          }
        },
      })

      const codec = createStreamCodec([setCodec])
      const values: any[] = []

      const testSet = new Set([1, 2, 3])
      const chunks = collectChunks(onChunk => codec.serialize(testSet, onChunk))
      const stream = createStreamFromChunks(chunks)
      await codec.deserialize(stream, value => values.push(value))

      // Note: The Set's values are decoded but stored in array order
      expect(values[0]).toBeInstanceOf(Set)
    })
  })

  describe('with GeneratorCodec', () => {
    it('should handle async generator encoding', async () => {
      const asyncIterableCodec = new GeneratorCodec({
        test: (value): value is AsyncIterable<any> =>
          value !== null && typeof value === 'object' && Symbol.asyncIterator in value,
        encode: async function* (value: AsyncIterable<any>) {
          for await (const item of value) {
            yield encoder.encode(JSON.stringify(item))
          }
        },
        decode: async function* (): AsyncGenerator<AsyncIterable<any>, unknown, Uint8Array> {
          const items: any[] = []
          try {
            while (true) {
              const chunk: Uint8Array = yield items as any
              items.push(JSON.parse(decoder.decode(chunk)))
            }
          } finally {
            return items
          }
        },
      })

      const codec = createStreamCodec([asyncIterableCodec])

      async function* testGenerator() {
        yield 'a'
        yield 'b'
        yield 'c'
      }

      const chunks: Uint8Array[] = []
      codec.serialize(testGenerator(), chunk => chunks.push(chunk))

      // Wait for async generator to complete
      await new Promise(resolve => setTimeout(resolve, 50))

      const values: any[] = []
      const stream = createStreamFromChunks(chunks)
      await codec.deserialize(stream, value => values.push(value))

      // The generator codec yields its accumulated value
      expect(values.length).toBeGreaterThan(0)
    })
  })

  describe('codec selection order', () => {
    it('should use first matching codec', async () => {
      const specificCodec = new PrimitiveCodec({
        test: (value): value is { special: true } =>
          typeof value === 'object' && value?.special === true,
        encode: () => encoder.encode('SPECIAL'),
        decode: () => ({ special: true, decoded: true }),
      })

      const codec = createStreamCodec([specificCodec])
      const values: any[] = []

      const chunks = collectChunks(onChunk => codec.serialize({ special: true }, onChunk))
      const stream = createStreamFromChunks(chunks)
      await codec.deserialize(stream, value => values.push(value))

      expect(values[0]).toEqual({ special: true, decoded: true })
    })
  })

  describe('binary packing', () => {
    it('should produce valid binary format', () => {
      const codec = createStreamCodec([])
      const chunks: Uint8Array[] = []

      codec.serialize('test', chunk => chunks.push(chunk))

      // First chunk should have proper header
      const chunk = chunks[0]!
      expect(chunk.length).toBeGreaterThan(6) // kind(1) + header(1) + length(4) + payload

      // Kind should be 0x01 (default)
      expect(chunk[0]).toBe(0x01)
    })
  })

  describe('stream handling', () => {
    it('should handle chunked stream input', async () => {
      const codec = createStreamCodec([])
      const values: any[] = []

      // Serialize a value
      const chunks = collectChunks(onChunk => codec.serialize({ chunked: 'data' }, onChunk))
      const fullBuffer = concatenate(chunks)

      // Split into smaller chunks to simulate network conditions
      const splitChunks = [
        fullBuffer.slice(0, 3),
        fullBuffer.slice(3, 10),
        fullBuffer.slice(10),
      ].filter(c => c.length > 0)

      const stream = createStreamFromChunks(splitChunks)
      await codec.deserialize(stream, value => values.push(value))

      expect(values).toEqual([{ chunked: 'data' }])
    })
  })
})

// Helper function
function concatenate(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

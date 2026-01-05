import { createIdAllocator, streamToAsyncIterable } from '../utils'

const MAX_UINT_32 = Math.pow(2, 32) - 1
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**********************************************************************************/
/*                                                                                */
/*                                      Codec                                     */
/*                                                                                */
/**********************************************************************************/

type Codec = StructuralCodec | PrimitiveCodec | GeneratorCodec

class CodecBase<
  TConfig extends {
    test(value: any): boolean
    encode(value: any): any
    decode(value: any): any
  },
> {
  test: TConfig['test']
  encode: TConfig['encode']
  decode: TConfig['decode']
  constructor({ test, encode, decode }: TConfig) {
    this.test = test
    this.encode = encode
    this.decode = decode
  }
}

export interface PrimitiveCodecMethods<T> {
  test: (value: any) => boolean
  encode: (value: T) => Uint8Array
  decode: (buffer: Uint8Array) => T
}
export class PrimitiveCodec<T = any> extends CodecBase<PrimitiveCodecMethods<T>> {
  type = 'primitive' as const
}

export interface StructuralCodecMethods<T> {
  test: (value: any) => boolean
  encode: (value: T) =>
    | {
        length?: never
        keys: Array<string>
        values: Array<any> | IterableIterator<any>
      }
    | {
        length: number
        keys?: never
        values: Array<any> | IterableIterator<any>
      }
  decode: () => { value: T; set(value: any, key: string | number): void }
}

export class StructuralCodec<T = any> extends CodecBase<StructuralCodecMethods<T>> {
  type = 'structural' as const
}

export interface GeneratorCodecMethods<T> {
  test: (value: any) => boolean
  encode: (value: T) => AsyncGenerator<Uint8Array>
  decode: () => AsyncGenerator<T, unknown, Uint8Array>
}

export class GeneratorCodec<T = any> extends CodecBase<GeneratorCodecMethods<T>> {
  type = 'generator' as const
}

const JSONCodec = new PrimitiveCodec({
  test() {
    return true
  },
  encode(value) {
    return encoder.encode(JSON.stringify(value))
  },
  decode(value) {
    const json = decoder.decode(value)
    return json ? JSON.parse(json) : undefined
  },
})

/**********************************************************************************/
/*                                                                                */
/*                                  Binary Schema                                 */
/*                                                                                */
/**********************************************************************************/

function createBinarySchema<TConfig extends Record<string, number>>(
  config: TConfig,
): { offsets: TConfig; size: number }
function createBinarySchema<
  TConfig extends Record<string, number>,
  TConstants extends Partial<TConfig> = {},
>(config: TConfig, constants: TConstants): { offsets: TConfig; constants: TConstants; size: number }
function createBinarySchema(config: Record<string, number>, constants?: Record<string, number>) {
  let offset = 0
  return {
    offsets: Object.fromEntries(
      Object.entries(config).map(([key, value]) => {
        const entry = [key, offset]
        offset += value
        return entry
      }),
    ),
    size: offset,
    constants,
  }
}

const defaultSchema = createBinarySchema(
  {
    kind: 1,
    header: 1,
    length: 4,
  },
  { kind: 0x01 },
)
const chunkSchema = createBinarySchema(
  {
    kind: 1,
    header: 1,
    length: 4,
    id: 4,
  },
  { kind: 0x02 },
)
const chunkEndSchema = createBinarySchema(
  {
    kind: 1,
    header: 1,
    id: 4,
  },
  { kind: 0x03 },
)
const kindToSchema = {
  [defaultSchema.constants.kind]: defaultSchema,
  [chunkSchema.constants.kind]: chunkSchema,
  [chunkEndSchema.constants.kind]: chunkEndSchema,
} as const
type SchemaKind = keyof typeof kindToSchema

function packDefault(header: number, encoded: Uint8Array): Uint8Array {
  const { offsets, size, constants } = defaultSchema
  const buffer = new Uint8Array(size + encoded.length)
  buffer[offsets.kind] = constants.kind
  buffer[offsets.header] = header
  const view = new DataView(buffer.buffer)
  view.setUint32(offsets.length, encoded.length)
  if (encoded.length > MAX_UINT_32)
    throw new Error(`Tried to encode something larger than MAX_UINT_32`)
  buffer.set(encoded, size)
  return buffer
}

function packChunk(id: number, header: number, encoded: Uint8Array): Uint8Array {
  const { offsets, size, constants } = chunkSchema
  const buffer = new Uint8Array(size + encoded?.length)
  buffer[offsets.kind] = constants.kind
  buffer[offsets.header] = header
  const view = new DataView(buffer.buffer)
  view.setUint32(offsets.id, id)
  view.setUint32(offsets.length, encoded.length)
  if (encoded.length > MAX_UINT_32)
    throw new Error(`Tried to encode something larger than MAX_UINT_32`)
  buffer.set(encoded, size)
  return buffer
}

function packChunkEnd(id: number, header: number): Uint8Array {
  const { offsets, size, constants } = chunkEndSchema
  const buffer = new Uint8Array(size)
  buffer[offsets.kind] = constants.kind
  buffer[offsets.header] = header
  const view = new DataView(buffer.buffer)
  view.setUint32(offsets.id, id)
  return buffer
}

function unpack(buffer: Uint8Array) {
  const kind = buffer[0]!
  const schema = kindToSchema[kind as SchemaKind]!
  const header = buffer[schema.offsets.header]!
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  const size =
    schema.size + ('length' in schema.offsets ? view.getUint32(schema.offsets.length) : 0)
  const payload = buffer.length < size ? undefined : buffer.slice(schema.size, size)
  const rest = !payload ? undefined : buffer.slice(size)
  const id = 'id' in schema.offsets ? view.getUint32(schema.offsets.id) : undefined

  return {
    kind,
    header,
    id,
    payload,
    rest,
  }
}

/**********************************************************************************/
/*                                                                                */
/*                               Create Stream Codec                              */
/*                                                                                */
/**********************************************************************************/

export function createStreamCodec(config: Array<Codec>, fallback: PrimitiveCodec = JSONCodec) {
  config = [...config, fallback]
  const generatorIdAllocator = createIdAllocator()
  const generators: Record<string, AsyncGenerator<unknown, unknown, Uint8Array>> = {}

  function getCodecFromHeader(header: number) {
    const codec = config[header - 1]
    if (!codec) throw `Unknown Codec ${header}`
    return codec
  }

  function getCodecFromValue(value: any) {
    for (let index = 0; index < config.length; index++) {
      const codec = config[index]!
      if (codec.test(value)) {
        return { codec, header: 0x01 + index }
      }
    }
    throw new Error(`Unknown Codec`)
  }

  async function* createChunkGenerator(stream: ReadableStream<Uint8Array>): AsyncGenerator<{
    kind: number
    header: number
    payload: Uint8Array
    id?: number
  }> {
    let buffer = new Uint8Array(new ArrayBuffer(0))

    for await (const value of streamToAsyncIterable(stream)) {
      // append new chunk to buffer
      buffer = concat(buffer, value!)

      while (buffer.length >= defaultSchema.size) {
        const { kind, header, payload, rest, id } = unpack(buffer)

        if (!payload || !rest) break

        yield { kind, header, payload, id }

        buffer = rest
      }
    }
  }

  const api = {
    serialize(value: any, onChunk: (chunk: Uint8Array) => void): void {
      const { codec, header } = getCodecFromValue(value)
      const currentGenerators = new Array<{
        generator: AsyncGenerator<Uint8Array>
        id: number
        codec: GeneratorCodec
        header: number
      }>()

      switch (codec.type) {
        case 'structural':
          const { keys, values, length } = codec.encode(value)
          onChunk(packDefault(header, JSONCodec.encode(length ?? keys)))
          for (const value of values) {
            api.serialize(value, onChunk)
          }
          break
        case 'generator':
          const generator = codec.encode(value)
          const id = generatorIdAllocator.create()
          currentGenerators.push({ generator, codec, id, header })
          onChunk(packDefault(header, JSONCodec.encode({ id })))
          break
        case 'primitive':
          onChunk(packDefault(header, codec.encode(value)))
          break
        default:
          throw new Error(`Unknown Codec`)
      }

      if (currentGenerators.length) {
        ;(async function () {
          for (const { generator, id, header } of currentGenerators) {
            for await (const value of generator) {
              onChunk(packChunk(id, header, value))
            }
            onChunk(packChunkEnd(id, header))
            generatorIdAllocator.free(id)
          }
        })()
      }
    },
    async deserialize(stream: ReadableStream, onChunk: (value: any) => void) {
      const generator = createChunkGenerator(stream)

      for await (const { payload, header, kind, id } of generator) {
        switch (kind) {
          case defaultSchema.constants.kind:
            onChunk(await handleCodec({ codec: getCodecFromHeader(header), payload }))
            break
          case chunkSchema.constants.kind:
            generators[id!]!.next(payload)
            break
          case chunkEndSchema.constants.kind:
            await generators[id!]!.return(null)
            delete generators[id!]
            break
        }
      }

      async function handleCodec({ codec, payload }: { codec: Codec; payload: Uint8Array }) {
        switch (codec.type) {
          case 'structural': {
            const paths = JSONCodec.decode(payload) as Array<string> | number

            const { value, set } = codec.decode()

            const total = typeof paths === 'number' ? paths : paths.length

            for (let i = 0; i < total; i++) {
              const key = typeof paths === 'number' ? i : paths[i]!
              const { value, done } = await generator.next()
              if (done) break
              const { payload, header } = value
              const codec = getCodecFromHeader(header)
              set(await handleCodec({ codec, payload }), key)
            }

            return value
          }
          case 'generator': {
            const { id } = JSONCodec.decode(payload)
            const generator = codec.decode()
            const { value } = await generator.next()
            generators[id] = generator
            return value
          }
          case 'primitive':
            return codec.decode(payload)
          default:
            throw new Error('Unknown codec')
        }
      }
    },
  }

  return api
}

// helper to concatenate Uint8Arrays
function concat(...arrays: Array<Uint8Array>): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(new ArrayBuffer(arrays.reduce((a, b) => a + b.length, 0)))
  let index = 0
  return arrays.reduce<Uint8Array<ArrayBuffer>>((result, current) => {
    result.set(current, index)
    index += current.length
    return result
  }, result)
}

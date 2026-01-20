import * as v from 'valibot'
import { createShape } from './utils'

// Schema and protocol for requests
export const $MESSENGER_REQUEST = 'RPC_PROXY_REQUEST'

export const requestSchema = v.object({
  [$MESSENGER_REQUEST]: v.number(),
  payload: v.unknown(),
})

export const RequestShape = createShape(requestSchema, <T>(id: number, payload: T) => ({
  [$MESSENGER_REQUEST]: id,
  payload,
}))

export type RequestData = v.InferOutput<typeof requestSchema>

// Schema and protocol for responses
export const $MESSENGER_RESPONSE = 'RPC_PROXY_RESPONSE'

export const ResponseShape = createShape(
  v.object({
    [$MESSENGER_RESPONSE]: v.number(),
    payload: v.unknown(),
  }),
  (request: RequestData, payload: any) => ({
    [$MESSENGER_RESPONSE]: request[$MESSENGER_REQUEST],
    payload,
  }),
)

// Schema and protocol of errors
export const $MESSENGER_ERROR = 'RPC_PROXY_ERROR'

export const ErrorShape = createShape(
  v.object({
    [$MESSENGER_ERROR]: v.number(),
    error: v.unknown(),
  }),
  (data: RequestData, error: any) => ({
    [$MESSENGER_ERROR]: data[$MESSENGER_REQUEST],
    error,
  }),
)

// RPC-specific request payload
export const $MESSENGER_RPC_REQUEST = 'RPC_PROXY_RPC_REQUEST'

export const RPCPayloadShape = createShape(
  v.object({
    [$MESSENGER_RPC_REQUEST]: v.boolean(),
    topics: v.array(v.string()),
    args: v.array(v.any()),
  }),
  (topics: Array<string>, args: Array<any>) => ({ [$MESSENGER_RPC_REQUEST]: true, topics, args }),
)

// Initialization request payload (for factory-based expose)
export const $MESSENGER_INIT = 'RPC_PROXY_INIT'

export const InitPayloadShape = createShape(
  v.object({
    [$MESSENGER_INIT]: v.boolean(),
    args: v.array(v.any()),
  }),
  (args: Array<any>) => ({ [$MESSENGER_INIT]: true, args }),
)

import { describe, expect, it } from 'vitest'
import {
  $MESSENGER_ERROR,
  $MESSENGER_REQUEST,
  $MESSENGER_RESPONSE,
  $MESSENGER_RPC_REQUEST,
  ErrorShape,
  RequestShape,
  ResponseShape,
  RPCPayloadShape,
} from '../src/protocol'

describe('RequestShape', () => {
  describe('validate', () => {
    it('should validate correct request objects', () => {
      expect(RequestShape.validate({ [$MESSENGER_REQUEST]: 0, payload: 'test' })).toBe(true)
      expect(RequestShape.validate({ [$MESSENGER_REQUEST]: 123, payload: { data: true } })).toBe(
        true,
      )
      expect(RequestShape.validate({ [$MESSENGER_REQUEST]: 999, payload: null })).toBe(true)
    })

    it('should reject invalid request objects', () => {
      expect(RequestShape.validate({})).toBe(false)
      expect(RequestShape.validate({ [$MESSENGER_REQUEST]: 'not a number', payload: 'test' })).toBe(
        false,
      )
      expect(RequestShape.validate({ payload: 'test' })).toBe(false)
      expect(RequestShape.validate(null)).toBe(false)
      expect(RequestShape.validate(undefined)).toBe(false)
    })
  })

  describe('create', () => {
    it('should create valid request objects', () => {
      const request = RequestShape.create(42, { method: 'test' })
      expect(request).toEqual({
        [$MESSENGER_REQUEST]: 42,
        payload: { method: 'test' },
      })
      expect(RequestShape.validate(request)).toBe(true)
    })
  })
})

describe('ResponseShape', () => {
  describe('validate', () => {
    it('should validate correct response objects', () => {
      expect(ResponseShape.validate({ [$MESSENGER_RESPONSE]: 0, payload: 'result' })).toBe(true)
      expect(ResponseShape.validate({ [$MESSENGER_RESPONSE]: 123, payload: { data: true } })).toBe(
        true,
      )
    })

    it('should reject invalid response objects', () => {
      expect(ResponseShape.validate({})).toBe(false)
      expect(
        ResponseShape.validate({ [$MESSENGER_RESPONSE]: 'not a number', payload: 'test' }),
      ).toBe(false)
      expect(ResponseShape.validate({ payload: 'test' })).toBe(false)
    })
  })

  describe('create', () => {
    it('should create valid response objects from request', () => {
      const request = { [$MESSENGER_REQUEST]: 42, payload: {} }
      const response = ResponseShape.create(request, 'result')
      expect(response).toEqual({
        [$MESSENGER_RESPONSE]: 42,
        payload: 'result',
      })
      expect(ResponseShape.validate(response)).toBe(true)
    })
  })
})

describe('ErrorShape', () => {
  describe('validate', () => {
    it('should validate correct error objects', () => {
      expect(ErrorShape.validate({ [$MESSENGER_ERROR]: 0, error: 'error message' })).toBe(true)
      expect(ErrorShape.validate({ [$MESSENGER_ERROR]: 123, error: { message: 'test' } })).toBe(
        true,
      )
    })

    it('should reject invalid error objects', () => {
      expect(ErrorShape.validate({})).toBe(false)
      expect(ErrorShape.validate({ [$MESSENGER_ERROR]: 'not a number', error: 'test' })).toBe(false)
      expect(ErrorShape.validate({ error: 'test' })).toBe(false)
    })
  })

  describe('create', () => {
    it('should create valid error objects from request', () => {
      const request = { [$MESSENGER_REQUEST]: 42, payload: {} }
      const error = ErrorShape.create(request, 'Something went wrong')
      expect(error).toEqual({
        [$MESSENGER_ERROR]: 42,
        error: 'Something went wrong',
      })
      expect(ErrorShape.validate(error)).toBe(true)
    })
  })
})

describe('RPCPayloadShape', () => {
  describe('validate', () => {
    it('should validate correct RPC payload objects', () => {
      expect(
        RPCPayloadShape.validate({
          [$MESSENGER_RPC_REQUEST]: true,
          topics: ['method'],
          args: [],
        }),
      ).toBe(true)
      expect(
        RPCPayloadShape.validate({
          [$MESSENGER_RPC_REQUEST]: true,
          topics: ['user', 'profile', 'get'],
          args: [1, 'test'],
        }),
      ).toBe(true)
    })

    it('should reject invalid RPC payload objects', () => {
      expect(RPCPayloadShape.validate({})).toBe(false)
      expect(RPCPayloadShape.validate({ [$MESSENGER_RPC_REQUEST]: true })).toBe(false)
      expect(
        RPCPayloadShape.validate({
          [$MESSENGER_RPC_REQUEST]: true,
          topics: 'not an array',
          args: [],
        }),
      ).toBe(false)
      expect(
        RPCPayloadShape.validate({
          [$MESSENGER_RPC_REQUEST]: 'not a boolean',
          topics: [],
          args: [],
        }),
      ).toBe(false)
    })
  })

  describe('create', () => {
    it('should create valid RPC payload objects', () => {
      const payload = RPCPayloadShape.create(['user', 'get'], [42])
      expect(payload).toEqual({
        [$MESSENGER_RPC_REQUEST]: true,
        topics: ['user', 'get'],
        args: [42],
      })
      expect(RPCPayloadShape.validate(payload)).toBe(true)
    })

    it('should handle empty topics and args', () => {
      const payload = RPCPayloadShape.create([], [])
      expect(payload).toEqual({
        [$MESSENGER_RPC_REQUEST]: true,
        topics: [],
        args: [],
      })
      expect(RPCPayloadShape.validate(payload)).toBe(true)
    })
  })
})

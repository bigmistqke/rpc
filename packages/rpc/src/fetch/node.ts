/// <reference types="node" />

import { IncomingMessage, ServerResponse } from 'http'
import { Payload } from '.'
import { callMethod } from '../core'

export function exposeNode<T extends object>(
  methods: T,
  {
    wrap = (res: ServerResponse, result: any) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    },
    unwrap = async (req: IncomingMessage): Promise<{ topics: string[]; args: any[] }> => {
      const body = await new Promise<string>((resolve, reject) => {
        let data = ''
        req.on('data', chunk => (data += chunk))
        req.on('end', () => resolve(data))
        req.on('error', reject)
      })

      const json = JSON.parse(body)
      if (!Payload.validate(json)) {
        throw new Error(`Incorrect shape`)
      }

      return json
    },
  }: {
    wrap?: (res: ServerResponse, result: any) => void
    unwrap?: (req: IncomingMessage) => Promise<{ topics: string[]; args: any[] }>
  } = {},
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const { topics, args } = await unwrap(req)
      const result = await callMethod(methods, topics, args)
      wrap(res, result)
    } catch (err: any) {
      res.writeHead(500)
      res.statusMessage = err?.message
    }
  }
}

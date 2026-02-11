export type Fn = (...arg: Array<any>) => any
export type MaybePromise<T> = T | Promise<T>

/** Check if T is a Handled type and extract the inner type */
type UnwrapHandled<T> = T extends { readonly ['__rpc_handled__']: infer U extends object }
  ? RPC<U>
  : T

// To prevent error: `Type instantiation is excessively deep and possibly infinite.`
type isObject<T> = T extends object ? true : false

type HasMethod<T> = T extends object
  ? {
      [K in keyof T]: T[K] extends Fn ? true : HasMethod<T[K]>
    }[keyof T] extends false
    ? false
    : true
  : false

/**********************************************************************************/
/*                                                                                */
/*                                       Sync                                     */
/*                                                                                */
/**********************************************************************************/

export interface NoResponseMethod<T extends Fn> {
  (...args: Parameters<T>): void
}

export type NoResponseRPCNode<T> = T extends Fn
  ? NoResponseMethod<T>
  : T extends readonly [any, ...any[]] // is it a tuple?
  ? { [K in keyof T]: NoResponseRPCNode<T[K]> } // preserve tuple structure
  : // To prevent error: `Type instantiation is excessively deep and possibly infinite.`
  isObject<T> extends true
  ? // Filter branches that lead to no method
    HasMethod<T> extends false
    ? never
    : {
        [TKey in keyof FilterNoResponseMethod<T>]: NoResponseRPCNode<T[TKey]>
      }
  : never

type FilterNoResponseMethod<T> = {
  [TKey in keyof T as NoResponseRPCNode<T[TKey]> extends never ? never : TKey]: T[TKey]
}

/**********************************************************************************/
/*                                                                                */
/*                                      Async                                     */
/*                                                                                */
/**********************************************************************************/

export interface ResponseMethod<T extends Fn> {
  (...args: Parameters<T>): Promise<UnwrapHandled<Awaited<ReturnType<T>>>>
}

export type ResponseRPCNode<T> = T extends Fn
  ? ResponseMethod<T>
  : T extends readonly [any, ...any[]] // is it a tuple?
  ? { [K in keyof T]: ResponseRPCNode<T[K]> } // preserve tuple structure
  : // To prevent error: `Type instantiation is excessively deep and possibly infinite.`
  isObject<T> extends true
  ? // Filter branches that lead to no method
    HasMethod<T> extends false
    ? never
    : {
        [TKey in keyof FilterResponseMethod<T>]: ResponseRPCNode<T[TKey]>
      }
  : never

type FilterResponseMethod<T> = {
  [TKey in keyof T as ResponseRPCNode<T[TKey]> extends never ? never : TKey]: T[TKey]
}

/**********************************************************************************/
/*                                                                                */
/*                                       RPC                                      */
/*                                                                                */
/**********************************************************************************/

export enum RPCKind {
  NoResponse = 'no-response',
  Response = 'response',
}

export type RPC<
  TMethods extends object,
  TKind extends RPCKind = RPCKind.Response,
> = TKind extends RPCKind.Response ? ResponseRPCNode<TMethods> : NoResponseRPCNode<TMethods>

/**********************************************************************************/
/*                                                                                */
/*                                      Worker                                    */
/*                                                                                */
/**********************************************************************************/

// /** Branded `MessagePort` */
// export type RPCPort<T extends object> = MessagePort & { [$WORKER]: RPC<T> }

// export type $Transfer<T = Array<any>, U = Array<Transferable>> = T & {
//   [$TRANSFER]: U
// }

// export type $Callback<T = Fn> = T & { [$CALLBACK]: number }

// export interface WorkerMethod<T extends Fn> {
//   (...args: Parameters<T> | [$Transfer<Parameters<T>>]): void
// }

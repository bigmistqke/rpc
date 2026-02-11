const $HANDLE_MARKER = Symbol('RPC-HANDLE-MARKER')

/** Internal marker type for handle() */
interface HandleMarker<T extends object> {
  [$HANDLE_MARKER]: true
  methods: T
}

/** Type for values returned by handle() - unwrapped to RPC<T> by RPC system */
export type Handled<T extends object> = T & { readonly ['__rpc_handled__']: T }

/**
 * Mark methods to be returned as a sub-proxy from an RPC method.
 * Use this when a method needs to return an object with callable methods.
 *
 * @example
 * ```ts
 * expose({
 *   init(canvas: OffscreenCanvas) {
 *     const renderer = createRenderer(canvas)
 *     return handle({
 *       render: () => renderer.render(),
 *       resize: (w, h) => renderer.resize(w, h),
 *     })
 *   }
 * })
 * ```
 */
export function handle<T extends object>(methods: T): Handled<T> {
  return { [$HANDLE_MARKER]: true, methods } as unknown as Handled<T>
}

/**
 * Check if a value is a handle marker
 */
export function isHandleMarker<T extends object>(value: unknown): value is HandleMarker<T> {
  return !!value && typeof value === 'object' && $HANDLE_MARKER in value
}

// Prefix for namespace IDs to avoid collisions
export const HANDLE_NAMESPACE_PREFIX = '__rpc_handle_'

// Counter for generating unique namespace IDs
export let handleNamespaceCounter = 0

export function nextHandleNamespaceId(): string {
  return `${HANDLE_NAMESPACE_PREFIX}${handleNamespaceCounter++}`
}

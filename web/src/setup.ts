// Vitest global setup: register the jest-dom matchers (toBeInTheDocument, etc.) so component
// tests can assert against the jsdom DOM. Referenced by vite.config.ts `test.setupFiles`.
import '@testing-library/jest-dom/vitest'

// React Flow measures its container/nodes with ResizeObserver, which jsdom does not implement. A
// no-op polyfill lets the canvas mount and render nodes in component tests (no layout is asserted).
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub
}

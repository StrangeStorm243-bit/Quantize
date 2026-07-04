// Vitest global setup: register the jest-dom matchers (toBeInTheDocument, etc.) so component
// tests can assert against the jsdom DOM. Referenced by vite.config.ts `test.setupFiles`.
import '@testing-library/jest-dom/vitest'

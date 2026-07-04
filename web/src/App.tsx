// Placeholder editor shell (M11.2). The real palette / canvas / inspector / panels land in later
// M11 slices; for now this proves the app mounts and serves. NO document/business logic here.
export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>Quantize</h1>
      </header>
      <main className="app-body">
        <section className="app-region app-region--left" aria-label="palette" />
        <section className="app-region app-region--center" aria-label="canvas" />
        <section className="app-region app-region--right" aria-label="inspector" />
      </main>
    </div>
  )
}

// One served run note rendered as a single line: the machine `code` token followed by the human
// `message` (M13.7 fix pass). Extracted so the Trace panel and the Inspector's "At session" no-eval
// state render a run's no-evaluation reason with the SAME inner markup/classes — before this the
// `<code className="trace-event__token">…</code> message` markup was copy-pasted between the two
// surfaces and drifted. Pure presentation of a served fact (invariant 5). The optional `className`
// styles the wrapping paragraph (the Inspector carries its own `inspector__at-note` styling; the Trace
// panel wraps a bare `<p>`) — the inner token+message stays identical across both.
import type { ReactElement } from 'react'
import type { PersistedNote } from '@quantize/quantize-api'

export function NoteLine({ note, className }: { note: PersistedNote; className?: string }): ReactElement {
  return (
    <p className={className}>
      <code className="trace-event__token">{note.code}</code> {note.message}
    </p>
  )
}

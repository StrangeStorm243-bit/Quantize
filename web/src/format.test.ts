// Display-only formatting helpers (PX-C/PX-E). These pin fmtValue's per-number contract — a single
// already-served number in, one display string out, trailing zeros trimmed with no dangling point, and
// integer-valued served numbers left un-grown — plus abbrev's head…tail elision for long ids. No
// arithmetic, no aggregation: the tests below never sum/compare across values.
import { describe, expect, it } from 'vitest'
import { abbrev, fmtValue } from './format'

describe('fmtValue', () => {
  it('trims a long fractional to 4 dp without dangling zeros', () => {
    expect(fmtValue(0.3333333333333333)).toBe('0.3333')
    expect(fmtValue(103.29239033354406)).toBe('103.2924')
  })

  it('rounds and preserves the sign for negatives', () => {
    expect(fmtValue(-0.04916057824719877)).toBe('-0.0492')
  })

  it('leaves integer-valued served numbers as bare integers (no .0000 growth)', () => {
    expect(fmtValue(1)).toBe('1')
    expect(fmtValue(126)).toBe('126')
    expect(fmtValue(0)).toBe('0')
  })

  it('keeps a short decimal exactly, trimming only zeros beyond it', () => {
    expect(fmtValue(0.025)).toBe('0.025')
  })

  it('passes booleans through unchanged', () => {
    expect(fmtValue(true)).toBe('true')
    expect(fmtValue(false)).toBe('false')
  })

  it('renders non-finite numbers visibly rather than crashing', () => {
    expect(fmtValue(Number.NaN)).toBe('NaN')
    expect(fmtValue(Number.POSITIVE_INFINITY)).toBe('Infinity')
    expect(fmtValue(Number.NEGATIVE_INFINITY)).toBe('-Infinity')
  })
})

describe('abbrev', () => {
  it('elides a long id to head…tail', () => {
    const id = '0123456789abcdefghijklmnop'
    expect(abbrev(id)).toBe('0123456789…klmnop')
  })

  it('leaves an id of 18 chars or fewer untouched', () => {
    expect(abbrev('fp-777')).toBe('fp-777')
    expect(abbrev('123456789012345678')).toBe('123456789012345678')
  })
})

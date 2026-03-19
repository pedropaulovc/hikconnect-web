import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('layout.tsx', () => {
  it('imports globals.css', () => {
    const layoutPath = resolve(__dirname, '..', 'layout.tsx')
    const content = readFileSync(layoutPath, 'utf-8')
    expect(content).toMatch(/import\s+['"]\.\/globals\.css['"]/)
  })
})

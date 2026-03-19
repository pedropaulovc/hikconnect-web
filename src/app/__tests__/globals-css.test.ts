import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('globals.css', () => {
  let css: string

  const loadCss = () => {
    const cssPath = resolve(__dirname, '..', 'globals.css')
    return readFileSync(cssPath, 'utf-8')
  }

  it('exists at src/app/globals.css', () => {
    expect(() => { css = loadCss() }).not.toThrow()
  })

  describe('CSS reset', () => {
    it('includes box-sizing border-box', () => {
      css = loadCss()
      expect(css).toContain('box-sizing')
      expect(css).toMatch(/border-box/)
    })

    it('resets margin', () => {
      css = loadCss()
      expect(css).toMatch(/margin\s*:\s*0/)
    })

    it('resets padding', () => {
      css = loadCss()
      expect(css).toMatch(/padding\s*:\s*0/)
    })
  })

  describe('dark theme', () => {
    it('sets body background to #111', () => {
      css = loadCss()
      expect(css).toMatch(/#111/)
    })

    it('sets text color to #e0e0e0', () => {
      css = loadCss()
      expect(css).toMatch(/#e0e0e0/)
    })

    it('sets font-family to system-ui', () => {
      css = loadCss()
      expect(css).toMatch(/system-ui/)
    })
  })

  describe('link styles', () => {
    it('sets link color to #6cb4ee', () => {
      css = loadCss()
      expect(css).toMatch(/#6cb4ee/)
    })

    it('removes default text decoration', () => {
      css = loadCss()
      expect(css).toMatch(/text-decoration\s*:\s*none/)
    })
  })

  describe('button/input', () => {
    it('inherits font-family on buttons/inputs', () => {
      css = loadCss()
      expect(css).toMatch(/font-family\s*:\s*inherit/)
    })
  })
})

/**
 * Tests for extractUserId — parses the JWT sessionId to extract the
 * userId from the `aud` claim.
 *
 * Spec: docs/plans/2026-03-18-verify-and-complete-streaming-impl.md Task 7
 *   JWT payload format: { aud: "fcfaec90a55f4a61b4e7211152a2d805", ... }
 */
import { describe, it, expect } from 'vitest'
import { extractUserId } from '../client'

// Helper: build a JWT with a given payload object
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.fakesignature`
}

describe('extractUserId', () => {
  it('extracts userId from a valid JWT aud claim', () => {
    const jwt = fakeJwt({ aud: 'fcfaec90a55f4a61b4e7211152a2d805', exp: 9999999999 })
    expect(extractUserId(jwt)).toBe('fcfaec90a55f4a61b4e7211152a2d805')
  })

  it('returns the full 32-char hex userId, not a truncated version', () => {
    const userId = 'abcdef0123456789abcdef0123456789'
    const jwt = fakeJwt({ aud: userId })
    const result = extractUserId(jwt)
    expect(result).toBe(userId)
    expect(result).toHaveLength(32)
  })

  it('returns empty string when aud claim is missing', () => {
    const jwt = fakeJwt({ sub: 'something', exp: 9999999999 })
    expect(extractUserId(jwt)).toBe('')
  })

  it('returns empty string for malformed JWT (no dots)', () => {
    expect(extractUserId('not-a-jwt')).toBe('')
  })

  it('returns empty string for malformed JWT (only one dot)', () => {
    expect(extractUserId('header.payload')).toBe('')
  })

  it('returns empty string for invalid base64url payload', () => {
    expect(extractUserId('header.!!!invalid!!!.signature')).toBe('')
  })

  it('returns empty string for non-JSON payload', () => {
    const notJson = Buffer.from('this is not json').toString('base64url')
    expect(extractUserId(`header.${notJson}.signature`)).toBe('')
  })

  it('returns empty string for empty string input', () => {
    expect(extractUserId('')).toBe('')
  })

  it('handles JWT with standard base64 padding characters', () => {
    const jwt = fakeJwt({ aud: 'abc123def456' })
    expect(extractUserId(jwt)).toBe('abc123def456')
  })

  it('returns empty string when aud is null', () => {
    const jwt = fakeJwt({ aud: null })
    expect(extractUserId(jwt)).toBe('')
  })

  it('returns empty string when aud is a number (not a string)', () => {
    const jwt = fakeJwt({ aud: 12345 })
    expect(extractUserId(jwt)).toBe('')
  })
})

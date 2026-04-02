import { test, expect } from '@playwright/test'

test('login page renders with title and form fields', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(/HikConnect/)
  await expect(page.locator('h1')).toHaveText('HikConnect Web')
  await expect(page.locator('input[name="account"]')).toBeVisible()
  await expect(page.locator('input[name="password"]')).toBeVisible()
  await expect(page.locator('button[type="submit"]')).toHaveText('Login')
})

test('login form shows error on invalid credentials', async ({ page }) => {
  await page.goto('/')
  await page.fill('input[name="account"]', 'bad@example.com')
  await page.fill('input[name="password"]', 'wrongpass')
  await page.click('button[type="submit"]')

  // Button should show loading state
  await expect(page.locator('button[type="submit"]')).toHaveText('Logging in...')

  // Error message should appear after API responds
  const error = page.locator('p')
  await expect(error).toBeVisible({ timeout: 15000 })
  // Button should return to normal
  await expect(page.locator('button[type="submit"]')).toHaveText('Login')
})

test('login form requires fields before submission', async ({ page }) => {
  await page.goto('/')
  // Both fields have required attribute — browser prevents submission
  await expect(page.locator('input[name="account"]')).toHaveAttribute('required', '')
  await expect(page.locator('input[name="password"]')).toHaveAttribute('required', '')
})

import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'

async function demo() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

  // 1. Login error message
  console.log('Step 1: Login error')
  await page.goto(BASE)
  await page.fill('input[name="account"]', 'wrong@example.com')
  await page.fill('input[name="password"]', 'wrongpassword')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(3000)
  await page.screenshot({ path: 'spec/demo/30-login-error-ux.png', fullPage: true })

  // Login for real
  console.log('Logging in...')
  await page.goto(BASE)
  await page.fill('input[name="account"]', 'pedro@vezza.com.br')
  await page.fill('input[name="password"]', '9Bj_BBAwu!Q6bksN')
  await page.click('button[type="submit"]')
  await page.waitForURL('**/devices', { timeout: 15000 })
  await page.waitForTimeout(2000)

  // 3. Logout link in NavHeader
  console.log('Step 3: Logout in NavHeader')
  await page.screenshot({ path: 'spec/demo/32-navbar-logout.png', fullPage: true })

  // Get serial
  const deviceLink = page.locator('a[href^="/devices/"]').first()
  const href = await deviceLink.getAttribute('href')
  const serial = href!.split('/devices/')[1]

  // 2. Playback empty state message
  console.log('Step 2: Playback empty state')
  await page.goto(`${BASE}/camera/${serial}/1/playback`)
  await page.waitForTimeout(1000)
  await page.fill('input[type="date"]', '2026-03-19')
  await page.click('button:has-text("Load Recordings")')
  await page.waitForTimeout(5000)
  await page.screenshot({ path: 'spec/demo/31-playback-empty-state.png', fullPage: true })

  console.log('Done!')
  await browser.close()
}

demo().catch(e => {
  console.error('Demo failed:', e)
  process.exit(1)
})

import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'
const VERIFICATION_CODE = 'ABCDEF'

async function demo() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

  // ── Step 1: Error state — wrong credentials ──
  console.log('Step 1: Login error state')
  await page.goto(BASE)
  await page.waitForSelector('input[name="account"]')
  await page.fill('input[name="account"]', 'wrong@example.com')
  await page.fill('input[name="password"]', 'wrongpassword')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(3000)
  await page.screenshot({ path: 'spec/demo/01-login-error.png', fullPage: true })

  // ── Step 2: Login page (empty form) ──
  console.log('Step 2: Login page')
  await page.goto(BASE)
  await page.waitForSelector('input[name="account"]')
  await page.screenshot({ path: 'spec/demo/02-login-page.png', fullPage: true })

  // ── Step 3: Login with real credentials ──
  console.log('Step 3: Login with credentials')
  await page.fill('input[name="account"]', 'pedro@vezza.com.br')
  await page.fill('input[name="password"]', '9Bj_BBAwu!Q6bksN')
  await page.screenshot({ path: 'spec/demo/03-login-filled.png', fullPage: true })
  await page.click('button[type="submit"]')

  // ── Step 4: Devices page ──
  console.log('Step 4: Devices page')
  await page.waitForURL('**/devices', { timeout: 15000 })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: 'spec/demo/04-devices-page.png', fullPage: true })

  // ── Step 5: Camera list — verify channel order ──
  console.log('Step 5: Camera list')
  const deviceLink = page.locator('a[href^="/devices/"]').first()
  const deviceHref = await deviceLink.getAttribute('href')
  if (!deviceHref) {
    console.log('No devices found — cannot continue')
    await browser.close()
    return
  }
  const serial = deviceHref.split('/devices/')[1]
  console.log(`  Device serial: ${serial}`)
  await deviceLink.click()
  await page.waitForURL(`**/devices/${serial}`)
  await page.waitForTimeout(2000)
  await page.screenshot({ path: 'spec/demo/05-camera-list.png', fullPage: true })

  // ── Step 6: Live View — start stream ──
  console.log('Step 6: Live View — starting stream')
  // Navigate to Ch 1 live view (first channel that likely has a camera)
  const liveLink = page.locator('a[href*="/live"]').first()
  await liveLink.click()
  await page.waitForURL('**/live')
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'spec/demo/06-live-idle.png', fullPage: true })

  // Handle the verification code prompt dialog
  page.on('dialog', async dialog => {
    console.log(`  Dialog: ${dialog.message()}`)
    await dialog.accept(VERIFICATION_CODE)
  })

  // Click Start Live View
  console.log('  Clicking Start Live View...')
  await page.click('button:has-text("Start Live View")')

  // Wait for stream to establish (P2P takes 5-10s, then HLS needs segments)
  console.log('  Waiting for stream to establish...')
  // Wait for the video element to appear (indicates HLS is playing)
  try {
    await page.waitForSelector('video', { timeout: 30000 })
    console.log('  Video element appeared, waiting for content...')
    await page.waitForTimeout(10000) // Let HLS buffer some segments
    await page.screenshot({ path: 'spec/demo/07-live-streaming.png', fullPage: true })
    console.log('  Live stream screenshot captured!')
  } catch {
    console.log('  Video element did not appear in 30s, taking screenshot of current state')
    await page.screenshot({ path: 'spec/demo/07-live-streaming.png', fullPage: true })
  }

  // ── Step 7: Stop the live stream ──
  console.log('Step 7: Stopping live stream')
  const stopBtn = page.locator('button:has-text("Stop")')
  if (await stopBtn.isVisible()) {
    await stopBtn.click()
    await page.waitForTimeout(2000)
    await page.screenshot({ path: 'spec/demo/08-live-stopped.png', fullPage: true })
  }

  // ── Step 8: Playback — load recordings ──
  console.log('Step 8: Playback')
  // Navigate back to camera list, then to playback
  await page.goto(`${BASE}/camera/${serial}/1/playback`)
  await page.waitForTimeout(1000)
  await page.screenshot({ path: 'spec/demo/09-playback-idle.png', fullPage: true })

  // Select today's date (or yesterday)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const dateStr = yesterday.toISOString().split('T')[0] // YYYY-MM-DD
  console.log(`  Setting date: ${dateStr}`)
  await page.fill('input[type="date"]', dateStr)

  // Click Load Recordings
  console.log('  Loading recordings...')
  await page.click('button:has-text("Load Recordings")')
  await page.waitForTimeout(5000) // Wait for API response
  await page.screenshot({ path: 'spec/demo/10-recordings-loaded.png', fullPage: true })

  // Check if timeline bar and recording list appeared
  const recordingItems = page.locator('[class*="recordingItem"]')
  const count = await recordingItems.count()
  console.log(`  Found ${count} recordings`)

  if (count > 0) {
    // Click first recording to play
    console.log('  Playing first recording...')
    await recordingItems.first().click()

    // Wait for playback stream
    try {
      await page.waitForSelector('video', { timeout: 30000 })
      console.log('  Playback video element appeared, waiting for content...')
      await page.waitForTimeout(10000)
      await page.screenshot({ path: 'spec/demo/11-playback-playing.png', fullPage: true })
      console.log('  Playback screenshot captured!')
    } catch {
      console.log('  Playback video did not appear in 30s, taking current state')
      await page.screenshot({ path: 'spec/demo/11-playback-playing.png', fullPage: true })
    }

    // Stop playback
    const stopPlayback = page.locator('button:has-text("Stop Playback")')
    if (await stopPlayback.isVisible()) {
      await stopPlayback.click()
      await page.waitForTimeout(2000)
    }
  } else {
    // Try today instead
    console.log('  No recordings yesterday, trying today...')
    const todayStr = today.toISOString().split('T')[0]
    await page.fill('input[type="date"]', todayStr)
    await page.click('button:has-text("Load Recordings")')
    await page.waitForTimeout(5000)
    await page.screenshot({ path: 'spec/demo/10b-recordings-today.png', fullPage: true })
  }

  // ── Step 9: Breadcrumb navigation ──
  console.log('Step 9: Breadcrumb navigation')
  const devicesNav = page.locator('a[href="/devices"]').first()
  if (await devicesNav.isVisible()) {
    await devicesNav.click()
    await page.waitForURL('**/devices')
    await page.waitForTimeout(1000)
    await page.screenshot({ path: 'spec/demo/12-breadcrumb-back.png', fullPage: true })
  }

  console.log('Demo complete! All screenshots saved to spec/demo/')
  await browser.close()
}

demo().catch(e => {
  console.error('Demo failed:', e)
  process.exit(1)
})

import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'

async function demo() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

  // Login first
  console.log('Logging in...')
  await page.goto(BASE)
  await page.fill('input[name="account"]', 'pedro@vezza.com.br')
  await page.fill('input[name="password"]', '9Bj_BBAwu!Q6bksN')
  await page.click('button[type="submit"]')
  await page.waitForURL('**/devices', { timeout: 15000 })
  await page.waitForTimeout(2000)

  // Re-screenshot devices page (name fallback)
  console.log('Step 1: Devices page')
  await page.screenshot({ path: 'spec/demo/20-devices-confirmed.png', fullPage: true })

  // Navigate to camera list (sort order)
  console.log('Step 2: Camera list')
  await page.locator('a[href^="/devices/"]').first().click()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: 'spec/demo/21-cameras-sorted.png', fullPage: true })

  // Get serial from URL
  const url = page.url()
  const serial = url.split('/devices/')[1]
  console.log(`  Serial: ${serial}`)

  // Try playback on multiple channels and dates
  const channels = [1, 4, 2, 5]
  const dates = ['2026-03-19', '2026-03-18', '2026-03-15', '2026-03-17', '2026-03-16']
  let foundRecordings = false

  for (const ch of channels) {
    if (foundRecordings) break
    for (const date of dates) {
      if (foundRecordings) break
      console.log(`  Trying Ch ${ch}, date ${date}...`)
      await page.goto(`${BASE}/camera/${serial}/${ch}/playback`)
      await page.waitForTimeout(1000)

      await page.fill('input[type="date"]', date)
      await page.click('button:has-text("Load Recordings")')
      await page.waitForTimeout(5000)

      // Check for recording items
      const items = page.locator('[class*="recordingItem"]')
      const count = await items.count()
      console.log(`    Found ${count} recordings`)

      if (count > 0) {
        foundRecordings = true
        console.log(`  SUCCESS: Found ${count} recordings on Ch ${ch}, ${date}`)

        // Screenshot timeline bar + recording list
        await page.screenshot({ path: 'spec/demo/22-recordings-timeline.png', fullPage: true })

        // Click first recording to play
        console.log('  Playing first recording...')
        await items.first().click()

        try {
          await page.waitForSelector('video', { timeout: 30000 })
          console.log('  Video element appeared, waiting for buffering...')
          await page.waitForTimeout(10000)
          await page.screenshot({ path: 'spec/demo/23-playback-playing.png', fullPage: true })
          console.log('  Playback video screenshot captured!')
        } catch {
          console.log('  Video did not appear in 30s')
          await page.screenshot({ path: 'spec/demo/23-playback-playing.png', fullPage: true })
        }

        // Stop playback
        const stopBtn = page.locator('button:has-text("Stop Playback")')
        if (await stopBtn.isVisible()) {
          await stopBtn.click()
          await page.waitForTimeout(2000)
        }
      }
    }
  }

  if (!foundRecordings) {
    console.log('  No recordings found on any channel/date combination')
    // Screenshot the last attempt as evidence
    await page.screenshot({ path: 'spec/demo/22-no-recordings.png', fullPage: true })

    // Also check API responses directly through the page context
    for (const ch of [1, 4]) {
      for (const date of ['2026-03-19', '2026-03-18']) {
        const response = await page.evaluate(async ({ serial, ch, date }) => {
          const res = await fetch(`/api/devices/${serial}/${ch}/recordings?startTime=${date}T00:00:00Z&stopTime=${date}T23:59:59Z`)
          return await res.json()
        }, { serial, ch, date })
        console.log(`  API Ch ${ch} ${date}:`, JSON.stringify(response))
      }
    }
  }

  console.log('Playback demo complete!')
  await browser.close()
}

demo().catch(e => {
  console.error('Demo failed:', e)
  process.exit(1)
})

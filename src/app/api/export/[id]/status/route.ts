import { NextResponse } from 'next/server'
import { statSync } from 'node:fs'
import { exportJobs } from '../../jobs'
import { exportPercent } from '../../export-helpers'

/**
 * GET /api/export/[id]/status
 * Poll an export job: state, percent-of-range, output size so far, filename.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const job = exportJobs.get(id)
  if (!job) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let sizeBytes = 0
  try {
    sizeBytes = statSync(job.outputPath).size
  } catch {
    // ffmpeg hasn't created the file yet — report 0 until it does.
  }

  const percent = job.state === 'done'
    ? 100
    : exportPercent(job.pipe.progressSeconds, job.requestedDurationSec)

  return NextResponse.json({
    state: job.state,
    percent,
    sizeBytes,
    durationSec: job.requestedDurationSec,
    filename: job.filename,
    error: job.error,
  })
}

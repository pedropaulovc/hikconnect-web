import { NextResponse } from 'next/server'
import { createReadStream, statSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { exportJobs } from '../../jobs'

/**
 * GET /api/export/[id]/download
 * Stream the finished MP4 as an attachment, then delete it (the TTL backstop in
 * the start route covers exports that are never downloaded).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const job = exportJobs.get(id)
  if (!job) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (job.state !== 'done') {
    return NextResponse.json({ error: 'export not finished' }, { status: 409 })
  }

  // The TTL sweep can fire in the gap between the 'done' check and this stat;
  // a missing file means the export was already swept — drop the stale job and
  // 404 instead of letting statSync throw an unhandled 500 (mirrors status route).
  let size: number
  try {
    size = statSync(job.outputPath).size
  } catch {
    exportJobs.delete(id)
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const nodeStream = createReadStream(job.outputPath)

  // Clean up the export dir once the file has been fully streamed to the client.
  nodeStream.on('close', () => {
    rmSync(dirname(job.outputPath), { recursive: true, force: true })
    exportJobs.delete(id)
  })

  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream
  return new Response(webStream, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${job.filename}"`,
      'Content-Length': String(size),
    },
  })
}

import { NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const CONTENT_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params
  const [sessionId, ...rest] = path
  const filePath = join(tmpdir(), 'hls', sessionId, ...rest)

  // Prevent path traversal — resolved path must stay inside the HLS directory
  const hlsRoot = join(tmpdir(), 'hls')
  if (!filePath.startsWith(hlsRoot)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const data = await readFile(filePath)
    const ext = filePath.split('.').pop() ?? ''
    const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream'

    return new NextResponse(data, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': ext === 'm3u8' ? 'no-cache' : 'public, max-age=60',
      },
    })
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
}

export function isDeviceOnline(status: number): boolean {
  return status === 1
}

export function buildCameraLinks(serial: string, ch: number): { live: string; playback: string } {
  return {
    live: `/camera/${serial}/${ch}/live`,
    playback: `/camera/${serial}/${ch}/playback`,
  }
}

export function buildRecordingsUrl(serial: string, ch: number, date: string): string {
  return `/api/devices/${serial}/${ch}/recordings?startTime=${date}T00:00:00Z&stopTime=${date}T23:59:59Z`
}

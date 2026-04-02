/**
 * Detect the server's public IP address for P2P registration.
 * Uses PUBLIC_IP env var if set, otherwise queries an external service.
 * Result is cached for the process lifetime.
 */

let cachedIp: string | null = null

export async function getPublicIp(): Promise<string> {
  if (process.env.PUBLIC_IP) return process.env.PUBLIC_IP
  if (cachedIp) return cachedIp

  try {
    const resp = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) })
    const data = await resp.json() as { ip: string }
    cachedIp = data.ip
    return cachedIp
  } catch {
    console.warn('[PublicIP] Failed to detect public IP, using 0.0.0.0')
    return '0.0.0.0'
  }
}

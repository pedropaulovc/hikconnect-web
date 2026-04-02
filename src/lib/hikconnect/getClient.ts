// src/lib/hikconnect/getClient.ts
import { HikConnectClient } from './client'
import { sessionStore } from './session'

export function getAuthenticatedClient(): HikConnectClient {
  const session = sessionStore.get()
  if (!session) throw new Error('Not authenticated')

  const client = new HikConnectClient({
    baseUrl: session.apiDomain,
  })
  client.setSession(session)
  return client
}

export type ApiProtocol = 'openai-compatible' | 'anthropic-messages' | 'gemini'

export interface ApiStatus {
  configured: boolean
  protocol: ApiProtocol | string
  base_url: string
  model: string
  source: string
  message?: string
}

const configuredWsUrl = (import.meta as unknown as { env?: { VITE_WS_URL?: string } }).env?.VITE_WS_URL
export const API_URL = (configuredWsUrl || 'ws://localhost:8000/ws')
  .replace(/^ws:/, 'http:')
  .replace(/^wss:/, 'https:')
  .replace(/\/ws\/?$/, '')

export async function fetchApiStatus(): Promise<ApiStatus> {
  const response = await fetch(`${API_URL}/api/config`)
  if (!response.ok) throw new Error(`读取 API 配置失败（${response.status}）`)
  return (await response.json()) as ApiStatus
}

export async function saveApiConfig(input: {
  protocol: ApiProtocol
  base_url: string
  api_key: string
  model: string
}): Promise<ApiStatus> {
  const response = await fetch(`${API_URL}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await response.json().catch(() => ({})) as { detail?: string }
  if (!response.ok) throw new Error(body.detail || `保存 API 配置失败（${response.status}）`)
  return body as unknown as ApiStatus
}

export async function clearApiConfig(): Promise<ApiStatus> {
  const response = await fetch(`${API_URL}/api/config`, { method: 'DELETE' })
  if (!response.ok) throw new Error(`清除 API 配置失败（${response.status}）`)
  return (await response.json()) as ApiStatus
}

// ─── Channel Provider Interface ───────────────────────────────────────────────

export interface ChannelProvider {
  type: string
  post(content: string, title?: string, config?: Record<string, unknown>): Promise<{ url?: string; id?: string }>
  read?(limit?: number): Promise<Array<{ id: string; content: string; author?: string; date: string }>>
}

// Built by Weblease

export interface ProviderRegistry {
  get(type: string): ChannelProvider | undefined
  register(type: string, provider: ChannelProvider): void
  list(): string[]
}

export function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, ChannelProvider>()
  return {
    get:      (type)             => providers.get(type),
    register: (type, provider)  => { providers.set(type, provider) },
    list:     ()                 => Array.from(providers.keys()),
  }
}

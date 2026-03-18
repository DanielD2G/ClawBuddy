export interface TelegramChannelConfig {
  botToken: string
  botUsername?: string
}

export interface ChannelConfig {
  telegram: TelegramChannelConfig
}

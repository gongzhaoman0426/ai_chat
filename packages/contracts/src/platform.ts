import { z } from 'zod';
export const platformSchema = z.enum(['pinduoduo', 'douyin', 'goofish', 'kuaishou', 'qianniu']);
export type PlatformId = z.infer<typeof platformSchema>;
export function platformsForRuntime(runtimePlatform?: string): PlatformId[] {
  return platformSchema.options.filter(
    (platform) => platform !== 'qianniu' || runtimePlatform === 'win32',
  );
}
export const platformNames: Record<PlatformId, string> = {
  pinduoduo: '拼多多',
  douyin: '抖店',
  goofish: '闲鱼',
  kuaishou: '快手',
  qianniu: '千牛',
};
export const platformMarks: Record<PlatformId, string> = {
  pinduoduo: '拼',
  douyin: '抖',
  goofish: '闲',
  kuaishou: '快',
  qianniu: '千',
};
export type QianniuSetupPhase =
  | 'unavailable'
  | 'not_configured'
  | 'ready'
  | 'starting'
  | 'waiting_login'
  | 'injecting'
  | 'waiting_hook'
  | 'connected'
  | 'error';
export interface QianniuSetupState {
  supported: boolean;
  downloadUrl: string;
  executablePath: string | null;
  phase: QianniuSetupPhase;
  message: string;
  scriptUrl: string;
  tcpPort: number;
  accounts: Array<{ loginId: string; websocket: boolean; tcp: boolean }>;
  downloading?: boolean;
}
// Opaque platform IDs come from observed SDK messages/conversations, never from an LLM.
export const platformContextSchema = z
  .object({
    itemId: z
      .string()
      .regex(/^\d{1,30}$/)
      .optional(),
    sessionType: z.number().int().min(0).max(1000).optional(),
    sellerId: z
      .string()
      .regex(/^\d{1,30}$/)
      .optional(),
    userId: z.string().min(1).max(200).optional(),
    buyerNick: z.string().min(1).max(200).optional(),
    securityUserId: z.string().min(1).max(500).optional(),
    securityConversationId: z.string().min(1).max(1000).optional(),
  })
  .strict();
export type PlatformConversationContext = z.infer<typeof platformContextSchema>;
export const connectionKey = (accountId: string) => `platform.connection:${accountId}`;
export const autoconnectKey = (accountId: string) => `platform.autoconnect:${accountId}`;

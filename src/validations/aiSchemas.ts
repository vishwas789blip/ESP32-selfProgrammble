import { z } from 'zod'

export const aiChatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
})

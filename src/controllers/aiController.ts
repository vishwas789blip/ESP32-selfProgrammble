import type { Response } from 'express'
import type { AuthRequest } from '../types/index.js'
import * as aiService from '../services/aiService.js'
import { getUserId, send } from './common.js'

export const aiController = {
  chat: async (req: AuthRequest, res: Response) =>
    send(res, {
      reply: await aiService.chat(getUserId(req), req.body.message),
    }),
}

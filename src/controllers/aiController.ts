import type { AuthRequest } from '../types/index.js';
import * as aiService from '../services/aiService.js';
import { getUserId, send } from './common.js';

export const aiController = {
  chat: async (req: AuthRequest, res: any) =>
    send(res, {
      reply: await aiService.chat(getUserId(req), req.body.message),
    }),
};

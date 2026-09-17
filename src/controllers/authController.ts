import type { AuthRequest } from '../types/index.js';
import * as authService from '../services/authService.js';
import { getUserId, send } from './common.js';

export const authController = {
  register: async (req: AuthRequest, res: any) =>
    send(res, await authService.register(req.body)),

  login: async (req: AuthRequest, res: any) =>
    send(res, await authService.login(req.body)),

  me: async (req: AuthRequest, res: any) =>
    send(res, { user: await authService.me(getUserId(req)) }),
};

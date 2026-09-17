import type { AuthRequest } from '../types/index.js';
import { listEvents } from '../services/eventService.js';
import { getUserId, send } from './common.js';

export const eventController = {
  list: async (req: AuthRequest, res: any) =>
    send(res, await listEvents(getUserId(req), {
      deviceId: typeof req.query.deviceId === 'string'
        ? req.query.deviceId
        : undefined,
      type: typeof req.query.type === 'string'
        ? req.query.type
        : undefined,
      limit: Number(req.query.limit) || 50,
    })),
};

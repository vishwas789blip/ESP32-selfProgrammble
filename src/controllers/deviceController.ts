import type { AuthRequest } from '../types/index.js';
import * as resourceServices from '../services/resourceServices.js';
import { getParam, getUserId, send } from './common.js';

export const deviceController = {
  list: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.devices.list(getUserId(req))),

  get: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.devices.get(getUserId(req), getParam(req.params.id))),

  create: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.devices.create(getUserId(req), req.body)),

  update: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.devices.update(getUserId(req), getParam(req.params.id), req.body)),

  remove: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.devices.remove(getUserId(req), getParam(req.params.id))),

  heartbeat: async (req: AuthRequest, res: any) =>
    send(res, {
      device: await resourceServices.devices.heartbeat(getUserId(req), getParam(req.params.id)),
      simulated: true,
    }),

  getConfig: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.devices.getConfig(getUserId(req), getParam(req.params.id))),

  updateConfig: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.devices.updateConfig(
      getUserId(req),
      getParam(req.params.id),
      req.body,
    )),
};

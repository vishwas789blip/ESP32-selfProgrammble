import type { AuthRequest } from '../types/index.js';
import { Actuator } from '../models/Actuator.js';
import * as resourceServices from '../services/resourceServices.js';
import { getParam, getUserId, send } from './common.js';

export const actuatorController = {
  list: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.listActuators(
      getUserId(req),
      getParam(req.params.deviceId),
    )),

  create: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.createActuator(
      getUserId(req),
      getParam(req.params.deviceId),
      req.body,
    )),

  update: async (req: AuthRequest, res: any) => {
    const item = await resourceServices.ownedResource(
      Actuator,
      getUserId(req),
      getParam(req.params.id),
    );

    Object.assign(item, req.body);
    const saved = await item.save();

    await resourceServices.pushDeviceConfig(String(item.deviceId));
    send(res, saved);
  },

  remove: async (req: AuthRequest, res: any) => {
    const item = await resourceServices.ownedResource(
      Actuator,
      getUserId(req),
      getParam(req.params.id),
    );

    const deviceId = String(item.deviceId);
    await item.deleteOne();

    await resourceServices.pushDeviceConfig(deviceId);
    send(res, null);
  },

  command: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.commandActuator(
      getUserId(req),
      getParam(req.params.id),
      req.body.command,
      req.body.duration,
    )),
};

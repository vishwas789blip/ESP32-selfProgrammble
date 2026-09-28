import type { AuthRequest } from '../types/index.js';
import { Sensor } from '../models/Sensor.js';
import * as resourceServices from '../services/resourceServices.js';
import { getParam, getUserId, send } from './common.js';

export const sensorController = {
  list: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.listSensors(getUserId(req), getParam(req.params.deviceId))),

  create: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.createSensor(
      getUserId(req),
      getParam(req.params.deviceId),
      req.body,
    )),

  get: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.ownedResource(
      Sensor,
      getUserId(req),
      getParam(req.params.id),
    )),

  update: async (req: AuthRequest, res: any) => {
    const item = await resourceServices.ownedResource(
      Sensor,
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
      Sensor,
      getUserId(req),
      getParam(req.params.id),
    );

    const deviceId = String(item.deviceId);
    const itemId = String(item._id);
    await item.deleteOne();

    // Automations that referenced this sensor are now incomplete: disable them.
    await resourceServices.disableAutomationsReferencing({ sensorId: itemId });

    await resourceServices.pushDeviceConfig(deviceId);
    send(res, null);
  },
};

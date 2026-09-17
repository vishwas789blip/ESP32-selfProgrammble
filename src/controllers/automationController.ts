import type { AuthRequest } from '../types/index.js';
import * as automationService from '../services/automationService.js';
import * as resourceServices from '../services/resourceServices.js';
import { getParam, getUserId, send } from './common.js';

export const automationController = {
  list: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.automations.list(getUserId(req))),

  get: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.automations.get(
      getUserId(req),
      getParam(req.params.id),
    )),

  create: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.automations.create(getUserId(req), req.body)),

  update: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.automations.update(
      getUserId(req),
      getParam(req.params.id),
      req.body,
    )),

  remove: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.automations.remove(
      getUserId(req),
      getParam(req.params.id),
    )),

  toggle: async (req: AuthRequest, res: any) =>
    send(res, await resourceServices.automations.toggle(
      getUserId(req),
      getParam(req.params.id),
    )),

  test: async (req: AuthRequest, res: any) =>
    send(res, await automationService.testAutomation(
      getUserId(req),
      getParam(req.params.id),
    )),
};

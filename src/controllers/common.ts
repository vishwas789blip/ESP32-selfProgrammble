import type { Response } from 'express';
import type { AuthRequest } from '../types/index.js';

export const getUserId = (req: AuthRequest): string => req.user!.id;

export const getParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] : (value ?? '');

export const send = (res: Response, data: unknown) =>
  res.json({ success: true, data });

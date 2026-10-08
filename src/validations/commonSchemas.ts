import { z } from 'zod'
import { Types } from 'mongoose'

export const objectIdSchema = z
  .string()
  .refine((value) => Types.ObjectId.isValid(value), 'Invalid ObjectId')

// GPIO pins valid for ESP32 DevKit (0–39, excluding flash-reserved 6–11).
export const gpioSchema = z.number().int().min(0).max(39).optional()

export const paramsIdSchema = z.object({ id: objectIdSchema })

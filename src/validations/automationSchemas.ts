import { z } from 'zod'
import { objectIdSchema } from './commonSchemas.js'

export const automationValue = z.union([
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
])

const condition = z.object({
  sensorId: objectIdSchema,
  operator: z.string().trim().min(1).max(50),
  value: automationValue,
})

const action = z.object({
  actuatorId: objectIdSchema,
  command: z.string().trim().min(1).max(100),
  value: automationValue.optional(),
  duration: z.number().int().positive().max(86400).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
})

export const automationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  deviceId: objectIdSchema,
  conditions: z.array(condition).min(1).max(50),
  actions: z.array(action).min(1).max(50),
  enabled: z.boolean().optional(),
})

export const automationUpdateSchema = automationSchema.partial()

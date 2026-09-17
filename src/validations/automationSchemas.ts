import { z } from 'zod'
import { objectIdSchema } from './commonSchemas.js'
const condition = z.object({ sensorId: objectIdSchema, operator: z.string().trim().min(1).max(20), value: z.unknown() })
const action = z.object({ actuatorId: objectIdSchema, command: z.string().trim().min(1).max(50), duration: z.number().positive().max(86400).optional() })
export const automationSchema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).optional(), deviceId: objectIdSchema, conditions: z.array(condition).max(50), actions: z.array(action).max(50), enabled: z.boolean().optional() })
export const automationUpdateSchema = automationSchema.partial()

import { z } from 'zod'
const timestamp = z.string().datetime({ offset: true }).optional()
// `readings` is a generic gpio -> value map, e.g. { "26": true, "34": 23.5 }.
// Firmware should send one entry per registered sensor, keyed by that
// sensor's gpio pin (same pins the device already receives via configSchema).
const readingValue = z.union([z.boolean(), z.number(), z.string()])
export const telemetrySchema = z.object({
  deviceId: z.string().min(1),
  readings: z.record(z.string(), readingValue).optional(),
  // Legacy fields kept only so older PIR-only firmware keeps working.
  pirEnabled: z.boolean().optional(),
  pirState: z.boolean().optional(),
  buzzerDuration: z.number().optional(),
  maxRules: z.number().optional(),
  enabledRules: z.number().optional(),
  rules: z.array(z.unknown()).optional(),
  timestamp
})
export const statusSchema = z.object({ 
    deviceId: z.string().min(1), 
    status: z.enum(['online', 'offline']), 
    firmwareVersion: z.string().max(100).optional(), 
    ipAddress: z.string().max(64).optional(), 
    timestamp 
})
export const commandSchema = z.object({ type: z.literal('actuator'), actuatorId: z.string().min(1), command: z.enum(['ON', 'OFF']), duration: z.number().int().positive().max(86400).optional(), timestamp })
export const configSchema = z.object({
  deviceId: z.string().min(1),

  sensors: z.array(
    z.object({
      sensorId: z.string(),
      type: z.string(),
      gpio: z.number().int().min(0).max(39),
    }),
  ),

  actuators: z.array(
    z.object({
      actuatorId: z.string(),
      type: z.string(),
      gpio: z.number().int().min(0).max(39),
    }),
  ),

  automations: z.array(
    z.object({
      automationId: z.string(),
      name: z.string(),
      enabled: z.boolean(),

      conditions: z.array(
        z.object({
          sensorId: z.string(),
          operator: z.string(),
          value: z.unknown(),
        }),
      ),

      actions: z.array(
        z.object({
          actuatorId: z.string(),
          command: z.enum(['ON', 'OFF']),
          duration: z.number().int().positive().max(86400).optional(),
        }),
      ),
    }),
  ).optional(),
})
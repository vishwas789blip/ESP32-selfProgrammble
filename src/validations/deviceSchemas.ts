import { z } from 'zod'

const networkMac = z.string().trim().max(64)

export const deviceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  deviceId: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  description: z.string().trim().max(500).optional(),
  connectionType: z.enum(['wifi', 'bluetooth', 'mqtt']),
  ipAddress: z.string().trim().max(64).optional(),
  macAddress: networkMac.optional(),
  firmwareVersion: z.string().trim().max(64).optional(),
})

// Runtime fields such as status/lastSeen are owned by MQTT/device telemetry,
// not by the dashboard's generic update endpoint.
export const deviceUpdateSchema = deviceSchema.partial().omit({ deviceId: true })
export const deviceConfigSchema = z.record(z.string(), z.unknown())

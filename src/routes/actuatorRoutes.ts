import { Router } from 'express'
import { z } from 'zod'
import { authMiddleware } from '../middleware/authMiddleware.js'
import { validate } from '../middleware/validateMiddleware.js'
import { actuatorController } from '../controllers/index.js'
import { asyncHandler } from '../utils/asyncHandler.js'

const actuatorSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.string().trim().min(1).max(100),
  interface: z.string().trim().min(1).max(50).optional(),
  gpio: z.number().int().min(0).max(48).optional(),
  pins: z.record(z.string(), z.number().int().min(0).max(48)).optional(),
  address: z.union([z.number().int(), z.string()]).optional(),
  channel: z.union([z.number().int(), z.string()]).optional(),
  state: z.unknown().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

const commandSchema = z.object({
  command: z.string().trim().min(1).max(100),
  value: z.union([z.boolean(), z.number().finite(), z.string(), z.null()]).optional(),
  duration: z.number().int().positive().max(86400).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
})

export const actuatorRoutes = Router()
actuatorRoutes.use(authMiddleware)
actuatorRoutes.get('/devices/:deviceId/actuators', asyncHandler(actuatorController.list))
actuatorRoutes.post('/devices/:deviceId/actuators', validate(actuatorSchema), asyncHandler(actuatorController.create))
actuatorRoutes.put('/actuators/:id', validate(actuatorSchema.partial()), asyncHandler(actuatorController.update))
actuatorRoutes.delete('/actuators/:id', asyncHandler(actuatorController.remove))
actuatorRoutes.post('/actuators/:id/command', validate(commandSchema), asyncHandler(actuatorController.command))

import { Router } from 'express'
import { z } from 'zod'
import { authMiddleware } from '../middleware/authMiddleware.js'
import { validate } from '../middleware/validateMiddleware.js'
import { sensorController } from '../controllers/index.js'
import { asyncHandler } from '../utils/asyncHandler.js'

const sensorSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.string().trim().min(1).max(100),
  interface: z.string().trim().min(1).max(50).optional(),
  gpio: z.number().int().min(0).max(48).optional(),
  pins: z.record(z.string(), z.number().int().min(0).max(48)).optional(),
  address: z.union([z.number().int(), z.string()]).optional(),
  channel: z.union([z.number().int(), z.string()]).optional(),
  value: z.unknown().optional(),
  unit: z.string().trim().max(50).optional(),
  status: z.enum(['normal', 'warning', 'error', 'unknown']).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

export const sensorRoutes = Router()
sensorRoutes.use(authMiddleware)
sensorRoutes.get('/devices/:deviceId/sensors', asyncHandler(sensorController.list))
sensorRoutes.post('/devices/:deviceId/sensors', validate(sensorSchema), asyncHandler(sensorController.create))
sensorRoutes.get('/sensors/:id', asyncHandler(sensorController.get))
sensorRoutes.put('/sensors/:id', validate(sensorSchema.partial()), asyncHandler(sensorController.update))
sensorRoutes.delete('/sensors/:id', asyncHandler(sensorController.remove))

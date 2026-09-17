import { Router } from 'express'
import { z } from 'zod'
import { authMiddleware } from '../middleware/authMiddleware.js'
import { validate } from '../middleware/validateMiddleware.js'
import { sensorController } from '../controllers/index.js'
import { gpioSchema } from '../validations/commonSchemas.js'

const sensorSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.string().trim().min(1).max(50),
  gpio: gpioSchema,
  value: z.unknown().optional(),
  unit: z.string().trim().max(30).optional(),
  status: z.enum(['normal', 'warning', 'error']).optional(),
})

export const sensorRoutes = Router()

sensorRoutes.use(authMiddleware)

sensorRoutes.get('/devices/:deviceId/sensors', sensorController.list)
sensorRoutes.post('/devices/:deviceId/sensors', validate(sensorSchema), sensorController.create)

sensorRoutes.get('/sensors/:id', sensorController.get)
sensorRoutes.put('/sensors/:id', validate(sensorSchema.partial()), sensorController.update)
sensorRoutes.delete('/sensors/:id', sensorController.remove)

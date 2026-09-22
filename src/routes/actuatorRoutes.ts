import { Router } from 'express'
import { z } from 'zod'
import { authMiddleware } from '../middleware/authMiddleware.js'
import { validate } from '../middleware/validateMiddleware.js'
import { actuatorController } from '../controllers/index.js'
import { gpioSchema } from '../validations/commonSchemas.js'
import { asyncHandler } from '../utils/asyncHandler.js'

const actuatorSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.string().trim().min(1).max(50),
  gpio: gpioSchema,
  state: z.enum(['on', 'off']).optional(),
})

const commandSchema = z.object({
  command: z.enum(['ON', 'OFF']),
  duration: z.number().int().positive().max(86400).optional(),
})

export const actuatorRoutes = Router()

actuatorRoutes.use(authMiddleware)

actuatorRoutes.get('/devices/:deviceId/actuators', asyncHandler(actuatorController.list))
actuatorRoutes.post('/devices/:deviceId/actuators', validate(actuatorSchema), asyncHandler(actuatorController.create))

actuatorRoutes.put('/actuators/:id', validate(actuatorSchema.partial()), asyncHandler(actuatorController.update))
actuatorRoutes.delete('/actuators/:id', asyncHandler(actuatorController.remove))
actuatorRoutes.post('/actuators/:id/command', validate(commandSchema), asyncHandler(actuatorController.command))

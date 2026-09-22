import { Router } from 'express'
import { authMiddleware } from '../middleware/authMiddleware.js'
import { validate } from '../middleware/validateMiddleware.js'
import { deviceSchema, deviceUpdateSchema, deviceConfigSchema } from '../validations/deviceSchemas.js'
import { deviceController } from '../controllers/index.js'
import { asyncHandler } from '../utils/asyncHandler.js'

export const deviceRoutes = Router()

deviceRoutes.use(authMiddleware)

deviceRoutes.get('/', asyncHandler(deviceController.list))
deviceRoutes.post('/', validate(deviceSchema), asyncHandler(deviceController.create))
deviceRoutes.get('/:id', asyncHandler(deviceController.get))
deviceRoutes.put('/:id', validate(deviceUpdateSchema), asyncHandler(deviceController.update))
deviceRoutes.delete('/:id', asyncHandler(deviceController.remove))

deviceRoutes.post('/:id/heartbeat', asyncHandler(deviceController.heartbeat))
deviceRoutes.get('/:id/config', asyncHandler(deviceController.getConfig))
deviceRoutes.put('/:id/config', validate(deviceConfigSchema), asyncHandler(deviceController.updateConfig))

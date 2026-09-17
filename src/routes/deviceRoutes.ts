import { Router } from 'express'
import { authMiddleware } from '../middleware/authMiddleware.js'
import { validate } from '../middleware/validateMiddleware.js'
import { deviceSchema, deviceUpdateSchema, deviceConfigSchema } from '../validations/deviceSchemas.js'
import { deviceController } from '../controllers/index.js'

export const deviceRoutes = Router()

deviceRoutes.use(authMiddleware)

deviceRoutes.get('/', deviceController.list)
deviceRoutes.post('/', validate(deviceSchema), deviceController.create)
deviceRoutes.get('/:id', deviceController.get)
deviceRoutes.put('/:id', validate(deviceUpdateSchema), deviceController.update)
deviceRoutes.delete('/:id', deviceController.remove)

deviceRoutes.post('/:id/heartbeat', deviceController.heartbeat)
deviceRoutes.get('/:id/config', deviceController.getConfig)
deviceRoutes.put('/:id/config', validate(deviceConfigSchema), deviceController.updateConfig)

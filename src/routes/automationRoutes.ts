import { Router } from 'express'
import { authMiddleware } from '../middleware/authMiddleware.js'
import { validate } from '../middleware/validateMiddleware.js'
import { automationSchema, automationUpdateSchema } from '../validations/automationSchemas.js'
import { automationController } from '../controllers/index.js'

export const automationRoutes = Router()

automationRoutes.use(authMiddleware)

automationRoutes.get('/', automationController.list)
automationRoutes.post('/', validate(automationSchema), automationController.create)
automationRoutes.get('/:id', automationController.get)
automationRoutes.put('/:id', validate(automationUpdateSchema), automationController.update)
automationRoutes.delete('/:id', automationController.remove)
automationRoutes.patch('/:id/toggle', automationController.toggle)
automationRoutes.post('/:id/test', automationController.test)

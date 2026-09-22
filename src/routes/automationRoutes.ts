import { Router } from 'express'
import { authMiddleware } from '../middleware/authMiddleware.js'
import { validate } from '../middleware/validateMiddleware.js'
import { automationSchema, automationUpdateSchema } from '../validations/automationSchemas.js'
import { automationController } from '../controllers/index.js'
import { asyncHandler } from '../utils/asyncHandler.js'

export const automationRoutes = Router()

automationRoutes.use(authMiddleware)

automationRoutes.get('/', asyncHandler(automationController.list))
automationRoutes.post('/', validate(automationSchema), asyncHandler(automationController.create))
automationRoutes.get('/:id', asyncHandler(automationController.get))
automationRoutes.put('/:id', validate(automationUpdateSchema), asyncHandler(automationController.update))
automationRoutes.delete('/:id', asyncHandler(automationController.remove))
automationRoutes.patch('/:id/toggle', asyncHandler(automationController.toggle))
automationRoutes.post('/:id/test', asyncHandler(automationController.test))

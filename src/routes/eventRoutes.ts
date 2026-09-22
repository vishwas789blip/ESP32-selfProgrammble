import { Router } from 'express'
import { authMiddleware } from '../middleware/authMiddleware.js'
import { eventController } from '../controllers/index.js'
import { asyncHandler } from '../utils/asyncHandler.js'

export const eventRoutes = Router()

eventRoutes.use(authMiddleware)

eventRoutes.get('/', asyncHandler(eventController.list))

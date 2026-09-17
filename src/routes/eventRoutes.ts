import { Router } from 'express'
import { authMiddleware } from '../middleware/authMiddleware.js'
import { eventController } from '../controllers/index.js'

export const eventRoutes = Router()

eventRoutes.use(authMiddleware)

eventRoutes.get('/', eventController.list)

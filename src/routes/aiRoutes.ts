import { Router } from 'express'
import { authMiddleware } from '../middleware/authMiddleware.js'
import { validate } from '../middleware/validateMiddleware.js'
import { aiChatSchema } from '../validations/aiSchemas.js'
import { aiController } from '../controllers/index.js'

export const aiRoutes = Router()

aiRoutes.use(authMiddleware)

aiRoutes.post('/chat', validate(aiChatSchema), aiController.chat)

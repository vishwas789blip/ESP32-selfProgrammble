import { Router } from 'express'
import { authMiddleware } from '../middleware/authMiddleware.js'
import { validate } from '../middleware/validateMiddleware.js'
import { registerSchema, loginSchema } from '../validations/authSchemas.js'
import { authController } from '../controllers/index.js'

export const authRoutes = Router()

authRoutes.post('/register', validate(registerSchema), authController.register)
authRoutes.post('/login', validate(loginSchema), authController.login)
authRoutes.get('/me', authMiddleware, authController.me)

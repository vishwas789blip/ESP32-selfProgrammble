import { RequestHandler } from 'express'
export const notFoundMiddleware: RequestHandler = (_req, res) => res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } })

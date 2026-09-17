import { Response, NextFunction } from 'express'
import { AuthRequest } from '../types/index.js'
import { verifyToken } from '../utils/generateToken.js'
export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const value = req.header('authorization')
  if (!value?.startsWith('Bearer ')) { res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }); return }
  try { req.user = { id: verifyToken(value.slice(7)) }; next() } catch { res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }) }
}

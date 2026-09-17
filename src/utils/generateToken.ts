import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

export function generateToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] })
}

export function verifyToken(token: string): string {
  const payload = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload
  if (typeof payload.sub !== 'string') throw new Error('Invalid token subject')
  return payload.sub
}

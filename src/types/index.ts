import { Request } from 'express'
import { Types } from 'mongoose'

export type AuthRequest = Request & { user?: { id: string } }
export type Id = Types.ObjectId
export type DeviceStatus = 'online' | 'offline'
export type ConnectionType = 'wifi' | 'bluetooth' | 'mqtt'
export type EventType = 'sensor' | 'actuator' | 'automation' | 'system'

export type ApiErrorShape = { code: string; message: string; details?: unknown }

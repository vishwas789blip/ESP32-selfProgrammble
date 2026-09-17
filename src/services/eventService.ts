import { Event } from '../models/Event.js'
import { Types } from 'mongoose'
import { broadcastEvent } from './realtimeService.js'
export async function createEvent(input: { userId: string; deviceId?: string; type: 'sensor'|'actuator'|'automation'|'system'; message: string; metadata?: unknown }) {
  const event = await Event.create({
    ...input,
    userId: new Types.ObjectId(input.userId),
    deviceId: input.deviceId ? new Types.ObjectId(input.deviceId) : undefined,
  })

  broadcastEvent(input.userId, event.toObject())
  return event
}
export async function listEvents(userId: string, query: { deviceId?: string; type?: string; limit?: number }) { const filter: Record<string, unknown> = { userId }; if (query.deviceId) filter.deviceId = query.deviceId; if (query.type) filter.type = query.type; return Event.find(filter).sort({ createdAt: -1 }).limit(Math.min(query.limit ?? 50, 100)) }

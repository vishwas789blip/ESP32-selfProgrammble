import { IncomingMessage, Server } from 'http'
import { Duplex } from 'stream'
import { WebSocket, WebSocketServer } from 'ws'
import { verifyToken } from '../utils/generateToken.js'
import { mqttClient } from '../config/mqtt.js'
import { Device } from '../models/Device.js'
import { Event } from '../models/Event.js'
import { Sensor } from '../models/Sensor.js'
import { Actuator } from '../models/Actuator.js'
import { Automation } from '../models/Automation.js'

type Client = {
  socket: WebSocket
  userId: string
}

type RealtimeMessage = {
  type: string
  [key: string]: unknown
}

const clients = new Set<Client>()

export const realtimeWss = new WebSocketServer({
  noServer: true,
})

function send(socket: WebSocket, message: RealtimeMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message))
  }
}

function rejectUpgrade(
  socket: Duplex,
  status: number,
  message: string,
) {
  console.error(`[WS] Rejecting upgrade: ${status} ${message}`)

  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
      `Connection: close\r\n` +
      `Content-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      `\r\n` +
      message,
  )

  socket.destroy()
}

function tokenFromRequest(req: IncomingMessage): string | null {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const token = url.searchParams.get('token')

    if (!token) {
      return null
    }

    return token.trim() || null
  } catch (error) {
    console.error('[WS] Failed to parse WebSocket URL:', error)
    return null
  }
}

function extractUserId(decoded: unknown): string | null {
  if (!decoded || typeof decoded !== 'object') {
    return null
  }

  const payload = decoded as Record<string, unknown>

  const id =
    payload.id ??
    payload.userId ??
    payload._id ??
    payload.sub

  if (id === undefined || id === null) {
    return null
  }

  return String(id)
}

export function setupRealtime(server: Server) {
  server.on('upgrade', (req, socket, head) => {
    console.log(
      `[WS] Upgrade request: ${req.method ?? 'GET'} ${req.url ?? '/'}`,
    )

    const token = tokenFromRequest(req)

    if (!token) {
      console.error('[WS] No token received')
      rejectUpgrade(socket, 401, 'Unauthorized')
      return
    }

    console.log('[WS] Token received')

    let decoded: unknown

    try {
      decoded = verifyToken(token)
    } catch (error) {
      console.error('[WS] JWT verification failed:', error)

      rejectUpgrade(socket, 401, 'Invalid token')
      return
    }

    const userId =
      typeof decoded === 'string'
        ? decoded
        : extractUserId(decoded)

    if (!userId) {
      console.error('[WS] JWT does not contain a user id')
      console.error('[WS] Decoded token:', decoded)

      rejectUpgrade(socket, 401, 'Invalid token payload')
      return
    }

    console.log(`[WS] Authenticated user: ${userId}`)

    realtimeWss.handleUpgrade(
      req,
      socket,
      head,
      (ws) => {
        realtimeWss.emit(
          'connection',
          ws,
          req,
          userId,
        )
      },
    )
  })

  realtimeWss.on(
    'connection',
    (
      socket: WebSocket,
      _req: IncomingMessage,
      userId: string,
    ) => {
      console.log(`[WS] Client connected: ${userId}`)

      const client: Client = {
        socket,
        userId,
      }

      clients.add(client)

      send(socket, {
        type: 'connection_status',
        status: 'connected',
        mqtt: mqttClient.connected ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString(),
      })

      void sendInitialSnapshot(client)

      socket.on('close', (code, reason) => {
        console.log(
          `[WS] Client disconnected: ${userId} code=${code} reason=${reason.toString()}`,
        )

        clients.delete(client)
      })

      socket.on('error', (error) => {
        console.error(`[WS] Client error: ${userId}`, error)
        clients.delete(client)
      })

      socket.on('message', (raw) => {
        try {
          const message = JSON.parse(raw.toString())

          if (message?.type === 'ping') {
            send(socket, {
              type: 'pong',
              timestamp: new Date().toISOString(),
            })
          }
        } catch {
          // Ignore malformed client messages.
        }
      })
    },
  )

  return realtimeWss
}

async function sendInitialSnapshot(client: Client) {
  try {
    const devices = await Device.find({
      userId: client.userId,
    }).lean()

    const deviceIds = devices.map((device) => device._id)

    const [
      sensors,
      actuators,
      automations,
      events,
    ] = await Promise.all([
      Sensor.find({
        deviceId: { $in: deviceIds },
      }).lean(),

      Actuator.find({
        deviceId: { $in: deviceIds },
      }).lean(),

      Automation.find({
        userId: client.userId,
      }).lean(),

      Event.find({
        userId: client.userId,
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
    ])

    send(client.socket, {
      type: 'device_snapshot',
      devices,
      timestamp: new Date().toISOString(),
    })

    send(client.socket, {
      type: 'sensor_snapshot',
      sensors,
      timestamp: new Date().toISOString(),
    })

    send(client.socket, {
      type: 'actuator_snapshot',
      actuators,
      timestamp: new Date().toISOString(),
    })

    send(client.socket, {
      type: 'automation_snapshot',
      automations,
      timestamp: new Date().toISOString(),
    })

    send(client.socket, {
      type: 'event_snapshot',
      events,
      timestamp: new Date().toISOString(),
    })

    console.log(
      `[WS] Initial snapshot sent: ` +
      `${devices.length} devices, ` +
      `${sensors.length} sensors, ` +
      `${actuators.length} actuators, ` +
      `${automations.length} automations, ` +
      `${events.length} events`,
    )
  } catch (error) {
    console.error(
      `[WS] Initial snapshot failed for user ${client.userId}:`,
      error,
    )

    send(client.socket, {
      type: 'error',
      message: 'Failed to load initial snapshot',
      timestamp: new Date().toISOString(),
    })
  }
}

function broadcastToUser(
  userId: string,
  message: RealtimeMessage,
) {
  for (const client of clients) {
    if (
      client.userId === userId &&
      client.socket.readyState === WebSocket.OPEN
    ) {
      send(client.socket, message)
    }
  }
}

export function broadcastDeviceTelemetry(
  userId: string,
  deviceId: string,
  telemetry: unknown,
) {
  broadcastToUser(userId, {
    type: 'telemetry',
    deviceId,
    data: telemetry,
    timestamp: new Date().toISOString(),
  })
}

export function broadcastDeviceStatus(
  userId: string,
  deviceId: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  broadcastToUser(userId, {
    type: 'device_status',
    deviceId,
    status,
    ...extra,
    timestamp: new Date().toISOString(),
  })
}

export function broadcastEvent(
  userId: string,
  event: unknown,
) {
  broadcastToUser(userId, {
    type: 'event',
    event,
    timestamp: new Date().toISOString(),
  })
}

export function broadcastDeviceUpdate(
  userId: string,
  device: unknown,
) {
  broadcastToUser(userId, {
    type: 'device_update',
    device,
    timestamp: new Date().toISOString(),
  })
}

export function broadcastSensorUpdate(
  userId: string,
  sensor: unknown,
) {
  broadcastToUser(userId, {
    type: 'sensor_update',
    sensor,
    timestamp: new Date().toISOString(),
  })
}

export function broadcastActuatorUpdate(
  userId: string,
  actuator: unknown,
) {
  broadcastToUser(userId, {
    type: 'actuator_update',
    actuator,
    timestamp: new Date().toISOString(),
  })
}

export function broadcastAutomationUpdate(
  userId: string,
  automation: unknown,
) {
  broadcastToUser(userId, {
    type: 'automation_update',
    automation,
    timestamp: new Date().toISOString(),
  })
}
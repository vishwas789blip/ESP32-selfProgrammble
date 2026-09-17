import { env } from '../config/env.js'
import { Device } from '../models/Device.js'
import { Sensor } from '../models/Sensor.js'
import { Actuator } from '../models/Actuator.js'
import { devices as deviceService, commandActuator, automations as automationService } from './resourceServices.js'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const MAX_TOOL_ROUNDS = 5

function serviceUnavailable(message: string) {
  return Object.assign(new Error(message), { statusCode: 503, code: 'AI_UNAVAILABLE' })
}

function badRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'AI_TOOL_ERROR' })
}

// Snapshot of everything the model is allowed to reference. Real Mongo
// ObjectIds are included so the model can only act on the user's own,
// already-registered devices/sensors/actuators — it can't invent one.
async function buildContext(userId: string) {
  const userDevices = await deviceService.list(userId)
  const deviceIds = userDevices.map((d) => d._id)

  const [allSensors, allActuators] = await Promise.all([
    Sensor.find({ deviceId: { $in: deviceIds } }),
    Actuator.find({ deviceId: { $in: deviceIds } }),
  ])

  return userDevices.map((device) => ({
    deviceId: String(device._id),
    hardwareId: device.deviceId,
    name: device.name,
    status: device.status,
    lastSeen: device.lastSeen,
    sensors: allSensors
      .filter((s) => String(s.deviceId) === String(device._id))
      .map((s) => ({ sensorId: String(s._id), name: s.name, type: s.type, gpio: s.gpio, value: s.value, unit: s.unit, status: s.status })),
    actuators: allActuators
      .filter((a) => String(a.deviceId) === String(device._id))
      .map((a) => ({ actuatorId: String(a._id), name: a.name, type: a.type, gpio: a.gpio, state: a.state })),
  }))
}

const tools = [
  {
    name: 'get_status',
    description: 'Fetch a fresh snapshot of the current user\'s devices, sensors and actuators (latest values/states). Use this whenever you need up-to-date readings before answering.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'send_command',
    description: 'Send an immediate ON/OFF command to one actuator belonging to the current user, via MQTT.',
    input_schema: {
      type: 'object',
      properties: {
        actuatorId: { type: 'string', description: 'The actuatorId (Mongo ObjectId) from the context/snapshot. Never invent one.' },
        command: { type: 'string', enum: ['ON', 'OFF'] },
        duration: { type: 'number', description: 'Optional auto-off duration in seconds, for a timed ON command.' },
      },
      required: ['actuatorId', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_automation',
    description: 'Create a new automation rule that watches one or more sensors and drives one or more actuators when they match. All conditions must currently be met together (AND) for the actions to fire.',
    input_schema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The deviceId (Mongo ObjectId) the automation belongs to.' },
        name: { type: 'string' },
        conditions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sensorId: { type: 'string', description: 'sensorId (Mongo ObjectId) from the context.' },
              operator: { type: 'string', description: "One of: 'equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'contains', 'starts_with', 'ends_with'." },
              value: {},
            },
            required: ['sensorId', 'operator', 'value'],
          },
        },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              actuatorId: { type: 'string', description: 'actuatorId (Mongo ObjectId) from the context.' },
              command: { type: 'string', enum: ['ON', 'OFF'] },
              duration: { type: 'number' },
            },
            required: ['actuatorId', 'command'],
          },
        },
        enabled: { type: 'boolean' },
      },
      required: ['deviceId', 'name', 'conditions', 'actions'],
      additionalProperties: false,
    },
  },
]

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

async function callClaude(messages: unknown[], systemPrompt: string) {
  if (!env.ANTHROPIC_API_KEY) {
    throw serviceUnavailable('AI assistant is not configured: set ANTHROPIC_API_KEY on the backend.')
  }

  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools,
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw serviceUnavailable(`AI provider request failed (${response.status}): ${detail.slice(0, 300)}`)
  }

  return response.json() as Promise<{ content: AnthropicContentBlock[]; stop_reason: string }>
}

async function runTool(userId: string, name: string, input: Record<string, unknown>) {
  switch (name) {
    case 'get_status':
      return buildContext(userId)

    case 'send_command': {
      const actuatorId = String(input.actuatorId ?? '')
      const command = String(input.command ?? '')
      const duration = typeof input.duration === 'number' ? input.duration : undefined
      if (!actuatorId || !command) throw badRequest('actuatorId and command are required')
      return commandActuator(userId, actuatorId, command, duration)
    }

    case 'create_automation': {
      const deviceId = String(input.deviceId ?? '')
      const name_ = String(input.name ?? '')
      const conditions = Array.isArray(input.conditions) ? input.conditions : []
      const actions = Array.isArray(input.actions) ? input.actions : []
      if (!deviceId || !name_) throw badRequest('deviceId and name are required')
      if (conditions.length === 0) throw badRequest('At least one condition is required — ask the user which sensor and threshold should trigger this automation.')
      if (actions.length === 0) throw badRequest('At least one action is required — ask the user which actuator and command should run.')
      return automationService.create(userId, {
        deviceId,
        name: name_,
        conditions,
        actions,
        enabled: input.enabled ?? true,
      })
    }

    default:
      throw badRequest(`Unknown tool: ${name}`)
  }
}

export async function chat(userId: string, message: string): Promise<string> {
  const context = await buildContext(userId)

  if (context.length === 0) {
    return "You don't have any registered devices yet. Register a device (and its sensors/actuators) first, then I can help you check status or set up automations."
  }

  const systemPrompt = [
    'You are the assistant embedded in an ESP32 self-programmable IoT platform.',
    'You can inspect the user\'s registered devices/sensors/actuators, send actuator commands, and create automations, using the provided tools.',
    'Only ever reference sensorId/actuatorId/deviceId values that appear in the context or a get_status tool result. Never invent an id.',
    'Automations you create are evaluated with AND semantics: every condition must hold at once for the actions to run.',
    'Current context (may be stale — call get_status for the latest values):',
    JSON.stringify(context),
  ].join('\n')

  const messages: unknown[] = [{ role: 'user', content: message }]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await callClaude(messages, systemPrompt)

    const toolUses = result.content.filter((b): b is Extract<AnthropicContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    const text = result.content.filter((b): b is Extract<AnthropicContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n')

    if (toolUses.length === 0) {
      return text || 'Done.'
    }

    messages.push({ role: 'assistant', content: result.content })

    const toolResults = await Promise.all(
      toolUses.map(async (call) => {
        try {
          const data = await runTool(userId, call.name, call.input)
          return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(data) }
        } catch (err) {
          const e = err as { message?: string }
          return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: e.message ?? 'Tool execution failed' }
        }
      }),
    )

    messages.push({ role: 'user', content: toolResults })
  }

  return "I wasn't able to finish that within the allotted number of steps — could you narrow the request down?"
}
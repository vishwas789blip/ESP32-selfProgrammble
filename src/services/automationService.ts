import { Types } from 'mongoose'
import { Automation } from '../models/Automation.js'
import { Device } from '../models/Device.js'
import { Sensor } from '../models/Sensor.js'
import { Actuator } from '../models/Actuator.js'
import { createEvent } from './eventService.js'
import { mqttClient, topics } from '../config/mqtt.js'
import { broadcastActuatorUpdate } from './realtimeService.js'

type DeviceInfo = {
  _id: Types.ObjectId
  deviceId: string
  userId: Types.ObjectId
}

/**
 * Runtime latch for edge-triggered automations. An automation fires when
 * its complete condition set changes from false -> true. While it remains
 * true, repeated telemetry packets do not fire the action again. A false
 * evaluation resets the latch so the next true transition can fire again.
 *
 * The key is the automation id, so this works for any sensor/actuator type
 * and for multi-condition automations.
 */
const automationMatchState = new Map<string, boolean>()

function normalizeComparable(value: unknown, other: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false

    const otherIsNumber =
      typeof other === 'number' ||
      (typeof other === 'string' && other.trim() !== '' && Number.isFinite(Number(other)))

    if (otherIsNumber && trimmed !== '' && Number.isFinite(Number(trimmed))) {
      return Number(trimmed)
    }
  }

  return value
}

function evaluateCondition(
  operator: string,
  currentValue: unknown,
  expectedValue: unknown,
): boolean {
  const normalizedCurrent = normalizeComparable(currentValue, expectedValue)
  const normalizedExpected = normalizeComparable(expectedValue, currentValue)

  switch (operator) {
    case 'equals':
    case '==':
      return normalizedCurrent === normalizedExpected

    case 'not_equals':
    case '!=':
      return normalizedCurrent !== normalizedExpected

    case '>':
    case 'greater_than':
      return Number(normalizedCurrent) > Number(normalizedExpected)

    case '>=':
    case 'greater_than_or_equal':
      return Number(normalizedCurrent) >= Number(normalizedExpected)

    case '<':
    case 'less_than':
      return Number(normalizedCurrent) < Number(normalizedExpected)

    case '<=':
    case 'less_than_or_equal':
      return Number(normalizedCurrent) <= Number(normalizedExpected)

    case 'contains':
      return String(normalizedCurrent)
        .toLowerCase()
        .includes(String(normalizedExpected).toLowerCase())

    case 'starts_with':
      return String(normalizedCurrent)
        .toLowerCase()
        .startsWith(String(normalizedExpected).toLowerCase())

    case 'ends_with':
      return String(normalizedCurrent)
        .toLowerCase()
        .endsWith(String(normalizedExpected).toLowerCase())

    default:
      console.warn(
        `[AUTOMATION] Unsupported operator: ${operator}`,
      )
      return false
  }
}

async function executeAutomationActions(
  automation: any,
  device: DeviceInfo,
  sensorId: string,
  currentValue: unknown,
  previousValue: unknown,
  source: 'telemetry' | 'test' = 'telemetry',
) {
  if (automation.actions.length === 0) {
    console.log(
      `[AUTOMATION] ${automation.name} matched but has no actions`,
    )
    return
  }

  for (const action of automation.actions) {
    if (!action.actuatorId) {
      console.warn(
        `[AUTOMATION] Missing actuator in ${automation.name}`,
      )
      continue
    }

    const actuator = await Actuator.findOne({
      _id: action.actuatorId,
      deviceId: device._id,
    })

    if (!actuator) {
      console.warn(
        `[AUTOMATION] Actuator not found: ${action.actuatorId}`,
      )
      continue
    }

    const command = String(action.command).trim().toUpperCase()

    if (!command) {
      console.warn(
        `[AUTOMATION] Empty command for ${actuator.name}`,
      )
      continue
    }

    const payload = {
      type: 'actuator' as const,
      actuatorId: actuator.name,
      command: command as 'ON' | 'OFF',
      ...(action.duration !== undefined && action.duration !== null
        ? { duration: action.duration }
        : {}),
      timestamp: new Date().toISOString(),
    }

    await new Promise<void>((resolve, reject) => {
      mqttClient.publish(
        topics.command(device.deviceId),
        JSON.stringify(payload),
        { qos: 1 },
        error => {
          if (error) reject(error)
          else resolve()
        },
      )
    })

    console.log(
      `[AUTOMATION] Triggered: ${automation.name}`,
    )

    console.log(
      `[AUTOMATION] ${actuator.name} -> ${command}`,
    )

    const normalizedCommand = command.toLowerCase()

    if (
      normalizedCommand === 'on' ||
      normalizedCommand === 'off'
    ) {
      actuator.state = normalizedCommand as 'on' | 'off'
      await actuator.save()

      broadcastActuatorUpdate(
        String(device.userId),
        actuator.toObject(),
      )
    }

    await createEvent({
      userId: String(device.userId),
      deviceId: String(device._id),
      type: 'actuator',
      message:
        `Automation triggered: ${actuator.name} ${command}`,
      metadata: {
        automationId: String(automation._id),
        automationName: automation.name,
        sensorId,
        previousValue,
        currentValue,
        command,
        duration: action.duration,
        source,
      },
    })
  }

  await Automation.updateOne(
    { _id: automation._id },
    { $set: { lastExecuted: new Date() } },
  )
}

export async function evaluateAutomations(
  device: DeviceInfo,
  sensorId: string,
  currentValue: unknown,
  previousValue: unknown,
) {
  if (!Types.ObjectId.isValid(sensorId)) {
    console.warn(
      `[AUTOMATION] Invalid sensor ID: ${sensorId}`,
    )
    return
  }

  const sensorObjectId = new Types.ObjectId(sensorId)

  const automations = await Automation.find({
    deviceId: device._id,
    enabled: true,
    'conditions.sensorId': sensorObjectId,
  })

  if (automations.length === 0) {
    console.log(
      `[AUTOMATION] No automation matched sensor ${sensorId}`,
    )
    return
  }

  console.log(
    `[AUTOMATION] Checking ${automations.length} automation(s)`,
  )

  for (const automation of automations) {
    const relevantIds = automation.conditions
      .map((c) => (c.sensorId ? String(c.sensorId) : null))
      .filter((id): id is string => !!id)

    const knownValues = new Map<string, unknown>([[sensorId, currentValue]])
    const missingIds = [...new Set(relevantIds)].filter((id) => !knownValues.has(id))
    if (missingIds.length > 0) {
      // Scoped to this automation's own device: conditions are validated
      // to reference only sensors on that device when the automation is
      // created/updated, but this scoping is kept here too as a second
      // line of defense against ever reading another device's sensor.
      const otherSensors = await Sensor.find({ _id: { $in: missingIds }, deviceId: device._id })
      for (const s of otherSensors) knownValues.set(String(s._id), s.value)
    }

    const automationMatched =
      automation.conditions.length > 0 &&
      automation.conditions.every((condition) => {
        if (!condition.sensorId) return false
        const value = knownValues.get(String(condition.sensorId))
        const matched = evaluateCondition(condition.operator, value, condition.value)

        console.log(
          `[AUTOMATION] ${automation.name}: ` +
          `${String(value)} ` +
          `${condition.operator} ` +
          `${String(condition.value)} ` +
          `=> ${matched}`,
        )

        return matched
      })

    const automationKey = String(automation._id)
    const wasMatched = automationMatchState.get(automationKey) ?? false

    if (!automationMatched) {
      // Reset the latch. The next false -> true transition is allowed to fire.
      automationMatchState.set(automationKey, false)
      continue
    }

    if (wasMatched) {
      console.log(
        `[AUTOMATION] ${automation.name}: conditions remain true; action already triggered`,
      )
      continue
    }

    // Rising-edge trigger: false -> true only.
    automationMatchState.set(automationKey, true)

    await executeAutomationActions(
      automation,
      device,
      sensorId,
      currentValue,
      previousValue,
      'telemetry',
    )
  }
}

/**
 * Website-only test path.
 *
 * It publishes a synthetic telemetry packet to the SAME MQTT telemetry topic
 * used by the ESP32. The normal MQTT telemetry handler receives that packet,
 * updates the sensor, runs evaluateAutomations(), and publishes the actuator
 * command. This keeps the test path identical to the real device path and
 * works for any registered sensor/actuator pair.
 */
export async function testAutomation(
  userId: string,
  automationId: string,
) {
  if (!Types.ObjectId.isValid(automationId)) {
    throw new Error('Invalid automation ID')
  }

  const automation = await Automation.findOne({
    _id: new Types.ObjectId(automationId),
    userId: new Types.ObjectId(userId),
  })

  if (!automation) throw new Error('Automation not found')
  if (!automation.enabled) throw new Error('Enable the automation before testing it')
  if (automation.conditions.length === 0) throw new Error('Automation has no sensor conditions')
  if (automation.actions.length === 0) throw new Error('Automation has no actions')

  const device = await Device.findOne({
    _id: automation.deviceId,
    userId: new Types.ObjectId(userId),
  })
  if (!device) throw new Error('Device not found')

  const sensors = await Sensor.find({
    _id: { $in: automation.conditions.map(c => c.sensorId).filter(Boolean) },
    deviceId: device._id,
  })

  const conditionSensorIds = [...new Set(automation.conditions.map(c => c.sensorId ? String(c.sensorId) : ''))].filter(Boolean)
  if (sensors.length !== conditionSensorIds.length) {
    throw new Error('One or more automation sensors were not found for this device')
  }

  const readings: Record<string, unknown> = {}

  for (const condition of automation.conditions) {
    if (!condition.sensorId) throw new Error('Automation has a condition without a sensor')
    if (condition.value === undefined) throw new Error('Automation condition has no test value')

    const sensor = sensors.find(s => String(s._id) === String(condition.sensorId))
    if (!sensor) throw new Error(`Automation sensor not found: ${condition.sensorId}`)
    if (sensor.gpio === undefined || sensor.gpio === null) {
      throw new Error(`Automation sensor ${sensor.name} has no GPIO configured`)
    }

    // Test every condition at its configured comparison value. The normal
    // MQTT telemetry path will then evaluate the complete multi-condition rule.
    readings[String(sensor.gpio)] = condition.value
  }

  const telemetryPayload = {
    deviceId: device.deviceId,
    readings,
    timestamp: new Date().toISOString(),
  }

  const telemetryTopic = `devices/${device.deviceId}/telemetry`

  await new Promise<void>((resolve, reject) => {
    mqttClient.publish(
      telemetryTopic,
      JSON.stringify(telemetryPayload),
      { qos: 1 },
      error => error ? reject(error) : resolve(),
    )
  })

  console.log(`[AUTOMATION TEST] Published synthetic telemetry for ${automation.name} (${automation.conditions.length} condition(s))`)

  return {
    tested: true,
    triggered: true,
    automationId: String(automation._id),
    automationName: automation.name,
    sensorId: String(sensors[0]._id),
    sensorName: sensors[0].name,
    gpio: sensors[0].gpio,
    simulatedValue: automation.conditions.map(c => c.value),
    topic: telemetryTopic,
    message: `Synthetic telemetry published for all ${automation.conditions.length} condition(s); the normal automation engine will process the complete rule.`,
  }
}
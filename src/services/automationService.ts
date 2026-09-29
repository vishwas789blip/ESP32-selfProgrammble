import { Types } from 'mongoose'
import { Automation } from '../models/Automation.js'
import { Device } from '../models/Device.js'
import { Sensor } from '../models/Sensor.js'
import { Actuator } from '../models/Actuator.js'
import { createEvent } from './eventService.js'
import { topics } from '../config/mqtt.js'
import { env } from '../config/env.js'
import { publishMessage } from './mqttPublisher.js'
import { broadcastActuatorUpdate } from './realtimeService.js'
import { evaluateCondition, valueThatSatisfies, NO_PREVIOUS } from './automationLogic.js'

type DeviceInfo = {
  _id: Types.ObjectId
  deviceId: string
  userId: Types.ObjectId
}

type ExecutionResult = {
  /** "actuatorName:COMMAND" for every command that reached the broker. */
  published: string[]
  /** Commands that could not be published (broker down / timeout). */
  failed: string[]
}

const httpError = (statusCode: number, code: string, message: string) =>
  Object.assign(new Error(message), { statusCode, code })

const errMsg = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Edge-trigger latch, stored in MongoDB (Automation.lastMatched).
 *
 * An automation fires when its complete condition set goes false -> true. While it
 * stays true, further telemetry does not fire it again. The latch is claimed with a
 * single atomic update, so two telemetry packets processed at the same time (or two
 * backend instances) cannot both fire the same rule, and a restart does not re-fire
 * rules whose conditions were already true.
 */
async function claimTrigger(automationId: Types.ObjectId): Promise<boolean> {
  const result = await Automation.updateOne(
    { _id: automationId, lastMatched: { $ne: true } },
    { $set: { lastMatched: true } },
  )
  return result.modifiedCount === 1
}

async function releaseLatch(automationId: Types.ObjectId): Promise<void> {
  await Automation.updateOne(
    { _id: automationId, lastMatched: true },
    { $set: { lastMatched: false } },
  )
}

async function executeAutomationActions(
  automation: any,
  device: DeviceInfo,
  sensorId: string,
  currentValue: unknown,
  previousValue: unknown,
  source: 'telemetry' | 'test' = 'telemetry',
): Promise<ExecutionResult> {
  const result: ExecutionResult = { published: [], failed: [] }

  if (automation.actions.length === 0) {
    console.log(`[AUTOMATION] ${automation.name} matched but has no actions`)
    return result
  }

  for (const action of automation.actions) {
    if (!action.actuatorId) {
      console.warn(`[AUTOMATION] Missing actuator in ${automation.name}`)
      continue
    }

    const actuator = await Actuator.findOne({
      _id: action.actuatorId,
      deviceId: device._id,
    })

    if (!actuator) {
      console.warn(`[AUTOMATION] Actuator not found: ${action.actuatorId}`)
      continue
    }

    // Send the command exactly as the user configured it. It used to be upper-cased,
    // which turned custom commands such as "setAngle" into "SETANGLE" (manual commands
    // are sent as typed, so automation and manual control disagreed).
    const command = String(action.command).trim()

    if (!command) {
      console.warn(`[AUTOMATION] Empty command for ${actuator.name}`)
      continue
    }

    const payload = {
      type: 'actuator' as const,
      actuatorId: String(actuator._id),
      command,
      ...(action.value !== undefined ? { value: action.value } : {}),
      ...(action.duration !== undefined && action.duration !== null ? { duration: action.duration } : {}),
      ...(action.parameters && typeof action.parameters === 'object' ? { parameters: action.parameters } : {}),
      timestamp: new Date().toISOString(),
    }

    const label = `${actuator.name}:${command}`

    try {
      await publishMessage(topics.command(device.deviceId), payload, { qos: 1 })
    } catch (error) {
      console.error(`[AUTOMATION] ${automation.name}: publishing ${label} failed: ${errMsg(error)}`)
      result.failed.push(label)
      continue
    }

    result.published.push(label)
    console.log(`[AUTOMATION] Triggered: ${automation.name} (${actuator.name} -> ${command})`)

    const lowered = command.toLowerCase()
    if (lowered === 'on' || lowered === 'off') {
      actuator.state = lowered
    } else if (action.value !== undefined) {
      actuator.state = action.value
    } else {
      actuator.state = command
    }
    await actuator.save()
    broadcastActuatorUpdate(String(device.userId), actuator.toObject())

    await createEvent({
      userId: String(device.userId),
      deviceId: String(device._id),
      type: 'actuator',
      message: `Automation triggered: ${actuator.name} ${command}`,
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

  if (result.published.length > 0) {
    await Automation.updateOne(
      { _id: automation._id },
      { $set: { lastExecuted: new Date() } },
    )
  }

  return result
}

export async function evaluateAutomations(
  device: DeviceInfo,
  sensorId: string,
  currentValue: unknown,
  previousValue: unknown,
) {
  if (env.AUTOMATION_EXECUTOR !== 'server') return

  if (!Types.ObjectId.isValid(sensorId)) {
    console.warn(`[AUTOMATION] Invalid sensor ID: ${sensorId}`)
    return
  }

  const sensorObjectId = new Types.ObjectId(sensorId)

  const automations = await Automation.find({
    deviceId: device._id,
    enabled: true,
    'conditions.sensorId': sensorObjectId,
  })

  if (automations.length === 0) return

  for (const automation of automations) {
    try {
      const relevantIds = automation.conditions
        .map((c) => (c.sensorId ? String(c.sensorId) : null))
        .filter((id): id is string => !!id)

      const knownValues = new Map<string, unknown>([[sensorId, currentValue]])
      const missingIds = [...new Set(relevantIds)].filter((id) => !knownValues.has(id))
      if (missingIds.length > 0) {
        // Scoped to this automation's own device as a second line of defense against
        // ever reading another device's sensor.
        const otherSensors = await Sensor.find({ _id: { $in: missingIds }, deviceId: device._id })
        for (const s of otherSensors) knownValues.set(String(s._id), s.value)
      }

      const automationMatched =
        automation.conditions.length > 0 &&
        automation.conditions.every((condition) => {
          if (!condition.sensorId) return false
          const key = String(condition.sensorId)
          const value = knownValues.get(key)
          // The previous value is only known for the sensor that just reported.
          const previous = key === sensorId ? previousValue : NO_PREVIOUS
          const matched = evaluateCondition(condition.operator, value, condition.value, previous)

          console.log(
            `[AUTOMATION] ${automation.name}: ${String(value)} ${condition.operator} ${String(condition.value)} => ${matched}`,
          )

          return matched
        })

      if (!automationMatched) {
        // Conditions are false again: re-arm so the next false -> true transition fires.
        if (automation.lastMatched) await releaseLatch(automation._id)
        continue
      }

      if (automation.lastMatched) {
        console.log(`[AUTOMATION] ${automation.name}: conditions remain true; action already triggered`)
        continue
      }

      // Rising edge. Claim the latch atomically; if someone else got it first, stop.
      if (!(await claimTrigger(automation._id))) continue

      let outcome: ExecutionResult
      try {
        outcome = await executeAutomationActions(automation, device, sensorId, currentValue, previousValue, 'telemetry')
      } catch (error) {
        await releaseLatch(automation._id).catch(() => {})
        throw error
      }

      // Never re-arm after a partial execution: successful actions have already
      // happened and blindly retrying the whole rule would duplicate them. A failed
      // execution is surfaced through logs/events and the next false -> true edge
      // will execute it again.
      if (outcome.failed.length > 0) {
        console.error(`[AUTOMATION] ${automation.name}: ${outcome.failed.length} action(s) failed; latch remains claimed to prevent duplicates`)
      }
      if (outcome.published.length === 0) {
        await releaseLatch(automation._id)
      }
    } catch (error) {
      // One broken rule must not stop the other rules.
      console.error(`[AUTOMATION] ${automation.name} failed: ${errMsg(error)}`)
    }
  }
}

/**
 * Website "Test" button.
 *
 * Simulates the rule without touching real data: it works out a value for each
 * condition that makes it true, checks that the whole rule really would fire, and
 * then sends the rule's actual commands to the actuators. It does NOT write fake
 * readings into the sensors, does not mark the device online, does not broadcast
 * fake telemetry and does not touch the edge-trigger latch.
 */
export async function testAutomation(
  userId: string,
  automationId: string,
) {
  if (!Types.ObjectId.isValid(automationId)) {
    throw httpError(400, 'INVALID_ID', 'Invalid automation ID')
  }

  const automation = await Automation.findOne({
    _id: new Types.ObjectId(automationId),
    userId: new Types.ObjectId(userId),
  })

  if (!automation) throw httpError(404, 'NOT_FOUND', 'Automation not found')
  if (!automation.enabled) throw httpError(400, 'AUTOMATION_DISABLED', 'Enable the automation before testing it')
  if (automation.conditions.length === 0) throw httpError(400, 'NO_CONDITIONS', 'Automation has no sensor conditions')
  if (automation.actions.length === 0) throw httpError(400, 'NO_ACTIONS', 'Automation has no actions')

  const device = await Device.findOne({
    _id: automation.deviceId,
    userId: new Types.ObjectId(userId),
  })
  if (!device) throw httpError(404, 'NOT_FOUND', 'Device not found')

  const conditionSensorIds = [...new Set(
    automation.conditions.map(c => (c.sensorId ? String(c.sensorId) : '')).filter(Boolean),
  )]

  const sensors = await Sensor.find({
    _id: { $in: conditionSensorIds },
    deviceId: device._id,
  })

  if (sensors.length !== conditionSensorIds.length) {
    throw httpError(400, 'INVALID_REFERENCE', 'One or more automation sensors were not found for this device')
  }

  // sensorId -> simulated value (+ simulated previous value for `changed`)
  const simulatedValues = new Map<string, unknown>()
  const simulatedPrevious = new Map<string, unknown>()

  for (const condition of automation.conditions) {
    const sensor = sensors.find(s => String(s._id) === String(condition.sensorId))
    if (!sensor) throw httpError(400, 'INVALID_REFERENCE', `Automation sensor not found: ${condition.sensorId}`)

    const simulation = valueThatSatisfies(condition.operator, condition.value, sensor.value)
    if (!simulation.ok) {
      throw httpError(400, 'CANNOT_SIMULATE', `Cannot simulate "${sensor.name}": ${simulation.reason}`)
    }

    simulatedValues.set(String(sensor._id), simulation.value)
    if ('previous' in simulation) simulatedPrevious.set(String(sensor._id), simulation.previous)
  }

  // Verify with the real evaluator. Two conditions on the same sensor can contradict
  // each other (> 10 AND < 5); then the rule can never fire and we say so.
  const wouldFire = automation.conditions.every(condition => {
    const key = String(condition.sensorId)
    const previous = simulatedPrevious.has(key) ? simulatedPrevious.get(key) : NO_PREVIOUS
    return evaluateCondition(condition.operator, simulatedValues.get(key), condition.value, previous)
  })

  const first = sensors[0]
  const simulated = sensors.map(s => ({
    sensorId: String(s._id),
    sensorName: s.name,
    value: simulatedValues.get(String(s._id)),
  }))

  const base = {
    tested: true,
    automationId: String(automation._id),
    automationName: automation.name,
    sensorId: String(first._id),
    sensorName: first.name,
    gpio: first.gpio,
    simulatedValue: simulated.map(s => s.value),
    simulated,
    topic: topics.command(device.deviceId),
  }

  if (!wouldFire) {
    return {
      ...base,
      triggered: false,
      commands: [] as string[],
      failed: [] as string[],
      message: 'The conditions of this rule contradict each other, so it can never fire. No command was sent.',
    }
  }

  const outcome = await executeAutomationActions(
    automation,
    { _id: device._id, deviceId: device.deviceId, userId: device.userId },
    String(first._id),
    simulatedValues.get(String(first._id)),
    simulatedPrevious.get(String(first._id)),
    'test',
  )

  if (outcome.published.length === 0 && outcome.failed.length > 0) {
    throw httpError(503, 'MQTT_UNAVAILABLE', 'MQTT broker is not reachable, no command was sent')
  }

  return {
    ...base,
    triggered: outcome.published.length > 0,
    commands: outcome.published,
    failed: outcome.failed,
    message:
      outcome.published.length > 0
        ? `Simulated readings satisfy the rule; sent ${outcome.published.length} command(s) to the device. Sensor data was not modified.`
        : 'The rule would fire, but none of its actuators exist any more, so no command was sent.',
  }
}

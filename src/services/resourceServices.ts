import { Types } from 'mongoose'
import { Device } from '../models/Device.js'
import { Sensor } from '../models/Sensor.js'
import { Actuator } from '../models/Actuator.js'
import { Automation } from '../models/Automation.js'
import { createEvent } from './eventService.js'
import { env } from '../config/env.js'
import {
  publishCommand,
  pushDeviceConfig,
} from './mqttService.js'
import {
  broadcastActuatorUpdate,
  broadcastAutomationUpdate,
} from './realtimeService.js'

export { pushDeviceConfig }

const oid = (id: string) =>
  new Types.ObjectId(id)

const notFound = () =>
  Object.assign(
    new Error('Resource not found'),
    {
      statusCode: 404,
      code: 'NOT_FOUND',
    },
  )

const invalidRef = (message: string) =>
  Object.assign(
    new Error(message),
    {
      statusCode: 400,
      code: 'INVALID_REFERENCE',
    },
  )

async function ownedDevice(
  userId: string,
  id: string,
) {
  const device = await Device.findOne({
    _id: id,
    userId,
  })

  if (!device) {
    throw notFound()
  }

  return device
}

/**
 * Make sure every sensor/actuator referenced by an automation's
 * conditions/actions actually belongs to the automation's own device.
 * Without this, a user could reference another user's sensor/actuator
 * ObjectId and use the automation's trigger behaviour as a side-channel
 * to read (or, for actuators, indirectly probe) resources they don't own.
 */
async function assertAutomationRefsBelongToDevice(
  deviceId: string,
  conditions: Array<{ sensorId?: unknown }>,
  actions: Array<{ actuatorId?: unknown }>,
) {
  const sensorIds = [
    ...new Set(
      conditions
        .map((c) => (c.sensorId ? String(c.sensorId) : null))
        .filter((id): id is string => !!id),
    ),
  ]

  const actuatorIds = [
    ...new Set(
      actions
        .map((a) => (a.actuatorId ? String(a.actuatorId) : null))
        .filter((id): id is string => !!id),
    ),
  ]

  const [sensors, actuators] = await Promise.all([
    sensorIds.length
      ? Sensor.find({ _id: { $in: sensorIds }, deviceId })
      : Promise.resolve([]),
    actuatorIds.length
      ? Actuator.find({ _id: { $in: actuatorIds }, deviceId })
      : Promise.resolve([]),
  ])

  if (sensors.length !== sensorIds.length) {
    throw invalidRef('One or more condition sensors do not belong to this device')
  }

  if (actuators.length !== actuatorIds.length) {
    throw invalidRef('One or more action actuators do not belong to this device')
  }
}

/**
 * Rules used to be published one by one to the retained `devices/<id>/automation`
 * topic. That topic has a single retained slot, so only the most recent rule survived
 * and a deleted rule stayed retained as a `deleted:true` message. The complete rule
 * set now travels inside the retained config message (one mechanism, always
 * consistent), and only when the ESP32 is the executor (AUTOMATION_EXECUTOR=device).
 * In 'server' mode there is nothing to sync: the backend fires the commands itself.
 * pushDeviceConfig() is best-effort, so this never fails the API request.
 */
async function syncDeviceAutomations(...deviceMongoIds: string[]) {
  if (env.AUTOMATION_EXECUTOR !== 'device') return

  for (const id of new Set(deviceMongoIds)) {
    await pushDeviceConfig(id)
  }
}

/**
 * A sensor/actuator was deleted: every enabled automation that referenced it is
 * incomplete. Disable those (instead of leaving them half-working or silently
 * deleting the user's rules) and tell the user through an event + WebSocket update.
 */
export async function disableAutomationsReferencing(ref: { sensorId?: string; actuatorId?: string }) {
  if (!ref.sensorId && !ref.actuatorId) return []

  const filter = ref.sensorId
    ? { 'conditions.sensorId': oid(ref.sensorId), enabled: true }
    : { 'actions.actuatorId': oid(ref.actuatorId as string), enabled: true }

  const affected = await Automation.find(filter)
  if (affected.length === 0) return []

  await Automation.updateMany(
    { _id: { $in: affected.map((a) => a._id) } },
    { $set: { enabled: false, lastMatched: false } },
  )

  for (const automation of affected) {
    broadcastAutomationUpdate(String(automation.userId), {
      ...automation.toObject(),
      enabled: false,
      lastMatched: false,
    })

    await createEvent({
      userId: String(automation.userId),
      deviceId: String(automation.deviceId),
      type: 'automation',
      message: `Automation "${automation.name}" was disabled because a ${ref.sensorId ? 'sensor' : 'actuator'} it uses was deleted`.slice(0, 500),
      metadata: { automationId: String(automation._id), ...ref },
    })
  }

  await syncDeviceAutomations(...affected.map((a) => String(a.deviceId)))

  return affected
}

export const devices = {
  list: (userId: string) =>
    Device.find({ userId }).sort({
      createdAt: -1,
    }),

  get: ownedDevice,

  create: (
    userId: string,
    input: Record<string, unknown>,
  ) =>
    Device.create({
      ...input,
      userId: oid(userId),
    }),

  update: async (
    userId: string,
    id: string,
    input: Record<string, unknown>,
  ) => {
    await ownedDevice(userId, id)

    return Device.findByIdAndUpdate(
      id,
      input,
      {
        new: true,
        runValidators: true,
      },
    )
  },

  remove: async (
    userId: string,
    id: string,
  ) => {
    await ownedDevice(userId, id)

    await Promise.all([
      Sensor.deleteMany({
        deviceId: id,
      }),

      Actuator.deleteMany({
        deviceId: id,
      }),

      Automation.deleteMany({
        deviceId: id,
      }),

      Device.findByIdAndDelete(id),
    ])

    return null
  },

  heartbeat: async (
    userId: string,
    id: string,
  ) => {
    const device =
      await ownedDevice(userId, id)

    device.lastSeen = new Date()
    device.status = 'online'

    return device.save()
  },

  getConfig: async (
    userId: string,
    id: string,
  ) => {
    const device =
      await ownedDevice(userId, id)

    const [
      sensors,
      actuators,
    ] = await Promise.all([
      Sensor.find({
        deviceId: id,
      }),

      Actuator.find({
        deviceId: id,
      }),
    ])

    return {
      ...(device.config &&
      typeof device.config === 'object'
        ? device.config
        : {}),

      sensors: sensors.map(
        sensor => ({
          sensorId: String(
            sensor._id,
          ),
          name: sensor.name,
          type: sensor.type,
          gpio: sensor.gpio,
        }),
      ),

      actuators: actuators.map(
        actuator => ({
          actuatorId:
            actuator.name,
          name: actuator.name,
          type: actuator.type,
          gpio: actuator.gpio,
        }),
      ),
    }
  },

  updateConfig: async (
    userId: string,
    id: string,
    settings: Record<string, unknown>,
  ) => {
    const device =
      await ownedDevice(userId, id)

    device.config = {
      ...(device.config &&
      typeof device.config === 'object'
        ? device.config
        : {}),

      ...settings,
    }

    await device.save()

    await pushDeviceConfig(id)

    return devices.getConfig(
      userId,
      id,
    )
  },
}

export async function ownedResource(
  model:
    | typeof Sensor
    | typeof Actuator,
  userId: string,
  id: string,
) {
  const item =
    await (model as typeof Sensor)
      .findById(id)

  if (!item) {
    throw notFound()
  }

  const device =
    await Device.findOne({
      _id: item.deviceId,
      userId,
    })

  if (!device) {
    throw notFound()
  }

  return item
}

export async function listSensors(
  userId: string,
  deviceId: string,
) {
  await ownedDevice(
    userId,
    deviceId,
  )

  return Sensor.find({
    deviceId,
  })
}

export async function createSensor(
  userId: string,
  deviceId: string,
  input: Record<string, unknown>,
) {
  await ownedDevice(
    userId,
    deviceId,
  )

  const sensor =
    await Sensor.create({
      ...input,
      deviceId: oid(deviceId),
      lastUpdated: new Date(),
    })

  await pushDeviceConfig(
    deviceId,
  )

  return sensor
}

export async function listActuators(
  userId: string,
  deviceId: string,
) {
  await ownedDevice(
    userId,
    deviceId,
  )

  return Actuator.find({
    deviceId,
  })
}

export async function createActuator(
  userId: string,
  deviceId: string,
  input: Record<string, unknown>,
) {
  await ownedDevice(
    userId,
    deviceId,
  )

  const actuator =
    await Actuator.create({
      ...input,
      deviceId: oid(deviceId),
    })

  await pushDeviceConfig(
    deviceId,
  )

  return actuator
}

export async function commandActuator(
  userId: string,
  id: string,
  command: string,
  duration?: number,
  value?: unknown,
  parameters?: Record<string, unknown>,
) {
  const actuator =
    await Actuator.findById(id)

  if (!actuator) {
    throw notFound()
  }

  const device =
    await Device.findOne({
      _id: actuator.deviceId,
      userId,
    })

  if (!device) {
    throw notFound()
  }

  const normalized = command.trim()
  if (!normalized) {
    throw Object.assign(new Error('Command is required'), { statusCode: 400, code: 'INVALID_COMMAND' })
  }

  await publishCommand(
    device.deviceId,
    {
      type: 'actuator',
      actuatorId: String(actuator._id),
      command: normalized,
      ...(value !== undefined ? { value } : {}),
      ...(duration ? { duration } : {}),
      ...(parameters ? { parameters } : {}),

      timestamp:
        new Date().toISOString(),
    },
  )

  if (normalized.toLowerCase() === 'on' || normalized.toLowerCase() === 'off') {
    actuator.state = normalized.toLowerCase()
  } else if (value !== undefined) {
    actuator.state = value
  } else {
    actuator.state = normalized
  }

  await actuator.save()

  // Optimistic state: the UI updates immediately, and the device's next telemetry
  // (`actuatorStates`) corrects it if the command did not take effect. Automation
  // triggered commands already broadcast this; manual commands did not, so other
  // open tabs/clients stayed stale.
  broadcastActuatorUpdate(userId, actuator.toObject())

  await createEvent({
    userId,
    deviceId:
      String(device._id),
    type: 'actuator',
    message:
      `MQTT command published: ${normalized}`,
    metadata: {
      command: normalized,
    },
  })

  return {
    published: true,
    deviceId:
      device.deviceId,
    actuatorId:
      actuator.name,
    command:
      normalized,
  }
}

/**
 * AUTOMATIONS
 *
 * Create:
 * MongoDB -> MQTT complete rule
 */
export const automations = {
  list: (
    userId: string,
  ) =>
    Automation.find({
      userId,
    }).sort({
      createdAt: -1,
    }),

  get: async (
    userId: string,
    id: string,
  ) => {
    const item =
      await Automation.findOne({
        _id: id,
        userId,
      })

    if (!item) {
      throw notFound()
    }

    return item
  },

  create: async (
    userId: string,
    input: Record<string, unknown>,
  ) => {
    const device =
      await ownedDevice(
        userId,
        String(input.deviceId),
      )

    // Make sure every referenced sensor/actuator actually belongs to
    // this device (and therefore to this user) before saving.
    await assertAutomationRefsBelongToDevice(
      String(device._id),
      (input.conditions as Array<{ sensorId?: unknown }>) || [],
      (input.actions as Array<{ actuatorId?: unknown }>) || [],
    )

    const automation =
      await Automation.create({
        ...input,
        userId: oid(userId),
        deviceId: oid(
          String(input.deviceId),
        ),
      })

    await syncDeviceAutomations(String(device._id))

    return automation
  },

  /**
   * Update:
   * MongoDB -> MQTT complete updated rule
   */
  update: async (
    userId: string,
    id: string,
    input: Record<string, unknown>,
  ) => {
    const existing =
      await automations.get(
        userId,
        id,
      )

    const effectiveDeviceId =
      input.deviceId &&
      String(input.deviceId) !==
        String(existing.deviceId)
        ? String(input.deviceId)
        : String(existing.deviceId)

    if (
      input.deviceId &&
      String(input.deviceId) !==
        String(existing.deviceId)
    ) {
      await ownedDevice(
        userId,
        String(input.deviceId),
      )
    }

    // Only re-validate conditions/actions the caller is actually
    // changing (or all of them, if the device itself changed).
    if (input.conditions || input.actions || input.deviceId) {
      await assertAutomationRefsBelongToDevice(
        effectiveDeviceId,
        (input.conditions as Array<{ sensorId?: unknown }>) ??
          existing.conditions,
        (input.actions as Array<{ actuatorId?: unknown }>) ??
          existing.actions,
      )
    }

    // The rule changed, so its edge-trigger latch starts fresh.
    const updated =
      await Automation.findByIdAndUpdate(
        id,
        { ...input, lastMatched: false },
        {
          new: true,
          runValidators: true,
        },
      )

    if (!updated) {
      throw notFound()
    }

    // Also resync the old device if the rule moved to another one.
    await syncDeviceAutomations(
      String(existing.deviceId),
      String(updated.deviceId),
    )

    return updated
  },

  /**
   * Delete: remove from MongoDB first, then resync the device so its rule list no
   * longer contains the rule (no retained `deleted:true` leftovers).
   */
  remove: async (
    userId: string,
    id: string,
  ) => {
    const item =
      await automations.get(
        userId,
        id,
      )

    await Automation.findByIdAndDelete(
      id,
    )

    await syncDeviceAutomations(String(item.deviceId))

    return null
  },

  /**
   * Toggle: flips `enabled`, re-arms the edge-trigger latch and resyncs the device.
   */
  toggle: async (
    userId: string,
    id: string,
  ) => {
    const item =
      await automations.get(
        userId,
        id,
      )

    item.enabled =
      !item.enabled
    item.lastMatched = false

    const saved =
      await item.save()

    await syncDeviceAutomations(String(saved.deviceId))

    return saved
  },
}

import { Types } from 'mongoose'
import { Device } from '../models/Device.js'
import { Sensor } from '../models/Sensor.js'
import { Actuator } from '../models/Actuator.js'
import { Automation } from '../models/Automation.js'
import { createEvent } from './eventService.js'
import {
  publishCommand,
  publishAutomation,
  pushDeviceConfig,
} from './mqttService.js'

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
 * The device only knows actuators by name (it has no database), so any
 * automation payload published over MQTT must translate actuatorId
 * (a Mongo ObjectId) into the matching actuator's name — the same
 * identifier used in the actuators list of the device config and in
 * direct actuator commands. Actions whose actuator can no longer be
 * found (e.g. deleted after the automation was created) are dropped.
 */
async function resolveActionsForPublish(
  deviceId: string,
  actions: Array<{ actuatorId?: unknown; command: string; duration?: number | null }>,
) {
  const actuatorIds = [
    ...new Set(
      actions
        .map((a) => (a.actuatorId ? String(a.actuatorId) : null))
        .filter((id): id is string => !!id),
    ),
  ]

  if (actuatorIds.length === 0) {
    return []
  }

  const actuators = await Actuator.find({
    _id: { $in: actuatorIds },
    deviceId,
  })

  const nameById = new Map(
    actuators.map((a) => [String(a._id), a.name]),
  )

  return actions
    .filter((action) => action.actuatorId && nameById.has(String(action.actuatorId)))
    .map((action) => ({
      actuatorId: nameById.get(String(action.actuatorId)),
      command: action.command,
      ...(action.duration !== undefined && action.duration !== null
        ? { duration: action.duration }
        : {}),
    }))
}

/**
 * Publish the complete automation definition
 * for a device.
 */
async function publishCompleteAutomation(
  automation: any,
) {
  const device = await Device.findById(
    automation.deviceId,
  )

  if (!device) {
    throw notFound()
  }

  await publishAutomation(
    device.deviceId,
    {
      type: 'automation',
      automationId: String(
        automation._id,
      ),
      deviceId: device.deviceId,
      name: automation.name,
      enabled: automation.enabled,
      conditions:
        automation.conditions || [],
      actions: await resolveActionsForPublish(
        String(device._id),
        automation.actions || [],
      ),
    },
  )
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

  const normalized =
    command.toUpperCase()

  if (
    !['ON', 'OFF'].includes(
      normalized,
    )
  ) {
    throw Object.assign(
      new Error(
        'Command must be ON or OFF',
      ),
      {
        statusCode: 400,
        code: 'INVALID_COMMAND',
      },
    )
  }

  await publishCommand(
    device.deviceId,
    {
      type: 'actuator',
      actuatorId:
        actuator.name,
      command: normalized,

      ...(duration
        ? { duration }
        : {}),

      timestamp:
        new Date().toISOString(),
    },
  )

  actuator.state =
    normalized.toLowerCase() as
      | 'on'
      | 'off'

  await actuator.save()

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

    /**
     * IMPORTANT:
     *
     * Website created the automation.
     * Now publish the COMPLETE automation
     * to MQTT.
     */
    await publishAutomation(
      device.deviceId,
      {
        type: 'automation',
        automationId:
          String(
            automation._id,
          ),
        deviceId:
          device.deviceId,
        name:
          automation.name,
        enabled:
          automation.enabled,
        conditions:
          automation.conditions ||
          [],
        actions: await resolveActionsForPublish(
          String(device._id),
          automation.actions || [],
        ),
      },
    )

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

    const updated =
      await Automation.findByIdAndUpdate(
        id,
        input,
        {
          new: true,
          runValidators: true,
        },
      )

    if (!updated) {
      throw notFound()
    }

    /**
     * Publish complete UPDATED
     * automation.
     */
    await publishCompleteAutomation(
      updated,
    )

    return updated
  },

  /**
   * Delete:
   *
   * Publish an enabled:false message first
   * so an ESP32 can remove/disable the rule.
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

    const device =
      await Device.findById(
        item.deviceId,
      )

    if (device) {
      await publishAutomation(
        device.deviceId,
        {
          type: 'automation',
          automationId:
            String(item._id),
          deviceId:
            device.deviceId,
          name:
            item.name,
          enabled: false,
          deleted: true,
          conditions:
            item.conditions || [],
          actions: await resolveActionsForPublish(
            String(device._id),
            item.actions || [],
          ),
        },
      )
    }

    await Automation.findByIdAndDelete(
      id,
    )

    return null
  },

  /**
   * Toggle:
   *
   * MongoDB -> MQTT complete rule
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

    const saved =
      await item.save()

    /**
     * Publish the COMPLETE automation
     * with its new enabled state.
     */
    await publishCompleteAutomation(
      saved,
    )

    return saved
  },
}
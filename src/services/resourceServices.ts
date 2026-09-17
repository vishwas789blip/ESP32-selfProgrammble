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
      actions:
        automation.actions || [],
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
        actions:
          automation.actions ||
          [],
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
          actions:
            item.actions || [],
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
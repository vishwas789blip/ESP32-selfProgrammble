import { Schema, model } from 'mongoose'

const conditionSchema = new Schema(
  {
    sensorId: {
      type: Schema.Types.ObjectId,
      ref: 'Sensor',
      required: false,
    },
    operator: {
      type: String,
      required: true,
    },
    value: Schema.Types.Mixed,
  },
  { _id: false }
)

const actionSchema = new Schema(
  {
    actuatorId: {
      type: Schema.Types.ObjectId,
      ref: 'Actuator',
      required: false,
    },
    command: {
      type: String,
      required: true,
    },
    duration: Number,
  },
  { _id: false }
)

const automationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    description: String,

    deviceId: {
      type: Schema.Types.ObjectId,
      ref: 'Device',
      required: true,
    },

    conditions: {
      type: [conditionSchema],
      default: [],
    },

    actions: {
      type: [actionSchema],
      default: [],
    },

    enabled: {
      type: Boolean,
      default: true,
    },

    lastExecuted: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
)

export const Automation = model('Automation', automationSchema)
import { Schema, model } from 'mongoose'

const conditionSchema = new Schema({
  sensorId: { type: Schema.Types.ObjectId, ref: 'Sensor', required: true },
  operator: { type: String, required: true, trim: true },
  value: Schema.Types.Mixed,
}, { _id: false })

const actionSchema = new Schema({
  actuatorId: { type: Schema.Types.ObjectId, ref: 'Actuator', required: true },
  command: { type: String, required: true, trim: true },
  value: Schema.Types.Mixed,
  duration: { type: Number, min: 1, max: 86400 },
  parameters: { type: Schema.Types.Mixed, default: {} },
}, { _id: false })

const automationSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  description: String,
  deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
  conditions: { type: [conditionSchema], default: [] },
  actions: { type: [actionSchema], default: [] },
  enabled: { type: Boolean, default: true },
  lastExecuted: { type: Date, default: null },
  // Persistent edge-trigger latch: true while the complete condition set is true and
  // the action has already fired. Stored in MongoDB (not RAM) so it survives restarts
  // and can be claimed atomically.
  lastMatched: { type: Boolean, default: false },
}, { timestamps: true })

export const Automation = model('Automation', automationSchema)

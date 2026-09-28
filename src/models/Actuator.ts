import { Schema, model } from 'mongoose'

const actuatorSchema = new Schema({
  deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
  name: { type: String, required: true, trim: true },
  // Free-form driver/type identifier: relay, buzzer, servo, pwm, motor,
  // rgb, led, valve, display, custom, etc.
  type: { type: String, required: true, trim: true, lowercase: true },
  gpio: { type: Number, min: 0, max: 48 },
  interface: { type: String, trim: true, lowercase: true, default: 'gpio' },
  pins: { type: Schema.Types.Mixed, default: {} },
  address: { type: Schema.Types.Mixed },
  channel: { type: Schema.Types.Mixed },
  state: Schema.Types.Mixed,
  config: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true })

actuatorSchema.index({ deviceId: 1, name: 1 }, { unique: true })

export const Actuator = model('Actuator', actuatorSchema)

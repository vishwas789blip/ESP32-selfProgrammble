import { Schema, model } from 'mongoose'

const sensorSchema = new Schema({
  deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
  name: { type: String, required: true, trim: true },
  // Free-form driver/type identifier: temperature, dht22, pir, ldr, bh1750,
  // mpu6050, ultrasonic, soil_moisture, custom, etc.
  type: { type: String, required: true, trim: true, lowercase: true },
  // GPIO is optional because I2C/SPI/UART/OneWire/virtual sensors may use
  // multiple pins or no direct GPIO identity.
  gpio: { type: Number, min: 0, max: 48 },
  interface: { type: String, trim: true, lowercase: true, default: 'gpio' },
  pins: { type: Schema.Types.Mixed, default: {} },
  address: { type: Schema.Types.Mixed },
  channel: { type: Schema.Types.Mixed },
  value: Schema.Types.Mixed,
  unit: { type: String, trim: true },
  config: { type: Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['normal', 'warning', 'error', 'unknown'], default: 'unknown' },
  // Transport/data freshness is separate from the value status above.
  // 'healthy' means telemetry for this sensor was received recently;
  // 'stale' means the device is alive but this sensor stopped reporting.
  healthStatus: { type: String, enum: ['healthy', 'stale', 'unknown', 'invalid', 'unverified'], default: 'unknown' },
  lastUpdated: Date,
}, { timestamps: true })

sensorSchema.index({ deviceId: 1, name: 1 }, { unique: true })
sensorSchema.index({ deviceId: 1, lastUpdated: -1 })

export const Sensor = model('Sensor', sensorSchema)

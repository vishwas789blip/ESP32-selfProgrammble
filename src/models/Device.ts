import { Schema, model } from 'mongoose'

const deviceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    // MQTT topic identity. This must be globally unique because incoming MQTT
    // packets contain only the deviceId, not the application userId.
    deviceId: { type: String, required: true, trim: true, index: true },
    description: { type: String, trim: true },
    status: { type: String, enum: ['online', 'offline'], default: 'offline' },
    connectionType: { type: String, enum: ['wifi', 'bluetooth', 'mqtt'], required: true },
    ipAddress: String,
    macAddress: String,
    firmwareVersion: String,
    lastSeen: Date,
    config: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
)

// Do not scope uniqueness by user: MQTT messages cannot safely be resolved to a
// user when two users have the same deviceId.
deviceSchema.index({ deviceId: 1 }, { unique: true })

deviceSchema.index({ userId: 1, createdAt: -1 })

deviceSchema.index({ status: 1, lastSeen: 1 })

export const Device = model('Device', deviceSchema)

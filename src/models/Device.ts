import { Schema, model } from 'mongoose'

const deviceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    // MQTT topic identity. This must be globally unique because incoming MQTT
    // packets contain only the deviceId, not the application userId.
    // The firmware DEVICE_ID, this field, the MQTT topic (devices/<deviceId>/...)
    // and the backend lookup must all be the exact same string.
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

    // ---- Config synchronisation (backend -> ESP32 -> CONFIG_ACK) ----------
    // Monotonic version, bumped only when the generated config content changes.
    configVersion: { type: Number, default: 0 },
    // sha256 of the generated config body (without version/hash fields).
    configHash: { type: String },
    // pending: published (or waiting to be published), device has not confirmed yet
    // acked:   device confirmed it applied exactly configVersion
    // failed:  device answered CONFIG_ACK with status=failed
    configStatus: { type: String, enum: ['pending', 'acked', 'failed'], default: 'pending' },
    lastConfigPublishedAt: Date,
    lastConfigAckVersion: { type: Number, default: 0 },
    lastConfigAckAt: Date,
    lastConfigError: String,
  },
  { timestamps: true },
)

// Do not scope uniqueness by user: MQTT messages cannot safely be resolved to a
// user when two users have the same deviceId.
deviceSchema.index({ deviceId: 1 }, { unique: true })

deviceSchema.index({ userId: 1, createdAt: -1 })

deviceSchema.index({ status: 1, lastSeen: 1 })

export const Device = model('Device', deviceSchema)
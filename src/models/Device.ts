import { Schema, model } from 'mongoose'

const deviceSchema = new Schema(
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

    deviceId: {
      type: String,
      required: true,
      trim: true,
    },

    description: String,

    status: {
      type: String,
      enum: ['online', 'offline'],
      default: 'offline',
    },

    connectionType: {
      type: String,
      enum: ['wifi', 'bluetooth', 'mqtt'],
      required: true,
    },

    ipAddress: String,
    macAddress: String,
    firmwareVersion: String,
    lastSeen: Date,

    // Arbitrary device-level settings pushed to the ESP32 over the MQTT
    // config topic (e.g. buzzerDuration). Sensor/actuator gpio wiring is
    // NOT stored here — it's always derived live from the Sensor/Actuator
    // collections so it can never go stale.
    config: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
)

// Same device ID allowed for different users,
// but not twice for the same user.
deviceSchema.index(
  { userId: 1, deviceId: 1 },
  { unique: true }
)

export const Device = model('Device', deviceSchema)
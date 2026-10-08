import { Schema, model } from 'mongoose'

const eventSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    deviceId: {
      type: Schema.Types.ObjectId,
      ref: 'Device',
      index: true,
    },
    type: {
      type: String,
      enum: ['sensor', 'actuator', 'automation', 'system'],
      required: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    metadata: Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

// TTL index: events older than 90 days are automatically removed.
eventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 })
eventSchema.index({ userId: 1, createdAt: -1 })

export const Event = model('Event', eventSchema)

import { Schema, model } from 'mongoose'
const eventSchema = new Schema({ userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true }, deviceId: { type: Schema.Types.ObjectId, ref: 'Device', index: true }, type: { type: String, enum: ['sensor','actuator','automation','system'], required: true }, message: { type: String, required: true, trim: true, maxlength: 500 }, metadata: Schema.Types.Mixed }, { timestamps: { createdAt: true, updatedAt: false } })
export const Event = model('Event', eventSchema)

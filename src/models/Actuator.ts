import { Schema, model } from 'mongoose'
const actuatorSchema = new Schema({ deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true, index: true }, name: { type: String, required: true, trim: true }, type: { type: String, required: true, trim: true }, gpio: { type: Number, min: 0, max: 39 }, state: { type: String, enum: ['on','off'], default: 'off' } }, { timestamps: true })
export const Actuator = model('Actuator', actuatorSchema)
